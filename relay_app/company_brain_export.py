"""Read-only, team-only Company Brain snapshot. Native Relay remains authoritative.

The public workspace APIs intentionally include a caller's own private work.
This boundary instead selects team cases and team descendants independently,
exports an explicit field allowlist, and fails closed on incomplete snapshots.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from urllib.parse import quote

from fastapi import APIRouter, Depends
from redis.exceptions import ConnectionError as RedisConnectionError, ResponseError, TimeoutError as RedisTimeoutError

from .core import Graph, GraphUnavailable, plain
from .support_worker import configured_principals


MAX_CASES = 100
MAX_NODES = 5000
MAX_EDGES = 12000
MAX_EXPORT_RECORDS = 10000
MAX_EXPORT_BYTES = 8_000_000
READ_TIMEOUT_MS = 5000
LABELS = ('WorkItem', 'Task', 'WorkSession', 'Artifact', 'ExecutionArtifact', 'TaskReview',
          'TaskDecision', 'ProjectStartApproval', 'TaskEvidence', 'Memory', 'Episode', 'Message', 'Agent', 'Handoff', 'Finding')
KINDS = {'WorkItem': 'task', 'Task': 'task', 'WorkSession': 'session', 'Artifact': 'artifact',
         'ExecutionArtifact': 'artifact', 'TaskReview': 'review', 'TaskDecision': 'decision', 'ProjectStartApproval': 'decision',
         'TaskEvidence': 'check', 'Memory': 'memory', 'Episode': 'episode', 'Message': 'chat',
         'Agent': 'agent', 'Handoff': 'handoff', 'Finding': 'memory'}
EDGE_TYPES = {'HAS_TASK': 'HAS_TASK', 'HAS_ITEM': 'HAS_TASK', 'DEPENDS_ON': 'DEPENDS_ON',
              'PRODUCED': 'PRODUCED', 'USES_EVIDENCE': 'SUPPORTED_BY', 'DERIVED_FROM': 'DERIVED_FROM',
              'ABOUT': 'ABOUT', 'USED_MEMORY': 'USED_MEMORY', 'USED_INPUT': 'USED_INPUT',
              'REVIEWS': 'REVIEWED', 'DECIDES': 'DECIDED', 'HANDOFF_TO': 'HANDOFF_TO',
              'IMPLEMENTS': 'ABOUT', 'CARRIES': 'SUPPORTED_BY', 'HAS_OUTPUT': 'PRODUCED',
              'RECORDED_AS': 'DERIVED_FROM', 'HAS_REVIEW': 'REVIEWED', 'HAS_DECISION': 'DECIDED'}
SCALAR_FIELDS = ('status', 'workflow_status', 'resolution_status', 'execution_status', 'task_kind',
                 'completion_basis', 'verdict', 'decision', 'overrides_recommendation', 'provider',
                 'passed', 'execution_mode', 'kind', 'approved', 'revision', 'project_revision',
                 'graph_revision', 'memory_revision', 'ordinal', 'closed_at', 'capability', 'role',
                 'ai_review_status', 'synthetic', 'demo_dataset', 'project_id', 'project_plan_version', 'project_superseded',
                 'project_source', 'project_source_tenant', 'project_source_plan_id', 'project_source_version', 'project_source_url',
                 'plan_version', 'execution_generation',
                 'assigned_company_person_id', 'assigned_name', 'assigned_relay_person_id',
                 'assignment_source', 'assignment_source_tenant', 'assignment_kind')
JSON_FIELDS = ('files', 'checks', 'source_episode_ids', 'memory_ids', 'memory_versions',
               'input_artifact_ids', 'evidence_ids', 'missing_evidence', 'knowledge_facts')


def _decode(record):
    result = dict(record)
    for key in JSON_FIELDS:
        if isinstance(result.get(key), str):
            try:
                result[key] = json.loads(result[key])
            except (ValueError, TypeError):
                result[key] = []
                result['_invalid_provenance'] = True
        if key in result and not isinstance(result[key], list):
            result[key] = []
            result['_invalid_provenance'] = True
    return result


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode()).hexdigest()


class CompanyBrainExport:
    def __init__(self, cfg, principal):
        self.cfg, self.principal = cfg, principal
        self.graph = Graph(cfg, principal['tenant'])
        self.graph.name = 'relay_support_' + principal['tenant']

    def _read(self, query, **params):
        try:
            result = self.graph.graph.ro_query(query, params, timeout=READ_TIMEOUT_MS)
            return [{column[1]: plain(value) for column, value in zip(result.header, row)}
                    for row in result.result_set]
        except (RedisConnectionError, RedisTimeoutError, OSError) as exc:
            raise GraphUnavailable('FalkorDB unavailable; Company Brain export requires the authoritative graph.') from exc
        except ResponseError as exc:
            raise GraphUnavailable('FalkorDB could not complete the read-only Company Brain snapshot.') from exc

    def _stamp(self):
        cases = self._read('MATCH (c:Case {visibility:"team"}) RETURN c ORDER BY c.id LIMIT $limit',
                           limit=MAX_CASES + 1)
        gate = self._read('MATCH (g:Gate {id:"memory"}) RETURN g.epoch AS epoch')
        return cases, gate

    def snapshot(self):
        result = dict(schema_version=1, source='relay', tenant=self.principal['tenant'], scope='team',
                      exported_at=datetime.now(timezone.utc).isoformat(), complete=False,
                      records=[], relationships=[], counts={})
        cases, gate = self._stamp()
        if len(cases) > MAX_CASES:
            return dict(result, incomplete_reason='case_limit')
        case_map = {row['c']['id']: row['c'] for row in cases}
        if not case_map:
            return dict(result, complete=True, counts={'records': 0, 'relationships': 0})
        label_predicate = ' OR '.join('n:' + label for label in LABELS)
        rows = self._read('MATCH (n) WHERE n.visibility="team" AND n.case_id IN $cases '
                          'AND (' + label_predicate + ') RETURN n,labels(n) AS labels ORDER BY n.id LIMIT $limit',
                          cases=list(case_map), limit=MAX_NODES + 1)
        if len(rows) > MAX_NODES:
            return dict(result, incomplete_reason='record_limit')
        nodes = {row['n']['id']: _decode(row['n']) for row in rows}
        labels = {row['n']['id']: next(label for label in LABELS if label in row['labels']) for row in rows}
        nodes.update(case_map)
        labels.update({cid: 'Case' for cid in case_map})
        edges = self._read('MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids '
                           'RETURN a.id AS source,b.id AS target,type(r) AS type ORDER BY source,type,target LIMIT $limit',
                           ids=list(nodes), limit=MAX_EDGES + 1)
        if len(edges) > MAX_EDGES:
            return dict(result, incomplete_reason='relationship_limit')
        # A shared label cannot launder private/missing provenance into the export.
        # Remove dependent records transitively before projecting any text or IDs.
        while True:
            rejected = []
            for nid, node in nodes.items():
                refs = list(node.get('source_episode_ids', [])) + list(node.get('memory_ids', []))
                refs += list(node.get('input_artifact_ids', []))
                refs += [v.get('id') for v in node.get('memory_versions', []) if isinstance(v, dict)]
                invalid = bool(node.get('_invalid_provenance'))
                for fact in node.get('knowledge_facts', []):
                    if not isinstance(fact, dict):
                        invalid = True
                        continue
                    if fact.get('scope') not in (None, 'relaykg_' + self.principal['tenant'] + '_team'):
                        invalid = True
                    for field in ('source_episode_ids', 'source_case_ids'):
                        values = fact.get(field, [])
                        if isinstance(values, list):
                            refs.extend(values)
                        else:
                            invalid = True
                if invalid or any(not isinstance(ref, str) or ref not in nodes for ref in refs):
                    rejected.append(nid)
            if not rejected:
                break
            for nid in rejected:
                nodes.pop(nid)
        records, relationships = self._project(nodes, labels, case_map, edges, gate)
        if len(records) > MAX_EXPORT_RECORDS:
            return dict(result, incomplete_reason='expanded_record_limit')
        # Case revisions and the memory epoch fence concurrent content/index changes.
        after_cases, after_gate = self._stamp()
        if cases != after_cases or gate != after_gate:
            return dict(result, incomplete_reason='source_changed_during_export')
        result.update(complete=True, records=records, relationships=relationships,
                      counts=dict(Counter(record['kind'] for record in records),
                                  records=len(records), relationships=len(relationships)))
        if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_EXPORT_BYTES:
            return dict(result, complete=False, records=[], relationships=[], counts={},
                        incomplete_reason='snapshot_size_limit')
        return result

    def _project(self, nodes, labels, cases, edges, gate):
        records, relationships, source_records = {}, set(), {}
        epoch = gate[0]['epoch'] if gate else 0
        known_people = {p['id']: p['name'] for p in configured_principals(self.cfg)
                        if p['tenant'] == self.principal['tenant']}
        known_people[self.principal['id']] = self.principal['name']

        def edge(source, target, kind):
            if source and target:
                relationships.add((source, target, kind))

        def add(kind, source_id, title, text='', *, case_id='', current=True, attributes=None,
                record_id=None, source_path=None, updated_at=0):
            rid = record_id or kind + ':' + source_id
            attrs = attributes or {}
            if isinstance(updated_at, (int, float)) and updated_at:
                updated_at = datetime.fromtimestamp(updated_at, timezone.utc).isoformat()
            elif not isinstance(updated_at, str):
                updated_at = ''
            record = dict(id=rid, kind=kind, title=str(title or kind.title()), text=str(text or ''),
                          source_id=source_id, source_path=source_path or (
                              '/api/support/cases/' + quote(case_id, safe='') if case_id else '/api/company-brain/export'),
                          updated_at=updated_at, case_id=case_id, current=bool(current), attributes=attrs)
            record['version'] = _hash(record)
            records[rid] = record
            return rid

        def person(actor):
            if not actor:
                return None
            rid = 'person:' + actor
            if rid not in records:
                add('person', actor, known_people.get(actor, actor), attributes={'author_kind': 'human'})
            return rid

        agent_ids = {(n.get('case_id'), n.get('role') or n.get('name')): nid
                     for nid, n in nodes.items() if labels[nid] == 'Agent'}

        def agent(role, cid):
            if not role or role == 'Human':
                return None
            native_id = agent_ids.get((cid, role))
            rid = 'agent:' + (native_id or cid + ':role:' + role)
            if rid not in records:
                add('agent', native_id or cid, role, case_id=cid, record_id=rid,
                    attributes={'author_kind': 'agent', 'role': role, 'derived_identity': not bool(native_id)})
            return rid

        def valid_sources(n, allow_completion=False):
            source_ids = list(n.get('source_episode_ids', []))
            source_ids.extend(source for fact in n.get('knowledge_facts', [])
                              for source in fact.get('source_episode_ids', []))
            return all(ref in nodes and (nodes[ref].get('knowledge_current', True) or
                       (allow_completion and nodes[ref].get('invalidated_reason') == 'completion_approval'))
                       for ref in source_ids)

        def valid_memories(n, allow_completion=False):
            for version in n.get('memory_versions', []):
                memory = nodes.get(version.get('id'), {})
                if memory.get('revision') != version.get('revision') or not (
                    memory.get('current') or (allow_completion and memory.get('invalidated_reason') == 'completion_approval')):
                    return False
            return all(nodes.get(mid, {}).get('current') or
                       (allow_completion and nodes.get(mid, {}).get('invalidated_reason') == 'completion_approval')
                       for mid in n.get('memory_ids', []))

        artifact_currency = {}

        def artifact_current(n, seen=None):
            if n['id'] in artifact_currency:
                return artifact_currency[n['id']]
            seen = set() if seen is None else seen
            if n['id'] in seen:
                return False
            seen.add(n['id'])
            c = cases[n['case_id']]
            current = bool(n.get('current') and n.get('passed') and
                           n.get('graph_revision') == c.get('project_revision') and
                           n.get('memory_revision') == c.get('memory_revision', 0) and
                           valid_sources(n, True) and valid_memories(n, True))
            current = current and all(artifact_current(nodes[aid], set(seen)) for aid in n.get('input_artifact_ids', []))
            artifact_currency[n['id']] = bool(current)
            return bool(current)

        for nid, n in nodes.items():
            label, cid = labels[nid], n.get('case_id', nid if labels[nid] == 'Case' else '')
            attrs = {key: n[key] for key in SCALAR_FIELDS if key in n and isinstance(n[key], (str, int, float, bool))}
            work_item = n if label == 'WorkItem' else nodes.get(n.get('work_item_id'), {})
            if not work_item and n.get('task_id'):
                work_item = nodes.get(nodes.get(n['task_id'], {}).get('work_item_id'), {})
            if work_item.get('assigned_company_person_id'):
                attrs.update(planned_company_person_id=work_item['assigned_company_person_id'],
                             planned_company_tenant=work_item.get('assignment_source_tenant', ''),
                             planned_owner_name=work_item.get('assigned_name', ''),
                             assignment_basis='imported_plan')
            attrs['visibility'] = 'team'
            kind = ('project' if n.get('kind') == 'recovery' else 'ticket') if label == 'Case' else KINDS[label]
            if label == 'Task' and n.get('task_kind') == 'execution_work':
                kind = 'execution'
            current = True
            if label == 'Memory':
                current = bool(n.get('current') and valid_sources(n) and (n.get('kind') != 'procedural' or n.get('approved')))
                if not current:
                    continue
            elif label == 'Finding':
                current = bool(nodes.get(nid + '_memory', {}).get('current') and valid_sources(n) and valid_memories(n))
                if n.get('kind') != 'human_reported':
                    current = current and n.get('graph_revision') == cases[cid].get('project_revision') and n.get('memory_revision') == cases[cid].get('memory_revision')
                if not current:
                    continue
            elif label == 'ExecutionArtifact':
                current = artifact_current(n)
            elif label == 'Artifact':
                current = valid_sources(n) and valid_memories(n) and (not n.get('knowledge_facts') or n.get('memory_epoch') == epoch)
            elif label == 'Episode':
                current = n.get('knowledge_current', True)
            elif label == 'TaskReview':
                task = nodes.get(n.get('task_id'), {})
                current = (n.get('status') == 'pending' and task.get('current_review_id') == nid and
                           task.get('revision') == n.get('task_revision') and valid_sources(n, True) and valid_memories(n, True))
                if task.get('task_kind') == 'execution_work':
                    output = nodes.get(n.get('output_artifact_id'), {})
                    current = current and bool(output) and task.get('output_artifact_id') == output.get('id') and artifact_current(output)
                else:
                    current = current and n.get('case_revision') == cases[cid].get('revision') and n.get('memory_epoch') == epoch
                attrs['author_kind'] = 'agent'
                reviewer_role = n.get('actor') if (cid, n.get('actor')) in agent_ids else 'AI reviewer'
                attrs['reviewing_agent_id'] = agent(reviewer_role, cid)
                if n.get('actor') in known_people:
                    attrs['requested_by'] = person(n['actor'])
                attrs['review_current'] = bool(current)
            if label in {'WorkItem', 'Task'}:
                decision = nodes.get(n.get('approval_id'), {})
                approved = bool(n.get('status') == 'done' and labels.get(decision.get('id')) == 'TaskDecision'
                                and decision.get('decision') == 'approve')
                attrs['approval_status'] = 'approved' if approved else 'reported_complete' if n.get('status') in {'done'} else 'open'
                attrs['human_status'] = n.get('status', 'pending')
                if label == 'Task' and n.get('task_kind') == 'execution_work':
                    output = nodes.get(n.get('output_artifact_id'))
                    current = artifact_current(output) if output else n.get('graph_revision') == cases[cid].get('project_revision')
                    attrs['guidance_current'] = bool(current)
                elif label == 'Task' and n.get('task_kind') == 'recovery_action':
                    current = n.get('graph_revision') == cases[cid].get('project_revision')
                    attrs['guidance_current'] = bool(current)
            if label in {'TaskDecision', 'ProjectStartApproval'}:
                attrs['author_kind'] = 'human'
                attrs['decided_by'] = person(n.get('actor'))
            elif label == 'Message':
                attrs['author_kind'] = 'human' if n.get('role') == 'user' else 'agent'
                if n.get('role') == 'user':
                    attrs['author_id'] = person(n.get('actor'))
            elif label == 'TaskEvidence' or (label == 'Finding' and n.get('kind') == 'human_reported'):
                attrs['author_kind'] = 'human'
                attrs['author_id'] = person(n.get('actor') or n.get('recorded_by'))
            elif label in {'ExecutionArtifact', 'Artifact', 'Agent'}:
                attrs['author_kind'] = 'agent'
            title = n.get('title') or n.get('name') or ('AI review: ' + n.get('verdict', '') if label == 'TaskReview'
                    else 'Human decision: ' + n.get('decision', '') if label in {'TaskDecision', 'ProjectStartApproval'} else label)
            text = n.get('description') or n.get('summary') or n.get('rationale') or n.get('reason') or n.get('content') or ''
            current = bool(current and not cases[cid].get('project_superseded'))
            path = '/api/support/cases/' + quote(cid, safe='')
            if label == 'ExecutionArtifact':
                path += '/execution/artifacts/' + quote(nid, safe='')
            elif label == 'ProjectStartApproval':
                path = '/api/projects/' + quote(n['project_id'], safe='')
            elif label in {'TaskReview', 'TaskDecision', 'WorkSession', 'TaskEvidence', 'Agent', 'WorkItem', 'Finding'}:
                path = '/api/support/flow?case_id=' + quote(cid, safe='')
            rid = add(kind, nid, title, text, case_id=cid, current=current, attributes=attrs,
                      updated_at=n.get('updated_at', n.get('created_at', 0)), source_path=path)
            source_records[nid] = rid
            if label == 'Case':
                owner = person(n.get('owner'))
                attrs['owner_id'] = owner
                edge(owner, rid, 'OWNS')
            elif label == 'WorkSession':
                edge(person(n.get('started_by')), rid, 'PARTICIPATED')
            if label in {'Task', 'WorkItem', 'ExecutionArtifact', 'Artifact'}:
                executor = agent(n.get('agent') or n.get('execution_agent'), cid)
                if executor:
                    attrs['executing_agent_id'] = executor
                    edge(executor, rid, 'PRODUCED' if label.endswith('Artifact') else 'EXECUTED')
            if label in {'TaskDecision', 'ProjectStartApproval'}:
                edge(attrs.get('decided_by'), rid, 'DECIDED')
            elif label == 'TaskReview':
                edge(attrs.get('reviewing_agent_id'), rid, 'REVIEWED')
            # Expand only explicit safe file/check fields; raw tool calls and claims stay local.
            if label == 'ExecutionArtifact':
                for index, file in enumerate(n.get('files', [])):
                    if not isinstance(file, dict):
                        continue
                    file_id = 'document:' + nid + ':' + _hash(file.get('path', index))[:16]
                    file_attrs = {key: file[key] for key in ('path', 'media_type', 'sha256', 'size', 'bytes') if key in file}
                    file_attrs.update({key: attrs[key] for key in ('planned_company_person_id', 'planned_company_tenant',
                                                                 'planned_owner_name', 'assignment_basis') if key in attrs})
                    doc = add('document', nid, file.get('path', 'Output file'), file.get('content', ''),
                              case_id=cid, current=current, record_id=file_id, source_path=path,
                              updated_at=n.get('created_at', 0), attributes=file_attrs)
                    edge(rid, doc, 'PRODUCED')
                for index, check in enumerate(n.get('checks', [])):
                    if not isinstance(check, dict):
                        continue
                    check_id = add('check', nid, check.get('name', 'Execution check'), check.get('detail', ''),
                                   case_id=cid, current=current, record_id='check:' + nid + ':' + str(index),
                                   source_path=path, updated_at=n.get('created_at', 0),
                                   attributes={key: check[key] for key in ('passed', 'name', 'detail') if key in check})
                    edge(rid, check_id, 'SUPPORTED_BY')
        for nid, rid in source_records.items():
            n, label = nodes[nid], labels[nid]
            cid = n.get('case_id')
            case_rid = source_records.get(cid)
            if case_rid:
                edge(case_rid, rid, 'HAS_TASK' if label in {'WorkItem', 'Task'} else 'ABOUT')
                owner = person(cases[cid].get('owner'))
                if records[rid]['attributes'].get('planned_company_person_id'):
                    records[rid]['attributes']['acl_owner_id'] = owner
                else:
                    records[rid]['attributes']['owner_id'] = owner
                    edge(owner, rid, 'OWNS')
            for field, relation in [('work_item_id', 'ABOUT'), ('task_id', 'ABOUT'),
                                    ('output_artifact_id', 'SUPPORTED_BY'), ('review_id', 'REVIEWED'),
                                    ('artifact_id', 'SUPPORTED_BY'), ('finding_id', 'SUPPORTED_BY')]:
                target = source_records.get(n.get(field))
                if target:
                    records[rid]['attributes'][field] = target
                    edge(rid, target, 'DECIDED' if label == 'TaskDecision' and field == 'task_id' else relation)
            for field, relation in [('memory_ids', 'USED_MEMORY'), ('input_artifact_ids', 'USED_INPUT'),
                                    ('source_episode_ids', 'DERIVED_FROM'), ('evidence_ids', 'SUPPORTED_BY')]:
                for target in n.get(field, []):
                    edge(rid, source_records.get(target), relation)
            if n.get('session_id'):
                edge(rid, source_records.get(n['session_id']), 'IN_SESSION')
            if label == 'Handoff':
                edge(agent(n.get('from_agent'), cid), rid, 'PRODUCED')
                edge(rid, agent(n.get('to_agent'), cid), 'HANDOFF_TO')
        for item in edges:
            source, target = source_records.get(item['source']), source_records.get(item['target'])
            if item['type'] == 'CONTAINS' and labels.get(item['source']) == 'WorkSession':
                edge(target, source, 'IN_SESSION')
            elif item['type'] in EDGE_TYPES:
                edge(source, target, EDGE_TYPES[item['type']])
        # Versions cover the final allowlisted fields, including resolved references.
        for record in records.values():
            record['version'] = _hash({key: value for key, value in record.items() if key != 'version'})
        return sorted(records.values(), key=lambda r: r['id']), [dict(source=a, target=b, type=t)
            for a, b, t in sorted(relationships) if a in records and b in records]


def create_company_brain_router(get_settings, principal):
    router = APIRouter(prefix='/api/company-brain', tags=['Company Brain export'])

    @router.get('/export')
    def export(p=Depends(principal)):
        return CompanyBrainExport(get_settings(), p).snapshot()

    return router
