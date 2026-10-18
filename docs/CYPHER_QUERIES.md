# Cypher queries and graph algorithms

These are the graph operations that control Relay's behavior. Their executable implementations are linked below. Runtime values are passed as parameters through the official FalkorDB Python client. The application resolves tenant and case access before these operations; the model selects an allowlisted MCP tool and arguments, not arbitrary Cypher.

For inspection, open FalkorDB Browser at http://127.0.0.1:3002 and select the authorized tenant's `relay_support_<tenant>` graph. Useful read-only discovery queries are:

```cypher
MATCH (p:Project)
RETURN p.id, p.title, p.case_id, p.current_plan_id, p.revision;
```

```cypher
MATCH (c:Case)-[:HAS_ITEM]->(w:WorkItem)
RETURN c.id, c.title, w.key, w.title, w.execution_status;
```

Application authorization is not applied when an administrator connects directly to the database Browser. Do not expose that connection to end users. The larger examples below require the indicated parameters; mutation excerpts explain guards and are not replacements for the complete application transaction.

## 1. Select a ready task and capable agent

**Product dependency:** this result selects the actual job, agent and input artifacts. An AI cannot skip graph prerequisites or task-start consent.

Source: [`ExecutionStore.schedule`](../relay_app/execution_store.py). Before the query, the service authorizes the case, checks source/current-artifact validity, rejects unsupported tools and permits only one active job per case.

```cypher
MATCH (c:Case {id:$cid})-[:HAS_ITEM]->(w:WorkItem),
      (w)-[:REQUIRES_CAPABILITY]->(cap:Capability)
         <-[:HAS_CAPABILITY]-(agent:Agent {case_id:$cid,status:"available"})
WHERE coalesce(w.execution_status,"") <> "succeeded"
  AND cap.name IN $supported
  AND (
    coalesce(c.project_start_required,false)=false OR
    (w.start_approval_id<>""
     AND w.start_approved_generation=c.execution_generation
     AND w.start_approved_graph_revision=c.project_revision
     AND w.start_approved_memory_revision=c.memory_revision)
  )
OPTIONAL MATCH (w)-[:DEPENDS_ON*1..40]->(dependency:WorkItem {case_id:$cid})
WITH c,w,agent,collect(DISTINCT dependency) AS prerequisites
WHERE ALL(d IN prerequisites WHERE
  d.execution_status="succeeded"
  AND d.execution_graph_revision=c.project_revision
  AND d.current_artifact_id<>"")
RETURN w, agent, size(prerequisites) AS distance,
       [d IN prerequisites | d.current_artifact_id] AS input_ids,
       [] AS paths
ORDER BY distance,w.key,agent.name
LIMIT 1
```

`$cid` is an authorized case ID. `$supported` is the server's installed capability list. The 40-hop bound covers a validated plan of at most 40 nodes. A separate conditional write rechecks case revision, approval and absence of active jobs before publishing the selected job, task and handoffs. `input_ids` identifies actual stored artifacts; they are not guessed filenames.

## 2. Trace distant blockers and affected work

**Product dependency:** recovery agents return exact multi-hop evidence rather than a flattened task list.

Source: [`RecoveryQueries.trace_blockers` and `trace_dependents`](../relay_app/recovery_queries.py).

```cypher
MATCH (c:Case {id:$case_id})
WHERE c.visibility="team" OR c.owner=$actor
WITH c
MATCH p=(s:WorkItem {case_id:$case_id,key:$subject})
        -[:DEPENDS_ON*1..4]->(w:WorkItem)
WHERE ALL(n IN nodes(p) WHERE n.case_id=$case_id)
  AND w.status="pending"
RETURN [n IN nodes(p) | n.id] AS ids,
       [n IN nodes(p) | n.key] AS keys,
       [n IN nodes(p) | n.title] AS titles,
       [r IN relationships(p) | type(r)] AS relationship_types,
       length(p) AS hops
ORDER BY hops,keys
LIMIT 101
```

This readable form omits the additional server-derived project label applied to both work-item endpoints in the source. The implementation chooses the literal bound from an authored whitelist (`1..1` through `1..4`); raw user text is never interpolated. Reverse the traversal direction for dependent impact. The service returns at most 100 paths, marking a 101st result as truncation. Missing work-item keys are distinguished from no relationship found within the bound.

