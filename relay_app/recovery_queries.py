"""Bounded, authorized native graph reasoning for one recovery project."""
from __future__ import annotations

import hashlib

from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError, ResponseError

from .core import Conflict, GraphUnavailable, plain


MAX_PATHS = 100
READ_TIMEOUT_MS = 2000
_BOUNDS = {1: '1..1', 2: '1..2', 3: '1..3', 4: '1..4'}
_FRONTIER_BOUNDS = {1: '0..1', 2: '0..2', 3: '0..3', 4: '0..4'}
_PATH = ('[n IN nodes(p) | n.id] AS ids,'
         '[n IN nodes(p) | n.key] AS keys,'
         '[n IN nodes(p) | n.title] AS titles,'
         '[r IN relationships(p) | type(r)] AS relationship_types,'
         'length(p) AS hops')
_PATH_FIELDS = ('ids', 'keys', 'titles', 'relationship_types', 'hops')


def project_label(case_id):
    """An authored Cypher identifier, never an interpolated user identifier."""
    if not isinstance(case_id, str) or not case_id or len(case_id) > 200:
        raise ValueError('Case ID must contain 1–200 characters.')
    return 'Recovery_' + hashlib.sha256(case_id.encode('utf-8')).hexdigest()[:24]


def _bounded_integer(value, name, maximum):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f'{name} must be an integer between 1 and {maximum}.')
    return value


