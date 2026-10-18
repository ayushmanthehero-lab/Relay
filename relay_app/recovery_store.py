"""Case-scoped graph recovery persistence; FalkorDB is the only authority."""
from __future__ import annotations
import json
import math
import re
import time
from .core import Conflict
from .support_service import ACCESS, nonempty, stable
from .recovery_queries import RecoveryQueries, project_label

ROLES = ('Scout', 'Coordinator', 'Reviewer')
JSON_FIELDS = {'arguments', 'result', 'paths', 'capability_paths', 'memory_versions', 'checks', 'evidence_ids'}


def decode(record):
    result = dict(record)
    for key in JSON_FIELDS:
        if isinstance(result.get(key), str):
            result[key] = json.loads(result[key])
    return result


def default_graph():
    names = [('launch', 'Launch release'), ('qa', 'Verify release QA'),
             ('integration', 'Verify integration'), ('api-contract', 'Confirm API contract'),
             ('security-review', 'Complete security review'), ('docs', 'Prepare launch documentation'),
             ('branding', 'Review branding')]
    items = [dict(key=k, title=t, status='pending', capability='dependency_analysis') for k, t in names]
    dependencies = [dict(source=a, target=b, weight=1) for a, b in
                    [('launch', 'qa'), ('qa', 'integration'), ('integration', 'api-contract'),
                     ('api-contract', 'security-review'), ('launch', 'docs'), ('docs', 'api-contract')]]
    return items, dependencies


