"""FalkorDB-authoritative executable work, outputs and dependency scheduling."""
from __future__ import annotations

import json
import time
from .core import Conflict
from .providers import ProviderError
from .support_service import ACCESS, nonempty, stable

CAPABILITIES = {
    'write_document': 'Writer', 'design_contract': 'Contract Designer',
    'build_page': 'Builder', 'test_page': 'Tester', 'package_release': 'Release Manager',
}
WEBSITE = {
    'security-review': ('write_document', 'Write privacy and consent requirements'),
    'api-contract': ('design_contract', 'Define the signup data contract'),
    'integration': ('build_page', 'Build the working signup page'),
    'qa': ('test_page', 'Test the signup journey in a browser'),
    'docs': ('write_document', 'Write the launch checklist'),
    'launch': ('package_release', 'Package the tested local website'),
}
JSON_FIELDS = ('files', 'checks', 'input_artifact_ids', 'memory_versions', 'knowledge_facts', 'input_paths', 'source_episode_ids')


def decode(record):
    result = dict(record)
    for key in JSON_FIELDS:
        if isinstance(result.get(key), str):
            result[key] = json.loads(result[key])
    return result


class ExecutionStore:
    def __init__(self, service):
        self.service = service

    def _case(self, case_id):
        case = self.service._case(case_id)
        if case.get('kind') != 'recovery':
            raise Conflict('Task execution requires a project graph.')
        return case

    def state(self, case_id):
        case = self._case(case_id)
        items = [r['w'] for r in self.service.q(
            'MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem) RETURN w ORDER BY w.key', cid=case_id)]
        for item in items:
            item.setdefault('execution_status', 'not_started')
            item.update(task_id=item.get('execution_task_id', ''), artifact_id=item.get('current_artifact_id', ''),
                        agent=item.get('execution_agent', ''))
            item['approval_status'] = 'approved' if item.get('approval_id') and item['status'] == 'done' else 'reported_complete' if item['status'] == 'done' else 'open'
        result = dict(enabled=bool(case.get('execution_enabled')), case=case, items=items,
                      status='paused' if case['workflow_status'] == 'paused' else case.get('execution_status', 'not_started'),
                      blocked_reason=case.get('execution_error', ''))
        for label, key in [('Job', 'jobs'), ('ExecutionArtifact', 'artifacts'), ('Handoff', 'handoffs')]:
            rows = self.service.q('MATCH (c:Case {id:$cid})-[]->(n:' + label + ') '
                'WHERE ' + ('n.kind="execution"' if label != 'ExecutionArtifact' else 'true') +
                ' RETURN n ORDER BY n.created_at LIMIT 500', cid=case_id)
            result[key] = [decode(r['n']) for r in rows]
        for artifact in result['artifacts']:
            artifact['files'] = [{k: v for k, v in f.items() if k != 'content'} for f in artifact['files']]
            artifact['current'] = self.is_current(case, artifact)
        return result

    def artifact(self, case_id, artifact_id):
        self._case(case_id)
        rows = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_EXECUTION_ARTIFACT]->'
            '(a:ExecutionArtifact {id:$aid,case_id:$cid}) WHERE ' + ACCESS + ' RETURN a',
            cid=case_id, aid=artifact_id, actor=self.service.owner)
        if not rows:
            raise Conflict('Output is unavailable in this project.')
        return decode(rows[0]['a'])

    def is_current(self, case, artifact, seen=None):
        if (not artifact.get('current') or not artifact.get('passed')
                or artifact.get('graph_revision') != case['project_revision']
                or artifact.get('memory_revision') != case.get('memory_revision', 0)):
            return False
        seen = set() if seen is None else seen
        if artifact['id'] in seen:
            return True
        seen.add(artifact['id'])
        versions = artifact.get('memory_versions', [])
        rows = self.service.q('MATCH (m:Memory) WHERE m.id IN $ids AND '
            '(m.current=true OR m.invalidated_reason="completion_approval") '
            'AND (m.visibility="team" OR ($private AND m.owner=$owner)) RETURN m.id AS id,m.revision AS revision',
            ids=[v['id'] for v in versions], private=case['visibility'] == 'private', owner=case['owner'])
        current = {r['id']: r['revision'] for r in rows}
        if any(current.get(v['id']) != v['revision'] for v in versions):
            return False
        source_ids = artifact.get('source_episode_ids', [])
        rows = self.service.q('MATCH (e:Episode) WHERE e.id IN $ids AND '
            '(coalesce(e.knowledge_current,true)=true OR e.invalidated_reason="completion_approval") '
            'AND (e.visibility="team" OR ($private AND e.owner=$owner)) RETURN e.id AS id',
            ids=source_ids, private=case['visibility'] == 'private', owner=case['owner'])
        if {r['id'] for r in rows} != set(source_ids):
            return False
        return all(self.is_current(case, self.artifact(case['id'], aid), seen)
                   for aid in artifact.get('input_artifact_ids', []))

    def _provision(self, case):
        """Upgrade only the recognized six-item built-in example; preserve all history."""
        items = [r['w'] for r in self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem) RETURN w', cid=case['id'])]
        built_in = (set(w['key'] for w in items) == set(WEBSITE)
                    and (case.get('demo_dataset') == 'website-launch-v1' or 'website' in case['title'].lower())
                    and all(w.get('capability') == 'dependency_analysis' for w in items))
        if built_in:
            upgrades = [dict(id=item['id'], cap=WEBSITE[item['key']][0], title=WEBSITE[item['key']][1],
                pid=stable('capability', case['id'], WEBSITE[item['key']][0])) for item in items]
            self.service.q('MATCH (c:Case {id:$cid,revision:$revision}) UNWIND $upgrades AS upgrade '
                    'MATCH (c)-[:HAS_ITEM]->(w:WorkItem {id:upgrade.id}) '
                    'OPTIONAL MATCH (w)-[old:REQUIRES_CAPABILITY]->(:Capability) DELETE old '
                    'SET w.capability=upgrade.cap,w.title=upgrade.title '
                    'MERGE (p:Capability {id:upgrade.pid}) ON CREATE SET p.name=upgrade.cap,p.key=upgrade.cap,p.case_id=$cid,'
                    'p.owner=c.owner,p.visibility=c.visibility,p.created_at=$now '
                    'MERGE (c)-[:HAS_CAPABILITY]->(p) MERGE (w)-[:REQUIRES_CAPABILITY]->(p) '
                    'WITH DISTINCT c SET c.revision=c.revision+1,c.project_revision=c.project_revision+1 '
                    'WITH c OPTIONAL MATCH (c)-[:HAS_MEMORY]->(m:Memory) WHERE m.recovery_kind IN ["graph_observation","coordination","coverage_review"] '
                    'SET m.current=false WITH DISTINCT c OPTIONAL MATCH (c)-[:HAS_EPISODE]->(e:Episode) '
                    'WHERE e.recovery_kind IN ["graph_observation","coordination","coverage_review"] '
                    'SET e.knowledge_current=false,e.index_status="superseded",e.index_token="",e.index_lease_until=0 RETURN DISTINCT c',
                    cid=case['id'], revision=case['revision'], upgrades=upgrades, now=time.time())
        for capability, role in CAPABILITIES.items():
            self.service.q('MATCH (c:Case {id:$cid}) '
                'MERGE (a:Agent {id:$aid}) ON CREATE SET a.name=$role,a.role=$role,a.status="available",'
                'a.case_id=$cid,a.owner=c.owner,a.visibility=c.visibility,a.created_at=$now '
                'MERGE (p:Capability {id:$pid}) ON CREATE SET p.name=$cap,p.key=$cap,p.case_id=$cid,'
                'p.owner=c.owner,p.visibility=c.visibility,p.created_at=$now '
                'MERGE (c)-[:HAS_AGENT]->(a) MERGE (c)-[:HAS_CAPABILITY]->(p) '
                'MERGE (a)-[:HAS_CAPABILITY]->(p) RETURN a', cid=case['id'],
                aid=stable('agent', case['id'], role), pid=stable('capability', case['id'], capability),
                role=role, cap=capability, now=time.time())

    def start(self, case_id, request_id):
        request_id = nonempty(request_id, 'Request ID', 100)
        case = self._case(case_id)
        if case.get('project_superseded'):
            raise Conflict('This is a historical project attempt. Approve a task in the current project plan.')
        if case.get('project_start_required'):
            if case.get('project_start_request_id') != request_id:
                raise Conflict('Approve the selected task through Projects before starting execution.')
            generation = case.get('execution_generation', 0)
            if (not case.get('execution_enabled') or case.get('execution_graph_revision') != case['project_revision']
                    or case.get('execution_memory_revision', 0) != case.get('memory_revision', 0)):
                generation += 1
            approvals = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem) '
                'WHERE w.start_approval_id<>"" AND w.start_approved_generation=$generation '
                'AND w.start_approved_graph_revision=c.project_revision AND w.start_approved_memory_revision=c.memory_revision '
                'RETURN w.id LIMIT 1', cid=case_id, generation=generation)
            if not approvals:
                raise Conflict('The task start approval is no longer current. Review and approve the task again.')
        if self.service.cfg.model_provider == 'demo':
            raise ProviderError('Run tasks requires Codex, API, or Ollama. The walkthrough does not fabricate task outputs.')
        if case['resolution_status'] != 'open':
            raise Conflict('Reopen the project before running tasks.')
        prior_outputs = [decode(r['a']) for r in self.service.q('MATCH (c:Case {id:$cid})-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact {current:true}) RETURN a', cid=case_id)]
        fresh = (case.get('execution_graph_revision') == case['project_revision']
                 and case.get('execution_memory_revision', 0) == case.get('memory_revision', 0)
                 and all(self.is_current(case, a) for a in prior_outputs))
        if case.get('execution_enabled') and fresh:
            if case.get('execution_request_id') == request_id:
                if case['workflow_status'] not in {'paused', 'error'}:
                    self.schedule(case_id)
                return self.state(case_id)
            if case['workflow_status'] in {'paused', 'error'}:
                self.service.resume(case_id)
                self.service.q('MATCH (c:Case {id:$cid}) SET c.execution_status="running",c.execution_error="",'
                    'c.execution_request_id=$request_id RETURN c', cid=case_id, request_id=request_id)
            self.schedule(case_id)
            return self.state(case_id)
        if case.get('execution_enabled') and not fresh:
            # A restart fences obsolete in-flight leases and leaves their history intact.
            self.service.q('MATCH (c:Case {id:$cid}) OPTIONAL MATCH (c)-[:HAS_JOB]->(j:Job {kind:"execution"}) '
                'WHERE j.status IN ["queued","running","paused","blocked"] '
                'SET j.status="superseded",j.token="",j.lease_until=0 '
                'WITH DISTINCT c OPTIONAL MATCH (c)-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact) SET a.current=false '
                'WITH DISTINCT c OPTIONAL MATCH (c)-[:HAS_MEMORY]->(m:Memory) WHERE m.execution_artifact_id IS NOT NULL '
                'SET m.current=false,m.invalidated_reason="execution_restart" '
                'WITH DISTINCT c OPTIONAL MATCH (c)-[:HAS_EPISODE]->(e:Episode) WHERE e.execution_artifact_id IS NOT NULL '
                'SET e.knowledge_current=false,e.index_status="superseded",e.index_token="",e.index_lease_until=0 '
                'WITH DISTINCT c SET c.workflow_status="ready",c.revision=c.revision+1 RETURN c', cid=case_id)
            case = self._case(case_id)
        active = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_JOB]->(j:Job) '
            'WHERE j.status IN ["queued","running","paused","blocked"] RETURN j.id', cid=case_id)
        if active:
            raise Conflict('Finish or resume the current agent work before starting task execution.')
        self._provision(case)
        case = self._case(case_id)
        now = time.time()
        generation = case.get('execution_generation', 0) + 1
        run_id = stable('execution_run', case_id, self.service.owner, request_id, case['project_revision'], case['memory_revision'], generation)
        rows = self.service.q('MATCH (c:Case {id:$cid,revision:$revision}) WHERE ' + ACCESS +
            ' AND c.workflow_status<>"paused" '
            'MERGE (r:ExecutionRun {id:$rid}) ON CREATE SET r.case_id=c.id,r.owner=c.owner,r.visibility=c.visibility,'
            'r.created_at=$now,r.graph_revision=c.project_revision,r.status="running" '
            'MERGE (c)-[:HAS_EXECUTION_RUN]->(r) '
            'SET c.execution_enabled=true,c.execution_run_id=r.id,c.execution_request_id=$request_id,c.execution_graph_revision=c.project_revision,'
            'c.execution_memory_revision=c.memory_revision,c.execution_generation=$generation,'
            'c.execution_status="running",c.execution_error="",c.workflow_status="ready",c.revision=c.revision+1,c.updated_at=$now '
            'WITH c MATCH (c)-[:HAS_ITEM]->(w:WorkItem) '
            'SET w.execution_status="pending",w.execution_error="",w.current_artifact_id="",w.execution_graph_revision=0,'
            'w.status="pending",w.approval_id="",w.approval_output_artifact_id="",w.completion_basis="pending_agent_execution" '
            'RETURN DISTINCT c', cid=case_id, revision=case['revision'], actor=self.service.owner, rid=run_id, request_id=request_id, generation=generation, now=now)
        if not rows:
            raise Conflict('Project changed while starting execution. Refresh and retry.')
        self.schedule(case_id)
        return self.state(case_id)

    def reconcile(self, case_id=None):
        rows = self.service.q('MATCH (c:Case) WHERE ' + ACCESS +
            ' AND c.execution_enabled=true AND c.execution_status IN ["running","queued"] '
            'AND c.workflow_status<>"paused" AND ($cid="" OR c.id=$cid) RETURN c.id AS id LIMIT 20',
            actor=self.service.owner, cid=case_id or '')
        for row in rows:
            self.schedule(row['id'])

    def schedule(self, case_id):
        case = self._case(case_id)
        if (not case.get('execution_enabled') or case['workflow_status'] == 'paused'
                or case['resolution_status'] != 'open' or case.get('project_superseded')):
            return
        if (case.get('execution_graph_revision') != case['project_revision']
                or case.get('execution_memory_revision', 0) != case.get('memory_revision', 0)):
            self._blocked(case_id, 'Project prerequisites changed. Start a new execution against the current graph.')
            return
        if self.service.q('MATCH (c:Case {id:$cid})-[:HAS_JOB]->(j:Job) '
            'WHERE j.status IN ["queued","running","paused","blocked"] RETURN j.id LIMIT 1', cid=case_id):
            return
        outputs = [decode(r['a']) for r in self.service.q('MATCH (c:Case {id:$cid})-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact {current:true}) RETURN a', cid=case_id)]
        if any(not self.is_current(case, a) for a in outputs):
            self._blocked(case_id, 'Saved output evidence changed. Run tasks again to rebuild from current memory and prerequisites.')
            return
        unsupported = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem) '
            'WHERE NOT w.capability IN $supported RETURN w.title AS title,w.capability AS capability',
            cid=case_id, supported=list(CAPABILITIES))
        if unsupported:
            self._blocked(case_id, 'No execution tool is configured for: ' + ', '.join(r['title'] + ' (' + r['capability'] + ')' for r in unsupported))
            return
        # This variable-length traversal is the actual readiness decision. The model
        # cannot select a task, agent, or input that this graph has not made eligible.
        rows = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem),'
            '(w)-[:REQUIRES_CAPABILITY]->(cap:Capability)<-[:HAS_CAPABILITY]-(agent:Agent {case_id:$cid,status:"available"}) '
            'WHERE coalesce(w.execution_status,"")<>"succeeded" AND cap.name IN $supported '
            'AND (coalesce(c.project_start_required,false)=false OR '
            '(w.start_approval_id<>"" AND w.start_approved_generation=c.execution_generation '
            'AND w.start_approved_graph_revision=c.project_revision AND w.start_approved_memory_revision=c.memory_revision)) '
            'OPTIONAL MATCH (w)-[:DEPENDS_ON*1..40]->(dependency:WorkItem {case_id:$cid}) '
            'WITH c,w,agent,collect(DISTINCT dependency) AS prerequisites '
            'WHERE ALL(d IN prerequisites WHERE d.execution_status="succeeded" AND d.execution_graph_revision=c.project_revision AND d.current_artifact_id<>"") '
            'RETURN w,agent,size(prerequisites) AS distance,[d IN prerequisites | d.current_artifact_id] AS input_ids,'
            '[] AS paths ORDER BY distance,w.key,agent.name LIMIT 1',
            cid=case_id, supported=list(CAPABILITIES))
        if not rows:
            remaining = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem) '
                'WHERE coalesce(w.execution_status,"")<>"succeeded" RETURN w.id', cid=case_id)
            if remaining:
                if case.get('project_start_required'):
                    self.service.q('MATCH (c:Case {id:$cid}) SET c.execution_status="awaiting_start_approval",'
                        'c.workflow_status="ready",c.execution_error="Approve the next ready task to begin its work.",'
                        'c.updated_at=$now RETURN c', cid=case_id, now=time.time())
                else:
                    self._blocked(case_id, 'No graph-ready assignment is available. Check failed prerequisites and agent capabilities.')
            else:
                self.service.q('MATCH (c:Case {id:$cid}) SET c.execution_status="awaiting_approval",'
                    'c.workflow_status="ready",c.execution_error="",c.updated_at=$now RETURN c', cid=case_id, now=time.time())
            return
        selected = rows[0]
        item, agent, now = selected['w'], selected['agent'], time.time()
        job_id = stable('execution_job', case['execution_run_id'], item['id'], case['project_revision'])
        task_id = job_id + '_task'
        scope = dict(case_id=case_id, owner=case['owner'], visibility=case['visibility'], created_at=now)
        job = dict(scope, id=job_id, kind='execution', agent=agent['role'], agent_id=agent['id'], stage=selected['distance'],
            work_item_id=item['id'], work_item_key=item['key'], capability=item['capability'], task_id=task_id,
            run_id=case['execution_run_id'], status='queued', lease_until=0, retry_at=0, attempts=0, error='',
            project_revision=case['project_revision'], input_artifact_ids=json.dumps(selected['input_ids']), input_paths=json.dumps(selected['paths']))
        if case.get('project_start_required'):
            job['start_approval_id'] = item['start_approval_id']
        task = dict(scope, id=task_id, title=item['title'], description='Perform the work and validate the saved output. Human completion is reviewed separately.',
            agent=agent['role'], task_kind='execution_work', work_item_id=item['id'], position=100 + selected['distance'],
            status='todo', revision=1, evidence='', completion_basis='pending_agent_execution', graph_revision=case['project_revision'])
        handoffs = []
        for aid in selected['input_ids']:
            source = self.artifact(case_id, aid)
            handoffs.append(dict(scope, id=stable('execution_handoff', aid, job_id), kind='execution',
                from_agent=source['agent'], to_agent=agent['role'], from_job_id=source['job_id'], to_job_id=job_id,
                artifact_id=aid, session_id=source['session_id'], status='pending', graph_revision=case['project_revision']))
        self.service.q('MATCH (c:Case {id:$cid,revision:$revision}),'
            '(w:WorkItem {id:$wid,case_id:$cid}),(agent:Agent {id:$aid,case_id:$cid}) '
            'WHERE c.workflow_status<>"paused" AND coalesce(c.project_superseded,false)=false '
            'AND (coalesce(c.project_start_required,false)=false OR '
            '(w.start_approval_id<>"" AND w.start_approved_generation=c.execution_generation '
            'AND w.start_approved_graph_revision=c.project_revision AND w.start_approved_memory_revision=c.memory_revision)) '
            'OPTIONAL MATCH (c)-[:HAS_JOB]->(active:Job) WHERE active.status IN ["queued","running","paused","blocked"] '
            'WITH c,w,agent,count(active) AS active_count WHERE active_count=0 '
            'MERGE (j:Job {id:$jid}) ON CREATE SET j=$job '
            'MERGE (t:Task {id:$tid}) ON CREATE SET t=$task '
            'MERGE (c)-[:HAS_JOB]->(j) MERGE (c)-[:HAS_TASK]->(t) MERGE (j)-[:EXECUTES]->(t) '
            'MERGE (t)-[:IMPLEMENTS]->(w) MERGE (agent)-[:ASSIGNED]->(t) '
            'FOREACH (h IN $handoffs | MERGE (handoff:Handoff {id:h.id}) ON CREATE SET handoff=h MERGE (c)-[:HAS_HANDOFF]->(handoff)) '
            'SET w.execution_status="queued",w.execution_task_id=$tid,w.execution_agent=agent.role,'
            'c.execution_status="running",c.workflow_status="queued",c.revision=c.revision+1,c.updated_at=$now '
            'WITH c,j OPTIONAL MATCH (c)-[:HAS_HANDOFF]->(h:Handoff {to_job_id:$jid}) '
            'OPTIONAL MATCH (output:ExecutionArtifact {id:h.artifact_id,case_id:$cid}) '
            'OPTIONAL MATCH (prior:Job {id:h.from_job_id,case_id:$cid}) '
            'FOREACH (_ IN CASE WHEN h IS NULL THEN [] ELSE [1] END | MERGE (h)-[:CARRIES]->(output) MERGE (prior)-[:HANDOFF_TO]->(j)) RETURN DISTINCT j',
            cid=case_id, revision=case['revision'], wid=item['id'], aid=agent['id'], jid=job_id, job=job,
            tid=task_id, task=task, handoffs=handoffs, now=now)

    def _blocked(self, case_id, reason):
        self.service.q('MATCH (c:Case {id:$cid}) SET c.execution_status="blocked",c.execution_error=$reason,'
            'c.workflow_status="error",c.latest_error=$reason RETURN c', cid=case_id, reason=reason)

    def inputs(self, job):
        """Resolve exact graph-selected output versions, never arbitrary filesystem paths."""
        ids = decode(job).get('input_artifact_ids', [])
        artifacts = [self.artifact(job['case_id'], aid) for aid in ids]
        if any(not self.is_current(job['case'], a) for a in artifacts):
            raise Conflict('A prerequisite output changed before execution.')
        return artifacts

    def decide(self, case_id, task_id, review_id, decision, expected_revision, reason, request_id):
        """Human acceptance binds the exact output version, not unrelated later work."""
        from .support_flow import unpack_review
        case, task = self.service._task_record(case_id, task_id)
        epoch = self.service.epoch()
        did = stable('decision', case_id, self.service.owner, request_id)
        fingerprint = stable('decision_request', task_id, review_id, decision, expected_revision, reason)
        prior = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_DECISION]->(d:TaskDecision {id:$did}) RETURN d', cid=case_id, did=did)
        if prior:
            if prior[0]['d']['request_fingerprint'] != fingerprint:
                raise Conflict('Decision request ID already has different content.')
            return json.loads(prior[0]['d']['response_snapshot'])
        rows = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_REVIEW]->(r:TaskReview {id:$rid,task_id:$tid}) RETURN r', cid=case_id, rid=review_id, tid=task_id)
        if not rows or task['revision'] != expected_revision or not self.service._review_current(rows[0]['r'], case, task):
            raise Conflict('The reviewed output changed. Request a current review before deciding.')
        review, now = unpack_review(rows[0]['r']), time.time()
        task_result = dict(task, status='done' if decision == 'approve' else 'doing', revision=expected_revision + 1,
            completion_basis='reviewed_approval' if decision == 'approve' else 'reported',
            approval_id=did if decision == 'approve' else '', updated_at=now, updated_by=self.service.owner)
        props = dict(id=did, case_id=case_id, task_id=task_id, review_id=review_id, owner=case['owner'], visibility=case['visibility'],
            actor=self.service.owner, decision=decision, reason=reason, created_at=now, request_fingerprint=fingerprint,
            overrides_recommendation=decision == 'approve' and review['verdict'] != 'ready', task_revision=expected_revision,
            output_artifact_id=task['output_artifact_id'])
        response = dict(task=task_result, review=dict(review, status='decided', decision_id=did, review_current=False), decision=props)
        change = dict(id=did + '_item', case_id=case_id, owner=case['owner'], visibility=case['visibility'],
            actor=self.service.owner, status='done' if decision == 'approve' else 'pending', reason=reason,
            created_at=now, approval_id=did, output_artifact_id=task['output_artifact_id'])
        saved = dict(props, response_snapshot=json.dumps(response))
        rows = self.service.q('MATCH (g:Gate {id:"memory"}),(c:Case {id:$cid,revision:$case_revision})-[:HAS_TASK]->'
            '(t:Task {id:$tid,revision:$revision,current_review_id:$rid})-[:IMPLEMENTS]->(w:WorkItem),'
            '(c)-[:HAS_REVIEW]->(r:TaskReview {id:$rid,status:"pending"}),'
            '(c)-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact {id:$aid,current:true,passed:true}) '
            'WHERE ' + ACCESS + ' AND g.epoch=$epoch AND t.output_artifact_id=a.id AND w.current_artifact_id=a.id '
            'AND r.output_artifact_id=a.id AND a.graph_revision=c.project_revision '
            'CREATE (d:TaskDecision) SET d=$props CREATE (change:WorkItemChange) SET change=$change '
            'SET t=$task,r.status="decided",r.decision_id=d.id,w.status=$status,w.approval_id=$approval_id,'
            'w.approval_output_artifact_id=$approval_output,'
            'w.completion_basis=$basis,w.updated_at=$now,w.updated_by=$actor,w.evidence=$reason,'
            'c.revision=c.revision+1,c.updated_at=$now,g.epoch=g.epoch+1 '
            'MERGE (c)-[:HAS_DECISION]->(d) MERGE (r)-[:HAS_DECISION]->(d) MERGE (d)-[:DECIDES]->(t) '
            'MERGE (c)-[:HAS_ITEM_CHANGE]->(change) MERGE (change)-[:UPDATES]->(w) '
            'WITH c,d OPTIONAL MATCH (c)-[:HAS_MEMORY]->(m:Memory) '
            'WHERE m.recovery_kind IN ["graph_observation","coordination","coverage_review"] '
            'SET m.current=false,m.invalidated_reason="completion_approval" '
            'WITH DISTINCT c,d OPTIONAL MATCH (c)-[:HAS_EPISODE]->(e:Episode) '
            'WHERE e.recovery_kind IN ["graph_observation","coordination","coverage_review"] '
            'SET e.knowledge_current=false,e.index_status="superseded",e.index_token="",e.index_lease_until=0,'
            'e.invalidated_reason="completion_approval" RETURN DISTINCT d',
            cid=case_id, case_revision=case['revision'], tid=task_id, revision=expected_revision, rid=review_id,
            aid=task['output_artifact_id'], actor=self.service.owner, epoch=epoch, props=saved, change=change,
            task=task_result, status=change['status'], approval_id=did if decision == 'approve' else '',
            approval_output=task['output_artifact_id'] if decision == 'approve' else '',
            basis=task_result['completion_basis'], now=now, reason=reason)
        if not rows:
            raise Conflict('Task, output, or memory changed while deciding. Refresh and retry.')
        remaining = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem) WHERE coalesce(w.approval_id,"")="" RETURN w.id', cid=case_id)
        if not remaining:
            self.service.q('MATCH (c:Case {id:$cid}) SET c.execution_status="completed" RETURN c', cid=case_id)
        return response