def _entity_key(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        raise ValueError('Work item key must contain 1–160 characters.')
    return value.strip()


class RecoveryQueries:
    """Author-defined MCP operations; there is no free-form query entry point."""

    def __init__(self, service, case_id):
        self.service = service
        self.case_id = case_id
        self.label = project_label(case_id)

    def _read(self, query, **params):
        try:
            result = self.service.graph.graph.ro_query(
                query, {'case_id': self.case_id, 'actor': self.service.owner, **params},
                timeout=READ_TIMEOUT_MS)
            return [{col[1]: plain(value) for col, value in zip(result.header, row)}
                    for row in result.result_set]
        except (RedisConnectionError, RedisTimeoutError, OSError) as exc:
            raise GraphUnavailable('FalkorDB unavailable; recovery requires the authoritative graph.') from exc
        except ResponseError as exc:
            if any(code in str(exc) for code in ('MISCONF', 'LOADING', 'READONLY')):
                raise GraphUnavailable('FalkorDB persistence or availability error.') from exc
            raise

    @property
    def _access(self):
        return ('MATCH (c:Case {id:$case_id}) '
                'WHERE c.visibility="team" OR c.owner=$actor WITH c ')

    def _case(self):
        rows = self._read(self._access + 'RETURN c')
        if not rows:
            raise Conflict('Case not found for this person or workspace.')
        return rows[0]['c']

    def _resolve(self, keys):
        rows = self._read(self._access + 'MATCH (w:WorkItem:' + self.label + ' {case_id:$case_id}) '
                          'WHERE w.key IN $keys RETURN w.id AS id,w.key AS key', keys=keys)
        found = {row['key']: row['id'] for row in rows}
        return found, list(dict.fromkeys(key for key in keys if key not in found))

    def _result(self, case, tool, algorithm, rows, *, depth=None, missing=None,
                truncated=False, **arguments):
        outcome = 'unknown_entity' if missing else 'found' if rows else 'not_in_graph'
        if missing:
            summary = 'The requested work item is unknown in this authorized project.'
        elif not rows:
            summary = 'No matching evidence was observed within the requested graph bounds; this is not a real-world safety conclusion.'
        else:
            summary = f'{len(rows)} graph evidence result(s) within the requested bounds.'
        if truncated:
            summary += ' Additional results exist; the returned evidence is incomplete.'
        result = dict(tool=tool, algorithm=algorithm, case_id=self.case_id,
                      project_revision=case.get('project_revision', case.get('revision')),
                      depth=depth, outcome=outcome, rows=rows, truncated=truncated,
                      summary=summary, **arguments)
        if missing:
            result['unresolved_keys'] = missing
        return result

    def _trace(self, subject, depth, *, incoming):
        depth = _bounded_integer(depth, 'Depth', 4)
        subject = _entity_key(subject)
        case = self._case()
        _, missing = self._resolve([subject])
        tool = 'trace_dependents' if incoming else 'trace_blockers'
        if missing:
            return self._result(case, tool, 'Cypher bounded traversal', [], depth=depth,
                                missing=missing, subject=subject)
        relationship = ('<-[:DEPENDS_ON*' + _BOUNDS[depth] + ']-' if incoming
                        else '-[:DEPENDS_ON*' + _BOUNDS[depth] + ']->')
        query = (self._access + 'MATCH p=(s:WorkItem:' + self.label +
                 ' {case_id:$case_id,key:$subject})' + relationship + '(w:WorkItem:' + self.label + ') '
                 'WHERE ALL(n IN nodes(p) WHERE n.case_id=$case_id) ')
        if not incoming:
            query += 'AND w.status="pending" '
        rows = self._read(query + 'RETURN ' + _PATH + ' ORDER BY hops,keys LIMIT 101', subject=subject)
        return self._result(case, tool, 'Cypher bounded traversal', rows[:MAX_PATHS],
                            depth=depth, truncated=len(rows) > MAX_PATHS, subject=subject)

    def trace_blockers(self, subject, depth=4):
        return self._trace(subject, depth, incoming=False)

    def trace_dependents(self, subject, depth=4):
        return self._trace(subject, depth, incoming=True)

    def explain_connection(self, source, target, depth=4):
        depth = _bounded_integer(depth, 'Depth', 4)
        source, target = _entity_key(source), _entity_key(target)
        case = self._case()
        _, missing = self._resolve([source, target])
        if missing:
            return self._result(case, 'explain_connection', 'algo.SPpaths', [], depth=depth,
                                missing=missing, source=source, target=target)
        query = (self._access + 'MATCH (s:WorkItem:' + self.label + ' {case_id:$case_id,key:$source}),'
                 '(t:WorkItem:' + self.label + ' {case_id:$case_id,key:$target}) '
                 'CALL algo.SPpaths({sourceNode:s,targetNode:t,relTypes:["DEPENDS_ON"],'
                 'relDirection:"outgoing",weightProp:"weight",maxLen:$depth,pathCount:1}) '
                 'YIELD path,pathWeight WITH path AS p,pathWeight '
                 'WHERE ALL(n IN nodes(p) WHERE n.case_id=$case_id) '
                 'RETURN ' + _PATH + ',pathWeight AS weight ORDER BY weight,keys LIMIT 101')
        rows = self._read(query, source=source, target=target, depth=depth)
        return self._result(case, 'explain_connection', 'algo.SPpaths', rows[:MAX_PATHS],
                            depth=depth, truncated=len(rows) > MAX_PATHS, source=source, target=target)

    def rank_bottlenecks(self, limit=5):
        limit = _bounded_integer(limit, 'Limit', 40)
        case = self._case()
        query = (self._access + 'CALL algo.pageRank($label,"DEPENDS_ON") YIELD node,score '
                 'WITH node,score WHERE node.case_id=$case_id '
                 'RETURN node.id AS id,node.key AS key,node.title AS title,node.status AS status,score '
                 'ORDER BY score DESC,key LIMIT $fetch_limit')
        rows = self._read(query, label=self.label, fetch_limit=limit + 1)
        result = self._result(case, 'rank_bottlenecks', 'algo.pageRank', rows[:limit],
                              truncated=len(rows) > limit, limit=limit)
        result['score_meaning'] = 'Dependency centrality within this project; not severity or probability.'
        return result

    def ready_assignments(self, subject, depth=4):
        depth = _bounded_integer(depth, 'Depth', 4)
        subject = _entity_key(subject)
        case = self._case()
        _, missing = self._resolve([subject])
        algorithm = 'Cypher frontier and capability paths'
        if missing:
            return self._result(case, 'ready_assignments', algorithm, [], depth=depth,
                                missing=missing, subject=subject)
        query = (self._access + 'MATCH p=(s:WorkItem:' + self.label + ' {case_id:$case_id,key:$subject})'
                 '-[:DEPENDS_ON*' + _FRONTIER_BOUNDS[depth] + ']->(w:WorkItem:' + self.label + ') '
                 'WHERE w.status="pending" AND ALL(n IN nodes(p) WHERE n.case_id=$case_id) '
                 'OPTIONAL MATCH (w)-[:DEPENDS_ON]->(pending:WorkItem {case_id:$case_id,status:"pending"}) '
                 'WITH p,w,count(pending) AS pending_count WHERE pending_count=0 '
                 'RETURN w.id AS id,w.key AS key,w.title AS title,w.status AS status,'
                 'w.capability AS capability,' + _PATH + ' ORDER BY key,hops,keys LIMIT 101')
        paths = self._read(query, subject=subject)
        truncated = len(paths) > MAX_PATHS
        by_id = {}
        for row in paths[:MAX_PATHS]:
            item = by_id.setdefault(row['id'], {field: row[field] for field in
                                              ('id', 'key', 'title', 'status', 'capability')})
            item.setdefault('agents', [])
            item.setdefault('paths', []).append({field: row[field] for field in _PATH_FIELDS})
        if by_id:
            query = (self._access + 'MATCH p=(w:WorkItem:' + self.label + ' {case_id:$case_id})'
                     '-[:REQUIRES_CAPABILITY]->(cap:Capability {case_id:$case_id})'
                     '<-[:HAS_CAPABILITY]-(agent:Agent {case_id:$case_id}) '
                     'WHERE w.id IN $ids AND ALL(n IN nodes(p) WHERE n.case_id=$case_id) '
                     'RETURN w.id AS item_id,agent.id AS id,agent.role AS role,cap.name AS capability,'
                     '[w.id,cap.id,agent.id] AS ids,[w.key,cap.name,agent.role] AS keys,'
                     '[w.title,cap.name,agent.role] AS titles,'
                     '[r IN relationships(p) | type(r)] AS relationship_types,length(p) AS hops '
                     'ORDER BY item_id,role,id LIMIT 101')
            assignments = self._read(query, ids=list(by_id))
            truncated = truncated or len(assignments) > MAX_PATHS
            for row in assignments[:MAX_PATHS]:
                by_id[row['item_id']]['agents'].append({key: value for key, value in row.items() if key != 'item_id'})
        result = self._result(case, 'ready_assignments', algorithm, list(by_id.values()),
                              depth=depth, truncated=truncated, subject=subject)
        result['unassigned_keys'] = [row['key'] for row in result['rows'] if not row['agents']]
        if result['unassigned_keys']:
            result['summary'] += ' Some work items have no observed capable agent.'
        return result
