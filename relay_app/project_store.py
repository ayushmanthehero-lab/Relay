"""Versioned project plans around Relay's existing real execution work graph."""
from __future__ import annotations

import copy
import json
import time

from .core import Conflict
from .execution_store import CAPABILITIES, ExecutionStore
from .project_models import ProjectPlan
from .providers import ProviderError
from .recovery_queries import project_label
from .support_service import nonempty, stable


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class ProjectStore:
    def __init__(self, service):
        self.service = service

    def _project(self, project_id):
        rows = self.service.q('MATCH (p:Project {id:$id}) WHERE p.visibility="team" OR p.owner=$actor RETURN p',
                              id=project_id, actor=self.service.owner)
        if not rows:
            raise Conflict('Project is unavailable for this person or workspace.')
        return rows[0]['p']

    def _plan(self, project):
        rows = self.service.q('MATCH (p:Project {id:$id})-[:HAS_PLAN]->(v:ProjectPlan {id:$vid}) RETURN v',
                              id=project['id'], vid=project['current_plan_id'])
        if not rows:
            raise Conflict('The current project plan is unavailable.')
        return json.loads(rows[0]['v']['payload'])

    def list(self):
        rows = self.service.q('MATCH (p:Project) WHERE p.visibility="team" OR p.owner=$actor '
                              'RETURN p ORDER BY p.updated_at DESC LIMIT 101', actor=self.service.owner)
        if len(rows) > 100:
            raise Conflict('The project list exceeds its bounded limit.')
        projects = []
        for row in rows:
            project = row['p']
            case = self.service._case(project['case_id'])
            project['status'] = case.get('execution_status', 'awaiting_start_approval')
            projects.append(project)
        return dict(projects=projects, principal=self.service.principal,
                    capabilities=[dict(id=key, name=value, scope='General document drafting' if key == 'write_document'
                                       else 'Local email-and-consent signup prototype only') for key, value in CAPABILITIES.items()])

    def detail(self, project_id):
        project = self._project(project_id)
        plan = self._plan(project)
        execution = ExecutionStore(self.service).state(project['case_id'])
        case = execution['case']
        dependencies = self.service.q('MATCH (a:WorkItem {case_id:$cid})-[:DEPENDS_ON]->(b:WorkItem {case_id:$cid}) '
                                      'RETURN a.key AS source,b.key AS target', cid=case['id'])
        items = execution['items']
        current_outputs = {artifact['id'] for artifact in execution['artifacts'] if artifact.get('current')}
        for item in items:
            if item['execution_status'] == 'succeeded' and item.get('current_artifact_id') not in current_outputs:
                item['execution_status'] = 'stale'
        by_key = {item['key']: item for item in items}
        source_tasks = {task['id']: task for task in plan['tasks']}
        active = any(job['status'] in {'queued', 'running', 'paused', 'blocked'} for job in execution['jobs'])
        for item in items:
            task = source_tasks[item['key']]
            item['owner'] = task['owner']
            item['description'] = task['description']
            item['acceptance_criteria'] = task['acceptance_criteria']
            item['depends_on'] = task['depends_on']
            approved = (item.get('start_approval_id') and item.get('start_approved_generation') == case.get('execution_generation')
                        and item.get('start_approved_graph_revision') == case['project_revision']
                        and item.get('start_approved_memory_revision') == case.get('memory_revision', 0))
            item['start_approval_status'] = 'approved' if approved else 'required'
            reason = ('This task already has a current output.' if item['execution_status'] == 'succeeded'
                      else 'Another approved task is active.' if active
                      else 'The project is paused.' if case['workflow_status'] == 'paused'
                      else 'Prerequisite tasks need current successful outputs.' if any(
                          by_key[key]['execution_status'] != 'succeeded' or by_key[key].get('current_artifact_id') not in current_outputs
                          for key in task['depends_on']) else '')
            item['can_start'], item['blocked_reason'] = not bool(reason), reason
        for key, label, relation in [('messages', 'Message', 'HAS_MESSAGE'), ('approvals', 'ProjectStartApproval', 'HAS_START_APPROVAL')]:
            rows = self.service.q('MATCH (p:Project {id:$pid})-[:' + relation + ']->(n:' + label + ') '
                                  'RETURN n ORDER BY n.created_at LIMIT 500', pid=project_id)
            execution[key] = [r['n'] for r in rows]
        attempts = self.service.q('MATCH (p:Project {id:$pid})-[:HAS_PLAN]->(v:ProjectPlan) '
                                 'RETURN v.case_id AS case_id,v.project_revision AS revision,v.version AS plan_version,'
                                 'v.title AS title,v.created_at AS created_at ORDER BY v.version DESC LIMIT 100', pid=project_id)
        for attempt in attempts:
            attempt['current'] = attempt['case_id'] == case['id']
        project['status'] = execution['status']
        return dict(project=project, plan=plan, case=case, items=items, dependencies=dependencies,
                    execution=execution, messages=execution.pop('messages'), approvals=execution.pop('approvals'),
                    attempts=attempts, principal=self.service.principal,
                    notice='Each task needs explicit human start approval. Human completion approval remains separate.')

    def _receipt(self, project_id, kind, request_id, fingerprint):
        rid = stable('project_request', project_id, self.service.owner, kind, request_id)
        rows = self.service.q('MATCH (r:ProjectRequest {id:$id}) RETURN r', id=rid)
        if rows and rows[0]['r']['fingerprint'] != fingerprint:
            raise Conflict('Request ID already belongs to different project content.')
        return rid, rows[0]['r'] if rows else None

    def import_plan(self, plan, visibility, request_id):
        plan = ProjectPlan.model_validate(plan).model_dump()
        request_id = nonempty(request_id, 'Request ID', 100)
        if visibility not in {'team', 'private'}:
            raise ValueError('Visibility must be team or private.')
        origin = plan['provenance']
        pid = stable('project', self.service.owner, origin['source'], origin['source_tenant'], origin['source_plan_id'])
        fingerprint = stable('plan_content', plan, visibility)
        rid, receipt = self._receipt(pid, 'import', request_id, fingerprint)
        if receipt:
            return self.detail(pid)
        rows = self.service.q('MATCH (p:Project {id:$pid}) RETURN p', pid=pid)
        prior = self._project(pid) if rows else None
        if prior:
            if visibility != prior['visibility']:
                raise Conflict('Import cannot change project visibility.')
            if plan['version'] == prior['plan_version'] and encoded(plan) == encoded(self._plan(prior)):
                return self.detail(pid)
            if plan['version'] <= prior['plan_version']:
                raise Conflict('A changed plan requires a newer version; older versions remain history.')
        self._publish(pid, plan, visibility, prior, rid, fingerprint, 'import')
        return self.detail(pid)

    def _publish(self, pid, plan, visibility, prior, request_id, fingerprint, kind, prompt='', task_key=''):
        """One conditional write publishes the plan, graph and provenance together."""
        now, actor = time.time(), self.service.owner
        owner = prior['owner'] if prior else actor
        revision = (prior or {}).get('revision', 0) + 1
        vid = stable('project_plan', pid, plan['version'])
        cid = stable('recovery', pid, plan['version'])
        project = dict(prior or {}, id=pid, title=plan['title'], description=plan['description'],
                       owner=owner, visibility=visibility, revision=revision, plan_version=plan['version'],
                       case_id=cid, current_plan_id=vid, created_at=(prior or {}).get('created_at', now), updated_at=now,
                       source=plan['provenance']['source'], source_tenant=plan['provenance']['source_tenant'],
                       source_plan_id=plan['provenance']['source_plan_id'])
        case = dict(id=cid, kind='recovery', title=plan['title'], description=plan['description'], topic='project '+pid,
                    owner=owner, visibility=visibility, revision=1, project_revision=1, memory_revision=0,
                    project_id=pid, project_plan_version=plan['version'], project_start_required=True, project_superseded=False,
                    project_source=plan['provenance']['source'], project_source_tenant=plan['provenance']['source_tenant'],
                    project_source_plan_id=plan['provenance']['source_plan_id'],
                    project_source_version=plan['provenance']['source_version'], project_source_url=plan['provenance']['source_url'],
                    execution_profile='signup_prototype' if any(t['capability'] != 'write_document' for t in plan['tasks']) else 'documents',
                    workflow_status='ready', resolution_status='open', execution_status='awaiting_start_approval',
                    execution_enabled=False, execution_generation=0, phase='Project', latest_error='',
                    created_at=now, updated_at=now, session_count=1, current_session_id=stable('session', cid, 'initial'))
        scope = dict(case_id=cid, owner=owner, visibility=visibility, created_at=now)
        items, edges = [], []
        for task in plan['tasks']:
            assigned = task['owner']
            items.append(dict(scope, id=stable('workitem', cid, task['id']), key=task['id'], title=task['title'],
                              description=task['description'], acceptance_criteria_json=encoded(task['acceptance_criteria']),
                              status='pending', capability=task['capability'], execution_status='not_started',
                              assigned_company_person_id=assigned['company_person_id'], assigned_name=assigned['name'],
                              assigned_relay_person_id=assigned['relay_person_id'], assignment_source=plan['provenance']['source'],
                              assignment_source_tenant=plan['provenance']['source_tenant'], assignment_kind='declared_plan_owner'))
            edges += [dict(source=stable('workitem', cid, task['id']), target=stable('workitem', cid, dep)) for dep in task['depends_on']]
        caps = [dict(scope, id=stable('capability', cid, cap), key=cap, name=cap) for cap in sorted({t['capability'] for t in plan['tasks']})]
        requirements = [dict(wid=item['id'], cid=stable('capability', cid, item['capability'])) for item in items]
        version = dict(scope, id=vid, project_id=pid, version=plan['version'], project_revision=revision,
                       title=plan['title'], payload=encoded(plan), fingerprint=fingerprint, imported_by=actor, origin=kind,
                       source=plan['provenance']['source'], source_tenant=plan['provenance']['source_tenant'])
        session = self.service._session_props(case, case['current_session_id'], 'Project plan version '+str(plan['version']), actor, now)
        answer = ('Saved a new attempt for all tasks. Earlier outputs remain in project history. '
                  if prior else 'Imported the plan and its task dependencies. ') + 'Review each ready task and explicitly approve its start. No task has started.'
        messages = [dict(scope, id=request_id+'_user', role='user', actor=actor, author_name=self.service.principal['name'],
                         content=prompt, request_id=request_id, created_at=now)] if prompt else []
        messages.append(dict(scope, id=request_id+'_answer', role='assistant', provider='relay_project_graph', content=answer,
                             request_id=request_id, created_at=now+.001))
        receipt = dict(id=request_id, project_id=pid, actor=actor, fingerprint=fingerprint, kind=kind, case_id=cid, created_at=now)
        query = ('OPTIONAL MATCH (old:Project {id:$pid}) WITH old WHERE '
                 '($expected=0 AND old IS NULL) OR old.revision=$expected '
                 'MERGE (p:Project {id:$pid}) SET p=$project '
                 'CREATE (v:ProjectPlan) SET v=$version CREATE (c:Case) SET c=$case '
                 'CREATE (s:WorkSession) SET s=$session CREATE (request:ProjectRequest) SET request=$receipt '
                 'MERGE (p)-[:HAS_PLAN]->(v) MERGE (v)-[:IMPLEMENTED_AS]->(c) MERGE (p)-[:HAS_CASE]->(c) '
                 'MERGE (c)-[:HAS_SESSION]->(s) MERGE (p)-[:HAS_REQUEST]->(request) '
                 'FOREACH (item IN $items | CREATE (w:WorkItem:' + project_label(cid) + ') SET w=item MERGE (c)-[:HAS_ITEM]->(w)) '
                 'FOREACH (cap IN $caps | CREATE (capability:Capability) SET capability=cap MERGE (c)-[:HAS_CAPABILITY]->(capability)) '
                 'FOREACH (message IN $messages | CREATE (m:Message) SET m=message MERGE (p)-[:HAS_MESSAGE]->(m) MERGE (c)-[:HAS_MESSAGE]->(m)) '
                 'WITH p,c UNWIND $requirements AS req MATCH (w:WorkItem {id:req.wid}),(cap:Capability {id:req.cid}) '
                 'MERGE (w)-[:REQUIRES_CAPABILITY]->(cap) WITH DISTINCT p,c '
                 'FOREACH (edge IN $edges | MERGE (a:WorkItem {id:edge.source}) MERGE (b:WorkItem {id:edge.target}) MERGE (a)-[:DEPENDS_ON {weight:1}]->(b)) '
                 'WITH p,c OPTIONAL MATCH (previous:Case {id:$previous_case}) '
                 'SET previous.project_superseded=true,previous.execution_enabled=false,previous.workflow_status="paused",previous.revision=previous.revision+1 '
                 'WITH p,c,previous OPTIONAL MATCH (previous)-[:HAS_JOB]->(job:Job) WHERE job.status IN ["queued","running","paused","blocked"] '
                 'SET job.status="superseded",job.token="",job.lease_until=0 '
                 'WITH DISTINCT p,c,previous OPTIONAL MATCH (previous)-[:HAS_EXECUTION_ARTIFACT]->(artifact:ExecutionArtifact) SET artifact.current=false '
                 'WITH DISTINCT p,c,previous OPTIONAL MATCH (previous)-[:HAS_MEMORY]->(memory:Memory) SET memory.current=false '
                 'WITH DISTINCT p,c,previous OPTIONAL MATCH (previous)-[:HAS_EPISODE]->(episode:Episode) '
                 'SET episode.knowledge_current=false,episode.index_status="superseded",episode.index_token="",episode.index_lease_until=0 '
                 'WITH DISTINCT p,c MATCH (gate:Gate {id:"memory"}) SET gate.epoch=gate.epoch+1 RETURN p')
        rows = self.service.q(query, pid=pid, expected=(prior or {}).get('revision', 0), project=project, version=version,
                              case=case, session=session, receipt=receipt, items=items, caps=caps, requirements=requirements,
                              edges=edges, messages=messages, previous_case=(prior or {}).get('case_id', ''))
        if not rows:
            raise Conflict('The project changed while publishing the plan. Refresh before retrying.')

    def start(self, project_id, task_id, expected_revision, plan_version, approved, request_id):
        if approved is not True:
            raise ValueError('Explicit human approval is required before starting this task.')
        request_id = nonempty(request_id, 'Request ID', 100)
        project = self._project(project_id)
        fingerprint = stable('project_start', task_id, expected_revision, plan_version, approved)
        rid, prior = self._receipt(project_id, 'start', request_id, fingerprint)
        if prior:
            if (prior['case_id'] == project['case_id']
                    and self.service._case(project['case_id']).get('project_start_request_id') == request_id):
                ExecutionStore(self.service).start(project['case_id'], request_id)
            return self.detail(project_id)
        if project['revision'] != expected_revision or project['plan_version'] != plan_version:
            raise Conflict('Project or plan version changed. Review the current task before approving.')
        if self.service.cfg.model_provider == 'demo':
            raise ProviderError('Real task execution requires Codex, API, or Ollama. No demonstration output is fabricated.')
        packet = self.detail(project_id)
        task = next((item for item in packet['items'] if item['key'] == task_id), None)
        if not task:
            raise ValueError('Select a task ID from the current plan.')
        if not task['can_start']:
            raise Conflict(task['blocked_reason'])
        case, now = packet['case'], time.time()
        generation = case.get('execution_generation', 0) or 1
        if not case.get('execution_enabled') or case.get('execution_graph_revision') != case['project_revision'] or case.get('execution_memory_revision', 0) != case.get('memory_revision', 0):
            generation = case.get('execution_generation', 0) + 1
        approval = dict(id=stable('project_start_approval', rid), project_id=project_id, case_id=case['id'],
                        task_key=task_id, work_item_id=task['id'], actor=self.service.owner, author_kind='human',
                        decision='approve_start', plan_version=plan_version, project_revision=case['project_revision'],
                        memory_revision=case.get('memory_revision', 0), execution_generation=generation,
                        owner=case['owner'], visibility=case['visibility'], created_at=now)
        receipt = dict(id=rid, project_id=project_id, actor=self.service.owner, kind='start', fingerprint=fingerprint,
                       case_id=case['id'], created_at=now, approval_id=approval['id'])
        rows = self.service.q('MATCH (p:Project {id:$pid,revision:$revision}),(c:Case {id:$cid,revision:$case_revision}),'
                              '(w:WorkItem {id:$wid,case_id:$cid}) WHERE c.project_superseded=false '
                              'CREATE (a:ProjectStartApproval) SET a=$approval CREATE (r:ProjectRequest) SET r=$receipt '
                              'MERGE (p)-[:HAS_START_APPROVAL]->(a) MERGE (c)-[:HAS_START_APPROVAL]->(a) MERGE (a)-[:AUTHORIZES]->(w) '
                              'MERGE (p)-[:HAS_REQUEST]->(r) SET w.start_approval_id=a.id,w.start_approved_generation=$generation,'
                              'w.start_approved_graph_revision=c.project_revision,w.start_approved_memory_revision=c.memory_revision,'
                              'c.project_start_request_id=$request_id,c.revision=c.revision+1,p.revision=p.revision+1,p.updated_at=$now RETURN p',
                              pid=project_id, revision=expected_revision, cid=case['id'], case_revision=case['revision'], wid=task['id'],
                              approval=approval, receipt=receipt, generation=generation, request_id=request_id, now=now)
        if not rows:
            raise Conflict('The project changed before task approval was recorded. Refresh and retry.')
        ExecutionStore(self.service).start(case['id'], request_id)
        return self.detail(project_id)

    def revise(self, project_id, task_id, prompt, expected_revision, request_id):
        prompt = nonempty(prompt, 'Revision prompt', 3000)
        request_id = nonempty(request_id, 'Request ID', 100)
        project = self._project(project_id)
        fingerprint = stable('project_revision', task_id, prompt, expected_revision)
        rid, prior = self._receipt(project_id, 'revise', request_id, fingerprint)
        if prior:
            return self.detail(project_id)
        if project['revision'] != expected_revision:
            raise Conflict('Project revision changed. Refresh before requesting a new attempt.')
        plan = copy.deepcopy(self._plan(project))
        task = next((task for task in plan['tasks'] if task['id'] == task_id), None)
        if not task:
            raise ValueError('Select a task ID from the current plan.')
        task['description'] += '\n\nHuman revision request: '+prompt
        plan['version'] += 1
        # Preserve original external provenance; this is a local revision of that plan.
        plan = ProjectPlan.model_validate(plan).model_dump()
        self._publish(project_id, plan, project['visibility'], project, rid, fingerprint, 'revision', prompt, task_id)
        return self.detail(project_id)

    def chat(self, project_id, message, request_id, mode='status', task_id='', expected_revision=None):
        message = nonempty(message, 'Message', 3000)
        request_id = nonempty(request_id, 'Request ID', 100)
        if mode == 'revise':
            if expected_revision is None or not task_id:
                raise ValueError('Revision chat requires a selected task and current project revision.')
            result = self.revise(project_id, task_id, message, expected_revision, request_id)
            return dict(result, answer='Saved a new project attempt. All tasks require fresh start approval; previous outputs remain in history.')
        if mode != 'status':
            raise ValueError('Choose status or revise mode.')
        packet = self.detail(project_id)
        fingerprint = stable('project_chat', message)
        rid, prior = self._receipt(project_id, 'chat', request_id, fingerprint)
        if prior:
            answer = next((m['content'] for m in packet['messages'] if m['id'] == rid+'_answer'), '')
            return dict(packet, answer=answer)
        lines = [packet['project']['title']+' — plan version '+str(packet['plan']['version'])+'.']
        for item in packet['items']:
            lines.append(item['title']+': '+item['execution_status'].replace('_', ' ')+'. Human completion approval: '+item['approval_status']+'.')
        lines += ['Explicit approval is required for each ready task before an agent starts.',
                  'Use the selected task revision action to request changes. Chat text alone never starts work.']
        answer, now, case = '\n'.join(lines), time.time(), packet['case']
        scope = dict(case_id=case['id'], owner=case['owner'], visibility=case['visibility'], request_id=rid)
        user = dict(scope, id=rid+'_user', role='user', actor=self.service.owner, author_name=self.service.principal['name'],
                    content=message, created_at=now)
        assistant = dict(scope, id=rid+'_answer', role='assistant', provider='relay_project_graph', content=answer, created_at=now+.001)
        receipt = dict(id=rid, project_id=project_id, actor=self.service.owner, fingerprint=fingerprint, kind='chat', created_at=now)
        rows = self.service.q('MATCH (p:Project {id:$pid,revision:$revision}),(c:Case {id:$cid,revision:$case_revision}) '
                              'OPTIONAL MATCH (existing:ProjectRequest {id:$rid}) WITH p,c,existing WHERE existing IS NULL '
                              'CREATE (r:ProjectRequest) SET r=$receipt CREATE (u:Message) SET u=$user CREATE (a:Message) SET a=$assistant '
                              'MERGE (p)-[:HAS_REQUEST]->(r) MERGE (p)-[:HAS_MESSAGE]->(u) MERGE (p)-[:HAS_MESSAGE]->(a) '
                              'MERGE (c)-[:HAS_MESSAGE]->(u) MERGE (c)-[:HAS_MESSAGE]->(a) SET c.revision=c.revision+1,c.updated_at=$now RETURN r',
                              pid=project_id, revision=packet['project']['revision'], cid=case['id'], case_revision=case['revision'],
                              rid=rid, receipt=receipt, user=user, assistant=assistant, now=now)
        if not rows:
            raise Conflict('Project changed while reading its status. Refresh and retry.')
        return dict(self.detail(project_id), answer=answer)