A four-hop chain may find the requirements blocker behind `release → tests → page → contract → requirements` that a depth-one query cannot reach. The returned paths explain the result.

## 3. Explain a connection with native shortest path

**Product dependency:** the `explain_connection` MCP tool explains why two tasks are linked using FalkorDB's native algorithm.

Source: [`RecoveryQueries.explain_connection`](../relay_app/recovery_queries.py).

```cypher
MATCH (c:Case {id:$case_id})
WHERE c.visibility="team" OR c.owner=$actor
WITH c
MATCH (s:WorkItem {case_id:$case_id,key:$source}),
      (t:WorkItem {case_id:$case_id,key:$target})
CALL algo.SPpaths({
  sourceNode:s,
  targetNode:t,
  relTypes:["DEPENDS_ON"],
  relDirection:"outgoing",
  weightProp:"weight",
  maxLen:$depth,
  pathCount:1
})
YIELD path,pathWeight
WITH path AS p,pathWeight
WHERE ALL(n IN nodes(p) WHERE n.case_id=$case_id)
RETURN [n IN nodes(p) | n.id] AS ids,
       [n IN nodes(p) | n.key] AS keys,
       length(p) AS hops,
       pathWeight AS weight
ORDER BY weight,keys
LIMIT 101
```

The runtime also applies the server-derived project label to the endpoints and returns titles and relationship types. `$depth` is a validated integer from 1 to 4. Recovery edges have positive weights; imported project dependencies use weight 1.

## 4. Rank dependency bottlenecks with native PageRank

**Product dependency:** the `rank_bottlenecks` tool prioritizes central prerequisites inside one authorized project's topology.

Source: [`RecoveryQueries.rank_bottlenecks`](../relay_app/recovery_queries.py).

```cypher
MATCH (c:Case {id:$case_id})
WHERE c.visibility="team" OR c.owner=$actor
WITH c
CALL algo.pageRank($label,"DEPENDS_ON") YIELD node,score
WITH node,score
WHERE node.case_id=$case_id
RETURN node.id AS id,node.key AS key,node.title AS title,
       node.status AS status,score
ORDER BY score DESC,key
LIMIT $fetch_limit
```

`$label` is `Recovery_` plus the first 24 hex characters of SHA-256(case ID), generated by `project_label()` and applied to that case's work items. It is never supplied by the model. `$fetch_limit` is the bounded requested limit plus one to detect truncation. The score means dependency centrality, not failure probability, severity or business priority.

`ready_assignments` additionally computes a pending-task frontier and returns explicit `WorkItem → Capability ← Agent` paths. It is an investigative assignment recommendation; actual task execution still uses the stronger output/approval checks in query 1.

## 5. Recall current, scoped memory

**Product dependency:** an agent receives current facts and approved procedures, with dated evidence and historical versions retained separately.

Sources: [`SupportService` retrieval and context](../relay_app/support_service.py), [`MemoryKnowledge.recall`](../relay_app/knowledge.py).

```cypher
CALL db.idx.fulltext.queryNodes("Memory",$fulltext) YIELD node,score
WITH node AS m,score
WHERE m.current=true
  AND (m.kind<>"procedural" OR m.approved=true)
  AND (m.visibility="team" OR ($private AND m.owner=$owner))
RETURN m,score
ORDER BY score DESC
LIMIT $limit
```

Topic expansion uses the same current/approved/scope constraints:

```cypher
MATCH (m:Memory)-[:ABOUT]->(t:Topic {id:$topic})
WHERE m.current=true
  AND (m.kind<>"procedural" OR m.approved=true)
  AND (m.visibility="team" OR ($private AND m.owner=$owner))
RETURN m
ORDER BY m.created_at DESC
LIMIT $limit
```

Every referenced native episode must also remain eligible:

```cypher
MATCH (e:Episode)
WHERE e.id IN $ids
  AND coalesce(e.knowledge_current,true)=true
  AND (e.visibility="team" OR ($private AND e.owner=$owner))
RETURN e.id AS id
```

The server supplies scope from the case and authenticated principal. Retired evidence is excluded from new guidance. Graphiti adds hybrid semantic/full-text retrieval through its SDK, storing vectors and extracted facts in FalkorDB itself. Relay checks temporal validity, completed ingestion receipts and native episode eligibility before using recalled facts. It does not accept an unacknowledged or stale derived fact merely because a vector search returned it.