class RecoveryStore:
    def __init__(self, service):
        self.service = service

    def _case(self, case_id):
        case = self.service._case(case_id)
        if case.get('kind') != 'recovery':
            raise Conflict('This case is not a graph recovery project.')
        return case

    def create_project(self, title, description, visibility, request_id, items=None, dependencies=None):
        title = nonempty(title, 'Title', 160)
        description = nonempty(description, 'Description', 12000)
        request_id = nonempty(request_id, 'Request ID', 100)
        if visibility not in {'team', 'private'}:
            raise ValueError('Visibility must be team or private.')
        if items is None:
            if dependencies is not None:
                raise ValueError('Dependencies require explicit items.')
            items, dependencies = default_graph()
        dependencies = dependencies or []
        if not isinstance(items, list) or not 1 <= len(items) <= 40:
            raise ValueError('Projects require 1-40 items.')
        if not isinstance(dependencies, list) or len(dependencies) > 80:
            raise ValueError('Projects allow at most 80 dependencies.')
        normalized = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError('Each item must be an object.')
            key = nonempty(item.get('key'), 'Item key', 80)
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', key):
                raise ValueError('Item keys use letters, numbers, dots, underscores and hyphens.')
            status = item.get('status', 'pending')
            if status not in {'pending', 'done'}:
                raise ValueError('Item status must be pending or done.')
            normalized.append(dict(key=key, title=nonempty(item.get('title'), 'Item title', 160),
                                   status=status, capability=nonempty(item.get('capability', 'dependency_analysis'), 'Capability', 80)))
        keys = {i['key'] for i in normalized}
        if len(keys) != len(normalized):
            raise ValueError('Item keys must be unique.')
        edges, seen = [], set()
        adjacency = {k: [] for k in keys}
        for edge in dependencies:
            if not isinstance(edge, dict):
                raise ValueError('Each dependency must be an object.')
            source, target, weight = edge.get('source'), edge.get('target'), edge.get('weight', 1)
            if source not in keys or target not in keys or source == target or (source, target) in seen:
                raise ValueError('Dependencies require distinct valid project keys and unique edges.')
            if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
                raise ValueError('Dependency weights must be finite positive numbers.')
            edges.append(dict(source=source, target=target, weight=weight))
            seen.add((source, target)); adjacency[source].append(target)
        visiting, visited = set(), set()
        def visit(key):
            if key in visiting:
                raise ValueError('Project dependencies must be acyclic.')
            if key not in visited:
                visiting.add(key)
                for child in adjacency[key]:
                    visit(child)
                visiting.remove(key); visited.add(key)
        for key in keys:
            visit(key)
        now, owner = time.time(), self.service.owner
        cid = stable('recovery', owner, request_id)
        fingerprint = stable('project', title, description, visibility, normalized, edges)
        case = dict(id=cid, kind='recovery', title=title, description=description, topic='project recovery',
                    owner=owner, visibility=visibility, request_fingerprint=fingerprint, workflow_status='ready',
                    resolution_status='open', phase='Scout', revision=1, project_revision=1, memory_revision=0,
                    created_at=now, updated_at=now, latest_error='', session_count=1,
                    current_session_id=stable('session', cid, 'initial'))
        scope = dict(case_id=cid, owner=owner, visibility=visibility, created_at=now)
        nodes = [dict(i, **scope, id=stable('workitem', cid, i['key'])) for i in normalized]
        agents = [dict(scope, id=stable('agent', cid, role), name=role, role=role, status='available') for role in ROLES]
        capability_names = sorted({i['capability'] for i in nodes} | {'graph_query', 'dependency_analysis', 'action_planning', 'coverage_review'})
        capabilities = [dict(scope, id=stable('capability', cid, name), name=name, key=name) for name in capability_names]
        agent_edges = [dict(agent=agent['id'], capability=stable('capability', cid, name))
                       for agent in agents for name in {'graph_query', 'dependency_analysis',
                           {'Scout': 'dependency_analysis', 'Coordinator': 'action_planning', 'Reviewer': 'coverage_review'}[agent['role']]}]
        requirements = [dict(item=i['id'], capability=stable('capability', cid, i['capability'])) for i in nodes]
        session = self.service._session_props(case, case['current_session_id'], 'Initial graph recovery session', owner, now)
        query = ('MERGE (c:Case {id:$cid}) ON CREATE SET c=$case WITH c WHERE c.request_fingerprint=$fingerprint '
                 'MERGE (s:WorkSession {id:$sid}) ON CREATE SET s=$session MERGE (c)-[:HAS_SESSION]->(s) '
                 'FOREACH (item IN $items | MERGE (w:WorkItem:' + project_label(cid) + ' {id:item.id}) ON CREATE SET w=item MERGE (c)-[:HAS_ITEM]->(w)) '
                 'FOREACH (agent IN $agents | MERGE (a:Agent {id:agent.id}) ON CREATE SET a=agent MERGE (c)-[:HAS_AGENT]->(a)) '
                 'FOREACH (cap IN $capabilities | MERGE (p:Capability {id:cap.id}) ON CREATE SET p=cap MERGE (c)-[:HAS_CAPABILITY]->(p)) '
                 'WITH c UNWIND $requirements AS req MATCH (w:WorkItem {id:req.item,case_id:$cid}),(p:Capability {id:req.capability,case_id:$cid}) '
                 'MERGE (w)-[:REQUIRES_CAPABILITY]->(p) WITH DISTINCT c '
                 'UNWIND $agent_edges AS edge MATCH (a:Agent {id:edge.agent,case_id:$cid}),(p:Capability {id:edge.capability,case_id:$cid}) '
                 'MERGE (a)-[:HAS_CAPABILITY]->(p) WITH DISTINCT c '
                 'FOREACH (edge IN $edges | MERGE (source:WorkItem {id:edge.source_id,case_id:$cid}) '
                 'MERGE (target:WorkItem {id:edge.target_id,case_id:$cid}) MERGE (source)-[r:DEPENDS_ON]->(target) ON CREATE SET r.weight=edge.weight) RETURN c')
        edge_props = [dict(e, source_id=stable('workitem', cid, e['source']), target_id=stable('workitem', cid, e['target'])) for e in edges]
        rows = self.service.q(query, cid=cid, case=case, fingerprint=fingerprint, sid=session['id'], session=session,
                              items=nodes, agents=agents, capabilities=capabilities, requirements=requirements, agent_edges=agent_edges, edges=edge_props)
        if not rows:
            raise Conflict('Request ID already belongs to another project definition.')
        return rows[0]['c']

    def state(self, case_id):
        case = self._case(case_id)
        result = {'case': case}
        for label, key in [('WorkItem', 'items'), ('Agent', 'agents'), ('RecoveryRequest', 'requests'),
                           ('ToolCall', 'calls'), ('Finding', 'findings'), ('RecoveryAction', 'actions'),
                           ('Handoff', 'handoffs'), ('Memory', 'memories')]:
            rows = self.service.q('MATCH (c:Case {id:$cid})-[]->(n:' + label + ') WHERE ' + ACCESS +
                                  ' RETURN n ORDER BY n.created_at LIMIT 500', cid=case_id, actor=self.service.owner)
            result[key] = [decode(r['n']) for r in rows]
        result['dependencies'] = self.service.q('MATCH (a:WorkItem {case_id:$cid})-[r:DEPENDS_ON]->(b:WorkItem {case_id:$cid}) '
                                               'RETURN a.id AS source,b.id AS target,r.weight AS weight', cid=case_id)
        used_ids = sorted({v['id'] for f in result['findings'] for v in f.get('memory_versions', [])})
        source_ids = sorted({source for f in result['findings'] for source in f.get('source_episode_ids', [])})
        used = self.service.q('MATCH (m:Memory) WHERE m.id IN $ids AND m.current=true '
                              'AND (m.visibility="team" OR ($private AND m.owner=$owner)) RETURN m.id AS id,m.revision AS revision',
                              ids=used_ids, private=case['visibility'] == 'private', owner=case['owner'])
        versions = {row['id']: row['revision'] for row in used}
        sources = self.service.q('MATCH (e:Episode) WHERE e.id IN $ids AND coalesce(e.knowledge_current,true)=true '
                                 'AND (e.visibility="team" OR ($private AND e.owner=$owner)) RETURN e.id AS id',
                                 ids=source_ids, private=case['visibility'] == 'private', owner=case['owner'])
        current_sources = {row['id'] for row in sources}
        own_current = {m['id'] for m in result['memories'] if m.get('current')}
        for finding in result['findings']:
            finding['evidence_current'] = (
                finding['id'] + '_memory' in own_current if finding.get('kind') == 'human_reported' else
                finding['id'] + '_memory' in own_current and finding.get('graph_revision') == case['project_revision']
                and finding.get('memory_revision') == case['memory_revision']
                and all(versions.get(v['id']) == v['revision'] for v in finding.get('memory_versions', []))
                and set(finding.get('source_episode_ids', [])).issubset(current_sources))
        current_findings = {f['id'] for f in result['findings'] if f['evidence_current']}
        for action in result['actions']:
            action['evidence_current'] = action.get('graph_revision') == case['project_revision'] and action.get('finding_id') in current_findings
        return result

    def query(self, case_id, tool, arguments):
        self._case(case_id)
        allowed = {'trace_blockers', 'trace_dependents', 'explain_connection', 'rank_bottlenecks', 'ready_assignments'}
        if tool not in allowed or not isinstance(arguments, dict):
            raise ValueError('Choose a permitted graph query and argument object.')
        try:
            return getattr(RecoveryQueries(self.service, case_id), tool)(**arguments)
        except TypeError as exc:
            raise ValueError('Arguments do not match the authored graph tool.') from exc

    def ask(self, case_id, question, subject, depth, request_id):
        case = self._case(case_id)
        question = nonempty(question, 'Question', 3000)
        subject = nonempty(subject, 'Subject', 160)
        request_id = nonempty(request_id, 'Request ID', 100)
        if type(depth) is not int or not 1 <= depth <= 4:
            raise ValueError('Depth must be an integer from 1 to 4.')
        rid = stable('recovery_request', case_id, self.service.owner, request_id)
        fingerprint = stable('question', question, subject, depth)
        existing = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_REQUEST]->(r:RecoveryRequest {id:$rid}) RETURN r', cid=case_id, rid=rid)
        if existing:
            if existing[0]['r']['fingerprint'] != fingerprint:
                raise Conflict('Request ID already has another question.')
            return existing[0]['r']
        current = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_FINDING]->(f:Finding {kind:"graph_observation",fingerprint:$fingerprint}),'
                                 '(c)-[:HAS_MEMORY]->(own:Memory {current:true}) '
                                 'WHERE own.recovery_finding_id=f.id AND f.graph_revision=c.project_revision AND f.memory_revision=c.memory_revision RETURN f ORDER BY f.created_at DESC LIMIT 1',
                                 cid=case_id, fingerprint=fingerprint)
        reuse_versions = decode(current[0]['f']).get('memory_versions', []) if current else []
        reuse_sources = current[0]['f'].get('source_episode_ids', []) if current else []
        if current:
            recalled = self.service.q('MATCH (m:Memory) WHERE m.id IN $ids AND m.current=true '
                                      'AND (m.visibility="team" OR ($private AND m.owner=$owner)) RETURN m',
                                      ids=[v['id'] for v in reuse_versions], private=case['visibility'] == 'private', owner=case['owner'])
            versions = {r['m']['id']: r['m'].get('revision', 1) for r in recalled}
            if (any(versions.get(v['id']) != v['revision'] for v in reuse_versions)
                    or (reuse_sources and not self.service._current_sources(case, [{'source_episode_ids': reuse_sources}]))):
                current, reuse_versions, reuse_sources = [], [], []
        reused = current[0]['f']['id'] if current else ''
        now = time.time()
        props = dict(id=rid, case_id=case_id, owner=case['owner'], visibility=case['visibility'], question=question,
                     subject=subject, depth=depth, fingerprint=fingerprint, status='completed' if reused else 'queued',
                     created_at=now, reused_finding_id=reused, graph_revision=case['project_revision'])
        job, task = self.job(case, rid, 0, now)
        rows = self.service.q('MATCH (c:Case {id:$cid,revision:$revision}) WHERE ' + ACCESS +
                              ' AND c.workflow_status<>"paused" AND c.resolution_status="open" '
                              'OPTIONAL MATCH (c)-[:HAS_JOB]->(active:Job) WHERE active.kind="recovery" AND active.status IN ["queued","running","paused","blocked"] '
                              'WITH c,count(active) AS active_count WHERE active_count=0 '
                              'OPTIONAL MATCH (m:Memory) WHERE m.id IN $reuse_ids AND m.current=true '
                              'AND (m.visibility="team" OR (c.visibility="private" AND m.owner=c.owner)) '
                              'WITH c,collect(m) AS recalled WHERE size(recalled)=size($reuse_ids) '
                              'AND ALL(v IN $reuse_versions WHERE ANY(m IN recalled WHERE m.id=v.id AND m.revision=v.revision)) '
                              'OPTIONAL MATCH (ep:Episode) WHERE ep.id IN $reuse_sources AND coalesce(ep.knowledge_current,true)=true '
                              'AND (ep.visibility="team" OR (c.visibility="private" AND ep.owner=c.owner)) '
                              'WITH c,count(DISTINCT ep) AS valid_sources WHERE valid_sources=size($reuse_sources) '
                              'MERGE (r:RecoveryRequest {id:$rid}) ON CREATE SET r=$props MERGE (c)-[:HAS_REQUEST]->(r) '
                              'FOREACH (_ IN CASE WHEN $reused="" THEN [1] ELSE [] END | '
                              'MERGE (j:Job {id:$jid}) ON CREATE SET j=$job MERGE (c)-[:HAS_JOB]->(j) '
                              'MERGE (t:Task {id:$tid}) ON CREATE SET t=$task MERGE (c)-[:HAS_TASK]->(t) '
                              'MERGE (j)-[:EXECUTES]->(t) MERGE (r)-[:HAS_JOB]->(j)) '
                              'SET c.workflow_status=CASE WHEN $reused="" THEN "queued" ELSE "ready" END,c.phase="Scout",'
                              'c.revision=c.revision+1,c.updated_at=$now RETURN r',
                              cid=case_id, revision=case['revision'], actor=self.service.owner, rid=rid, props=props,
                              jid=job['id'], job=job, tid=task['id'], task=task, reused=reused, now=now,
                              reuse_ids=[v['id'] for v in reuse_versions], reuse_versions=reuse_versions, reuse_sources=reuse_sources)
        if not rows:
            retry = self.service.q('MATCH (r:RecoveryRequest {id:$rid,fingerprint:$fingerprint}) RETURN r', rid=rid, fingerprint=fingerprint)
            if retry:
                return retry[0]['r']
            raise Conflict('Project is paused, changed, or already has active recovery work. Continue or finish that work first.')
        return rows[0]['r']

    @staticmethod
    def job(case, request_id, stage, now):
        jid = stable('recovery_job', request_id, stage)
        tid = jid + '_task'
        scope = dict(case_id=case['id'], owner=case['owner'], visibility=case['visibility'], created_at=now)
        job = dict(scope, id=jid, kind='recovery', request_id=request_id, agent=ROLES[stage], stage=stage,
                   task_id=tid, status='queued', lease_until=0, retry_at=0, attempts=0, error='')
        task = dict(scope, id=tid, title=ROLES[stage] + ' graph recovery', description='Execute graph reasoning and save coordination evidence. External implementation completion requires human evidence.',
                    agent=ROLES[stage], task_kind='agent_execution', request_id=request_id, position=stage,
                    status='todo', revision=1, evidence='', completion_basis='pending_agent_execution')
        return job, task

    def remember(self, case_id, content, request_id):
        case = self._case(case_id)
        content = nonempty(content, 'Memory', 6000)
        request_id = nonempty(request_id, 'Request ID', 100)
        fid = stable('recovery_note', case_id, self.service.owner, request_id)
        fingerprint = stable('note', content)
        now = time.time()
        finding = dict(id=fid, case_id=case_id, owner=case['owner'], visibility=case['visibility'], title='Human-reported project finding',
                       content=content, kind='human_reported', agent='Human', recorded_by=self.service.owner,
                       fingerprint=fingerprint, graph_revision=case['project_revision'], created_at=now)
        episode, memory = self.evidence(case, finding, now)
        rows = self.service.q('MATCH (g:Gate {id:"memory"}),(c:Case {id:$cid}) WHERE ' + ACCESS +
                              ' OPTIONAL MATCH (old:Finding {id:$fid}) WITH g,c,old WHERE old IS NULL '
                              'CREATE (f:Finding) SET f=$finding CREATE (e:Episode) SET e=$episode CREATE (m:Memory) SET m=$memory '
                              'MERGE (c)-[:HAS_FINDING]->(f) MERGE (c)-[:HAS_EPISODE]->(e) MERGE (c)-[:HAS_MEMORY]->(m) '
                              'MERGE (f)-[:RECORDED_AS]->(e) MERGE (m)-[:DERIVED_FROM]->(e) '
                              'MERGE (topic:Topic {id:c.topic}) MERGE (m)-[:ABOUT]->(topic) '
                              'MERGE (src:Source {id:$source}) SET src.visibility=c.visibility,src.owner=c.owner,src.title=$source MERGE (m)-[:SOURCED_FROM]->(src) '
                              'SET c.memory_revision=c.memory_revision+1,c.revision=c.revision+1,c.updated_at=$now,g.epoch=g.epoch+1 '
                              'WITH c,f OPTIONAL MATCH (c)-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact) SET a.current=false '
                              'WITH DISTINCT c,f OPTIONAL MATCH (c)-[:HAS_MEMORY]->(em:Memory) WHERE em.execution_artifact_id IS NOT NULL '
                              'SET em.current=false,em.invalidated_reason="project_memory_changed" '
                              'WITH DISTINCT c,f OPTIONAL MATCH (c)-[:HAS_EPISODE]->(ee:Episode) WHERE ee.execution_artifact_id IS NOT NULL '
                              'SET ee.knowledge_current=false,ee.index_status="superseded",ee.index_token="",ee.index_lease_until=0 RETURN DISTINCT f',
                              cid=case_id, actor=self.service.owner, fid=fid, finding=finding, episode=episode, memory=memory, source=memory['source_id'], now=now)
        if rows:
            return rows[0]['f']
        prior = self.service.q('MATCH (f:Finding {id:$fid,fingerprint:$fingerprint}) RETURN f', fid=fid, fingerprint=fingerprint)
        if not prior:
            raise Conflict('Memory request ID already has different content.')
        return prior[0]['f']

    def evidence(self, case, finding, now):
        episode = dict(id=finding['id'] + '_episode', case_id=case['id'], title=finding['title'], content=finding['content'],
                       visibility=case['visibility'], owner=case['owner'], recorded_by=finding.get('agent', self.service.owner),
                       created_at=now, index_status='queued', graphiti_uuid='', index_error='', knowledge_current=True)
        memory = self.service._memory_props(case, finding['id'] + '_memory', 'episodic', finding['title'], finding['content'], [episode['id']], now)
        provenance = dict(recovery_graph_revision=case['project_revision'], recovery_finding_id=finding['id'],
                          recovery_kind=finding['kind'])
        episode.update(provenance)
        memory.update(provenance)
        return episode, memory

    def update_item(self, case_id, item_key, status, expected_revision, reason, request_id):
        case = self._case(case_id)
        item_key = nonempty(item_key, 'Item key', 80)
        reason = nonempty(reason, 'Status evidence', 3000)
        request_id = nonempty(request_id, 'Request ID', 100)
        if status not in {'pending', 'done'} or type(expected_revision) is not int or expected_revision < 1:
            raise ValueError('Status must be pending or done and expected_revision a positive project revision.')
        change_id = stable('item_change', case_id, self.service.owner, request_id)
        fingerprint = stable('item_update', item_key, status, expected_revision, reason)
        prior = self.service.q('MATCH (c:Case {id:$cid})-[:HAS_ITEM_CHANGE]->(change:WorkItemChange {id:$id}) RETURN change', cid=case_id, id=change_id)
        if prior:
            if prior[0]['change']['fingerprint'] != fingerprint:
                raise Conflict('Item update request ID already has different content.')
            return json.loads(prior[0]['change']['response'])
        now = time.time()
        # The response is constructed from the actual state while the revision fence
        # below guarantees this exact state won the atomic write.
        items = self.service.q('MATCH (w:WorkItem {case_id:$cid,key:$key}) RETURN w', cid=case_id, key=item_key)
        if not items:
            raise Conflict('Work item is unknown in this project.')
        item = dict(items[0]['w'], status=status, updated_at=now, updated_by=self.service.owner, evidence=reason)
        changed_case = dict(case, project_revision=expected_revision + 1, revision=case['revision'] + 1, updated_at=now)
        response = dict(case=changed_case, item=item)
        change = dict(id=change_id, case_id=case_id, owner=case['owner'], visibility=case['visibility'],
                      actor=self.service.owner, item_key=item_key, status=status, reason=reason,
                      fingerprint=fingerprint, created_at=now, response=json.dumps(response))
        rows = self.service.q('MATCH (c:Case {id:$cid,revision:$case_revision,project_revision:$revision})-[:HAS_ITEM]->(w:WorkItem {key:$key,case_id:$cid}) '
                              'WHERE ' + ACCESS + ' OPTIONAL MATCH (old:WorkItemChange {id:$id}) WITH c,w,old WHERE old IS NULL '
                              'SET w=$item,c.project_revision=c.project_revision+1,c.revision=c.revision+1,c.updated_at=$now '
                              'CREATE (change:WorkItemChange) SET change=$change MERGE (c)-[:HAS_ITEM_CHANGE]->(change) '
                              'MERGE (change)-[:UPDATES]->(w) '
                              'WITH c,change OPTIONAL MATCH (c)-[:HAS_MEMORY]->(m:Memory) '
                              'WHERE m.recovery_kind IN ["graph_observation","coordination","coverage_review"] '
                              'AND m.recovery_graph_revision<c.project_revision '
                              'SET m.current=false,m.invalidated_at=$now '
                              'WITH DISTINCT c,change OPTIONAL MATCH (c)-[:HAS_EPISODE]->(e:Episode) '
                              'WHERE e.recovery_kind IN ["graph_observation","coordination","coverage_review"] '
                              'AND e.recovery_graph_revision<c.project_revision '
                              'SET e.knowledge_current=false,e.index_status="superseded",e.index_token="",e.index_lease_until=0 '
                              'WITH DISTINCT c,change OPTIONAL MATCH (c)-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact) SET a.current=false '
                              'WITH DISTINCT c,change OPTIONAL MATCH (c)-[:HAS_MEMORY]->(em:Memory) WHERE em.execution_artifact_id IS NOT NULL '
                              'SET em.current=false,em.invalidated_reason="project_graph_changed" '
                              'WITH DISTINCT c,change OPTIONAL MATCH (c)-[:HAS_EPISODE]->(ee:Episode) WHERE ee.execution_artifact_id IS NOT NULL '
                              'SET ee.knowledge_current=false,ee.index_status="superseded",ee.index_token="",ee.index_lease_until=0 '
                              'WITH DISTINCT change MATCH (g:Gate {id:"memory"}) SET g.epoch=g.epoch+1 RETURN change',
                              cid=case_id, actor=self.service.owner, case_revision=case['revision'], revision=expected_revision,
                              key=item_key, id=change_id, item=item, now=now, change=change)
        if not rows:
            prior = self.service.q('MATCH (change:WorkItemChange {id:$id,fingerprint:$fingerprint}) RETURN change', id=change_id, fingerprint=fingerprint)
            if prior:
                return json.loads(prior[0]['change']['response'])
            raise Conflict('Project revision changed. Refresh before changing a work item.')
        return response
