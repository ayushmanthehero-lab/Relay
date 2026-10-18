'use strict';

// A presentation projection of authorized graph records, never a new source of truth.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayWorkflowProjection = api;
})(typeof window === 'object' ? window : null, function () {
  const array = value => Array.isArray(value) ? value : [];
  const props = node => node?.properties || {};
  const type = node => ({WorkSession:'Session',TaskReview:'Review',TaskDecision:'Decision',TaskEvidence:'Evidence',ExecutionArtifact:'Artifact'})[node?.type] || node?.type;
  const caseId = node => node?.case_id || props(node).case_id || (type(node) === 'Case' ? node.id : '');
  const newer = (a,b) => Number(props(a).created_at || 0) - Number(props(b).created_at || 0) || String(a?.id || '').localeCompare(String(b?.id || ''));
  function index(data) {
    const nodes=array(data?.nodes), edges=array(data?.edges), byId=new Map(nodes.map(node=>[node.id,node]));
    const sessions=nodes.filter(node=>type(node)==='Session').sort(newer);
    const sessionJobs=new Map(), jobSessions=new Map();
    edges.forEach(edge=>{
      if(edge.type!=='WORKED_ON' || type(byId.get(edge.source))!=='Session' || type(byId.get(edge.target))!=='Job')return;
      if(!sessionJobs.has(edge.source))sessionJobs.set(edge.source,new Set());
      if(!jobSessions.has(edge.target))jobSessions.set(edge.target,[]);
      sessionJobs.get(edge.source).add(edge.target); jobSessions.get(edge.target).push(byId.get(edge.source));
    });
    jobSessions.forEach(items=>items.sort(newer));
    return {nodes,edges,byId,sessions,sessionJobs,jobSessions};
  }
  function decorate(node, job, session, workItem, byId) {
    const agent=byId.get(props(job).agent_id), p=props(node);
    return {...node,properties:{...p,
      flow_agent:props(job).agent || props(agent).role || props(agent).name || p.agent || props(workItem).execution_agent || '',
      flow_agent_id:props(job).agent_id || '', flow_job_id:job?.id || '',
      flow_session_id:session?.id || '', flow_session_title:session?.label || props(session).title || '',
      flow_session_ordinal:props(session).ordinal ?? null,
      flow_project_revision:props(job).project_revision ?? p.graph_revision ?? null,
      flow_work_item_id:workItem?.id || p.work_item_id || '',
    }};
  }
  function hasPath(edges,source,target,ignored) {
    const seen=new Set([source]), queue=[source];
    while(queue.length){const id=queue.shift();for(const edge of edges){
      if(edge===ignored || edge.source!==id)continue;
      if(edge.target===target)return true;
      if(!seen.has(edge.target)){seen.add(edge.target);queue.push(edge.target);}
    }}
    return false;
  }
  function workflow(data,sessionFilter='') {
    const ctx=index(data), {nodes,edges,byId,sessions,jobSessions,sessionJobs}=ctx;
    const selected=[], groups=[], chosenJobs=new Map(), allCases=nodes.filter(node=>type(node)==='Case');
    const ids=[...new Set([...allCases.map(node=>node.id),...nodes.map(caseId).filter(Boolean)])];
    for(const cid of ids) {
      const caseNode=byId.get(cid), caseProps=props(caseNode), items=nodes.filter(node=>type(node)==='WorkItem' && caseId(node)===cid);
      const caseSessions=sessions.filter(node=>caseId(node)===cid);
      if(sessionFilter && sessionFilter!=='__all__' && !caseSessions.some(node=>node.id===sessionFilter))continue;
      if(items.length) {
        const jobs=nodes.filter(node=>type(node)==='Job' && caseId(node)===cid && props(node).kind==='execution');
        const candidates=[];
        jobs.forEach(job=>{
          const task=byId.get(props(job).task_id) || byId.get(edges.find(edge=>edge.source===job.id && edge.type==='EXECUTES')?.target);
          if(!task || type(task)!=='Task')return;
          const wid=props(job).work_item_id || props(task).work_item_id || edges.find(edge=>edge.source===task.id && edge.type==='IMPLEMENTS')?.target;
          const workItem=byId.get(wid); if(!workItem || caseId(workItem)!==cid)return;
          const associated=jobSessions.get(job.id) || [];
          if(!associated.length)candidates.push({job,task,workItem,session:null});
          else associated.forEach(session=>candidates.push({job,task,workItem,session}));
        });
        const filters=sessionFilter==='__all__' ? caseSessions.map(session=>session.id) : [sessionFilter];
        for(const filter of filters) {
          const mapping=new Map();
          for(const workItem of items) {
            const relevant=candidates.filter(candidate=>candidate.workItem.id===workItem.id && (filter ? candidate.session?.id===filter : !caseProps.execution_run_id || props(candidate.job).run_id===caseProps.execution_run_id));
            relevant.sort((a,b)=>newer(a.job,b.job) || newer(a.task,b.task));
            let chosen=relevant[relevant.length-1];
            if(!filter) {
              const currentId=props(workItem).execution_task_id;
              const exact=relevant.find(candidate=>candidate.task.id===currentId);
              if(exact)chosen=exact;
              else if(currentId && !chosen) {
                const task=byId.get(currentId);
                const recordedElsewhere=candidates.some(candidate=>candidate.task.id===currentId);
                if(task && type(task)==='Task' && caseId(task)===cid && !recordedElsewhere)chosen={task,workItem,job:null,session:null};
              }
            }
            if(!chosen && filter)continue;
            const projected=decorate(chosen?.task || workItem,chosen?.job,chosen?.session,workItem,byId);
            selected.push(projected); mapping.set(workItem.id,projected.id);
            if(chosen?.job)chosenJobs.set(chosen.job.id,projected.id);
          }
          groups.push({case_id:cid,session_id:filter || '',mapping});
        }
      } else {
        // Support cases have planned tasks, not executable WorkItems. Only one-hop
        // session membership is relevant; carrying a task does not pull in its history.
        const current=byId.get(caseProps.current_session_id) || caseSessions[caseSessions.length-1];
        const relevantSessions=sessionFilter==='__all__' ? caseSessions : sessionFilter ? caseSessions.filter(session=>session.id===sessionFilter) : current ? [current] : [];
        const added=new Set();
        relevantSessions.forEach(session=>{
          const sessionJobIds=sessionJobs.get(session.id) || new Set(), taskJobs=new Map();
          edges.forEach(edge=>{if(sessionJobIds.has(edge.source) && ['PLANNED','EXECUTES'].includes(edge.type) && type(byId.get(edge.target))==='Task')taskJobs.set(edge.target,byId.get(edge.source));});
          edges.forEach(edge=>{if(edge.source===session.id && edge.type==='CARRIED_FORWARD' && type(byId.get(edge.target))==='Task' && props(byId.get(edge.target)).status!=='done' && !taskJobs.has(edge.target))taskJobs.set(edge.target,null);});
          taskJobs.forEach((job,tid)=>{const task=byId.get(tid); if(caseId(task)!==cid || added.has(tid))return; added.add(tid);selected.push(decorate(task,job,session,null,byId));if(job)chosenJobs.set(job.id,tid);});
        });
        if(!relevantSessions.length && !sessionFilter)nodes.filter(node=>type(node)==='Task' && caseId(node)===cid).forEach(task=>selected.push(decorate(task,null,null,null,byId)));
      }
    }
    const unique=new Map(); selected.forEach(node=>unique.set(node.id,node));
    const shown=[...unique.values()], shownIds=new Set(unique.keys()), projectedEdges=[];
    groups.forEach(group=>edges.forEach(edge=>{
      if(edge.type!=='DEPENDS_ON' || !group.mapping.has(edge.source) || !group.mapping.has(edge.target))return;
      const currentRevision=props(byId.get(group.case_id)).project_revision;
      const matchesCurrentGraph=node=>type(node)==='WorkItem' || (currentRevision!=null && props(node).flow_project_revision!=null && String(props(node).flow_project_revision)===String(currentRevision));
      // DEPENDS_ON describes today's project graph. Older runs can retain their
      // actual recorded handoffs below, but must not inherit later graph edits.
      if(!matchesCurrentGraph(unique.get(group.mapping.get(edge.source))) || !matchesCurrentGraph(unique.get(group.mapping.get(edge.target))))return;
      projectedEdges.push({id:'flow:'+group.case_id+':'+group.session_id+':'+edge.id,source:group.mapping.get(edge.target),target:group.mapping.get(edge.source),type:'REQUIRED_BY',label:'prerequisite output',original_type:edge.type,original_source:edge.source,original_target:edge.target,evidence_ids:[edge.id]});
    }));
    edges.forEach(edge=>{
      if(edge.type==='NEXT_TASK' && shownIds.has(edge.source) && shownIds.has(edge.target)
        && !props(unique.get(edge.source)).flow_work_item_id && !props(unique.get(edge.target)).flow_work_item_id)projectedEdges.push({...edge});
    });
    const handoffs=edges.filter(edge=>edge.type==='HANDOFF_TO' && chosenJobs.has(edge.source) && chosenJobs.has(edge.target));
    const handoffEdges=handoffs.map(edge=>({...edge,id:'flow:'+edge.id,source:chosenJobs.get(edge.source),target:chosenJobs.get(edge.target),evidence_ids:[edge.id],original_source:edge.source,original_target:edge.target})).filter(edge=>edge.source!==edge.target);
    // Direct task prerequisites already explain transitive transfers. A genuine
    // handoff is drawn only when no dependency or other handoff explains that path.
    handoffEdges.forEach(edge=>{if(!hasPath(projectedEdges,edge.source,edge.target) && !hasPath(handoffEdges,edge.source,edge.target,edge))projectedEdges.push(edge);});
    const usedSessionIds=new Set(shown.map(node=>props(node).flow_session_id).filter(Boolean));
    const outputIds=new Set(shown.map(node=>props(node).output_artifact_id || props(node).current_artifact_id).filter(id=>id && byId.has(id)));
    return {nodes:shown,edges:projectedEdges,sessions,activeSessions:sessions.filter(node=>usedSessionIds.has(node.id)),groups:groups.map(({mapping,...group})=>({...group,task_ids:[...mapping.values()]})),
      hiddenRecordCount:Math.max(0,nodes.length-shown.length),hiddenEdgeCount:Math.max(0,edges.length-projectedEdges.length),handoffCount:handoffs.length,outputCount:outputIds.size,selectedSession:sessionFilter,truncated:!!data?.truncated};
  }
  function evidence(data,focusId,highlightIds=[]) {
    const {nodes,edges,byId,sessions}=index(data), focus=byId.get(focusId), keep=new Set();
    const limit=24;
    if(focus)keep.add(focus.id);
    array(highlightIds).forEach(id=>{if(byId.has(id))keep.add(id);});
    // An explicitly requested path stays intact, even if the path itself exceeds
    // the usual detail limit. Ordinary neighborhood expansion is always bounded.
    const effectiveLimit=Math.max(limit,keep.size);
    if(focus) {
      const priority={Task:0,Artifact:1,Review:2,Decision:3,Evidence:4,Job:5,Agent:6,Session:7,Handoff:8,Memory:9};
      const adjacent=edges.filter(edge=>edge.source===focus.id || edge.target===focus.id).map(edge=>byId.get(edge.source===focus.id?edge.target:edge.source)).filter(node=>node && type(node)!=='Case');
      adjacent.sort((a,b)=>(priority[type(a)]??10)-(priority[type(b)]??10) || newer(b,a));
      for(const node of adjacent){if(keep.size>=effectiveLimit)break;keep.add(node.id);}
    }
    const shown=nodes.filter(node=>keep.has(node.id)), shownEdges=edges.filter(edge=>keep.has(edge.source) && keep.has(edge.target));
    return {nodes:shown,edges:shownEdges,sessions,hiddenRecordCount:Math.max(0,nodes.length-shown.length),hiddenEdgeCount:Math.max(0,edges.length-shownEdges.length),focusId,highlightIds:array(highlightIds).filter(id=>keep.has(id)),limit:effectiveLimit,truncated:!!data?.truncated};
  }
  return {workflow,evidence};
});