## 6. Claim work and reject obsolete results

**Product dependency:** several workers may read/compute concurrently, but an expired worker cannot overwrite newer case state.

Sources: [`SupportService.claim`](../relay_app/support_service.py), [`execution_runner.py`](../relay_app/execution_runner.py), [`recovery_runner.py`](../relay_app/recovery_runner.py).

A representative execution publication begins with this guard:

```cypher
MATCH (c:Case {
        id:$cid,revision:$revision,
        project_revision:$project_revision,memory_revision:$memory_revision
      })-[:HAS_JOB]->(j:Job {id:$jid,token:$token,status:"running"}),
      (t:Task {id:$tid,revision:$task_revision,case_id:$cid}),
      (w:WorkItem {id:$wid,case_id:$cid})
WHERE j.lease_until>$now
  AND c.workflow_status<>"paused"
  AND c.resolution_status="open"
```

This is only the opening predicate of the actual atomic commit. The full statement also matches agent, session and tool call; checks all memory versions, eligible sources and current prerequisite artifacts; then creates the output, episode, memory, review and relationships and marks the job/handoffs. A missing guard match produces no new artifact. The model call occurs before this statement, outside database locks.

The support workflow additionally captures and checks `Gate.epoch`; Graphiti indexing uses a scoped durable lease and separate acknowledgement. A crash can repeat inference or SDK ingestion, but it does not authorize a stale native result to become current.

## 7. Inspect actual agent output and consumed handoffs

**Product dependency:** the UI exposes who produced an output, which session it came from, and exactly what another agent received.

Sources: [`ExecutionStore`](../relay_app/execution_store.py), [`execution_runner.py`](../relay_app/execution_runner.py).

```cypher
MATCH (c:Case {id:$cid})-[:HAS_EXECUTION_ARTIFACT]->(a:ExecutionArtifact),
      (agent:Agent)-[:PRODUCED]->(a),
      (session:WorkSession)-[:CONTAINS]->(a)
WHERE c.visibility="team" OR c.owner=$actor
RETURN a.id,a.summary,a.files,a.checks,agent.role,session.id,a.created_at
ORDER BY a.created_at
```

```cypher
MATCH (c:Case {id:$cid})-[:HAS_HANDOFF]->(h:Handoff)-[:CARRIES]->(a:ExecutionArtifact)
WHERE c.visibility="team" OR c.owner=$actor
OPTIONAL MATCH (receiver:Job)-[:CONSUMED]->(h)
RETURN h.from_agent,h.to_agent,h.status,a.id,receiver.id,h.consumed_session_id
ORDER BY h.created_at
```

These read-only inspection forms follow relationships created by the runtime. They do not treat a UI arrow as evidence of a handoff.

## 8. Human completion is a conditional decision

**Product dependency:** neither a successful executor nor its AI reviewer can record human completion approval.

Sources: [`support_flow.py`](../relay_app/support_flow.py), [`ExecutionStore.decide`](../relay_app/execution_store.py).

The current task-review guard starts with:

```cypher
MATCH (g:Gate {id:"memory"}),
      (c:Case {id:$cid,revision:$case_revision})-[:HAS_TASK]->
        (t:Task {id:$tid,revision:$revision,current_review_id:$rid}),
      (c)-[:HAS_REVIEW]->(r:TaskReview {id:$rid,status:"pending"})
WHERE (c.visibility="team" OR c.owner=$actor)
  AND g.epoch=$epoch
```

The full decision statement checks source eligibility and indexing state before creating the actor-attributed `TaskDecision`. The execution path also binds the exact current output and revisions. Repeated identical requests return their stored result; competing or stale decisions cannot both satisfy the same current-review predicate.

Start consent is separate: [`ProjectStore.start`](../relay_app/project_store.py) records `ProjectStartApproval → AUTHORIZES → WorkItem` against the current project, plan and graph/memory generation. Plan import is not this approval.

## Why removing FalkorDB breaks the product

The scheduler cannot find eligible work without query 1; agents cannot recover evidence without queries 5–7; safe claims and approvals require guarded graph writes. Graph algorithms also operate directly on the saved dependency topology. There is no local task queue, conversation database, separate vector store or diagram-only substitute. The API fails closed with HTTP 503 when its authoritative graph is unavailable.
