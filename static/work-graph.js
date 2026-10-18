'use strict';

// The API owns graph visibility and decisions. Canvas only draws its saved records.
window.RelayWorkGraph = (() => {
  const byId = key => document.getElementById(key);
  const arr = value => Array.isArray(value) ? value : [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const svg = key => '<svg aria-hidden="true"><use href="#i-' + key + '"/></svg>';
  const colors = {pending:'#82938b',progress:'#527dc4',reported:'#6f729c',approved:'#268267',review:'#b78b39',error:'#b75e53'};
  const fills = {pending:'#eff3ef',progress:'#eaf0fc',reported:'#f0eef7',approved:'#e8f6ec',review:'#fff4da',error:'#fceceb'};
  const types = {Case:'Case',Session:'Work session',WorkSession:'Work session',Job:'Agent work',Task:'Task',Review:'AI review',TaskReview:'AI review',Decision:'Human decision',TaskDecision:'Human decision',Evidence:'Evidence',TaskEvidence:'Evidence',Artifact:'Saved result',Handoff:'Handoff',WorkItem:'Project work item',Agent:'Agent',ToolCall:'MCP tool call',Finding:'Saved finding',RecoveryAction:'Recovery action',Memory:'Memory',Capability:'Agent capability'};
  const icons = {Case:'inbox',Session:'clock',WorkSession:'clock',Job:'spark',Task:'list',Review:'search',TaskReview:'search',Decision:'check',TaskDecision:'check',Evidence:'source',TaskEvidence:'source',Artifact:'source',Handoff:'arrow',WorkItem:'list',Agent:'people',ToolCall:'activity',Finding:'source',RecoveryAction:'check',Memory:'book',Capability:'spark'};
  let payload = null, visible = {nodes:[],edges:[]}, selectedNode = null, caseFilter = '', sessionFilter = '';
  let generation = 0, activeRequest = null, canvasReady = null, canvasStarted = false, drawnFingerprint = '', inspectorFingerprint = '';
  let numericId = 0, selectionWanted = null, forceFit = true, inspectorNodeId = null;
  let graphLayout = 'tree', graphMode = '';
  let firstScope = true, workflowPlan = null, rendererMode = '', workflowNarrow = false;
  const numericIds = new Map(), fieldDrafts = new Map(), actionRequests = new Map(), pending = new Set();
  let highlightedPath = [];
  const properties = node => node?.properties || {};
  const canonicalType = node => ({WorkSession:'Session',TaskReview:'Review',TaskDecision:'Decision',TaskEvidence:'Evidence',ExecutionArtifact:'Artifact'})[node?.type] || node?.type || 'Record';
  const currentNode = () => visible.nodes.find(node => node.id === selectedNode) || payload?.nodes.find(node => node.id === selectedNode);
  const label = node => canonicalType(node) === 'Review' ? 'AI review: ' + ({ready:'ready',not_ready:'keep working',needs_evidence:'needs evidence'}[properties(node).verdict] || 'evidence check') : node.label || properties(node).title || properties(node).name || types[node.type] || node.type;
  const currentCase = node => node.case_id || properties(node).case_id || (canonicalType(node) === 'Case' ? node.id : '');
  function status(node) {
    const p = properties(node), type = canonicalType(node), raw = node.status || p.status || '';
    if (type === 'WorkItem') {
      if (raw === 'done' && (p.approval_status === 'approved' || p.approval_id)) return {key:'approved',label:'Approved complete'};
      if (raw === 'done') return {key:'reported',label:'Human marked complete'};
      if (['succeeded','completed'].includes(p.execution_status)) return {key:'review',label:'Output ready · approval pending'};
      if (p.execution_status === 'running') return {key:'progress',label:'Agent working'};
      if (['failed','blocked'].includes(p.execution_status)) return {key:'error',label:'Execution needs attention'};
      return {key:'pending',label:p.execution_status === 'queued' ? 'Agent queued' : 'To do'};
    }
    if (type === 'Case' && p.kind === 'recovery' && raw === 'ready' && p.phase === 'Scout') return {key:'pending',label:'Ready to begin'};
    if (type === 'ToolCall' && raw === 'succeeded') return {key:'reported',label:'Tool call succeeded'};
    if (type === 'Artifact' && typeof p.passed === 'boolean') return {key:p.current === false ? 'pending' : p.passed ? 'reported' : 'error',label:p.current === false ? 'Historical output' : p.passed ? 'Validated output' : 'Validation failed'};
    if (type === 'Handoff' && raw === 'consumed') return {key:'reported',label:'Handoff consumed'};
    if (type === 'Task') {
      if (raw === 'done' && (p.approval_status === 'approved' || p.completion_basis === 'reviewed_approval')) return {key:'approved',label:'Approved complete'};
      if (raw === 'done' || p.approval_status === 'reported_complete') return {key:'reported',label:'Reported complete'};
      if (p.latest_review?.status === 'pending') return {key:'review',label:p.latest_review.review_current === false ? 'Needs fresh review' : p.execution_status === 'succeeded' ? 'Executed · approval pending' : 'Your decision next'};
      if (p.execution_status === 'succeeded') return {key:'review',label:'Output ready · review next'};
      if (p.execution_status === 'running') return {key:'progress',label:'Agent working'};
      if (raw === 'doing') return {key:'progress',label:'In progress'};
      return {key:'pending',label:'To do'};
    }
    if (type === 'Review') return {key:p.status === 'decided' ? 'reported' : 'review',label:p.status === 'decided' ? 'Decision recorded' : p.review_current === false ? 'Review outdated' : 'Needs your decision'};
    if (type === 'Decision') return {key:p.decision === 'approve' || raw === 'approved' ? 'approved' : 'review',label:p.decision === 'approve' || raw === 'approved' ? 'Approved' : 'Kept open'};
    if (type === 'Session') return {key:raw === 'active' ? 'progress' : 'reported',label:raw === 'active' ? 'Active session' : 'Closed session'};
    if (['error','failed','blocked'].includes(raw)) return {key:'error',label:'Needs attention'};
    if (['running','doing','active'].includes(raw)) return {key:'progress',label:'In progress'};
    if (['completed','done','ready','resolved'].includes(raw) || p.resolution_status === 'resolved') return {key:'reported',label:type === 'Case' ? (p.resolution_status === 'resolved' ? 'Outcome recorded' : 'Ready for review') : 'Result saved'};
    if (raw === 'paused') return {key:'pending',label:'Paused'};
    return {key:'pending',label:raw ? raw.replaceAll('_',' ') : type === 'Evidence' ? 'Recorded evidence' : 'Pending'};
  }
  function badge(node) {
    const value = status(node);
    return '<span class="flow-state"><i class="flow-dot" style="--flow-color:' + colors[value.key] + '"></i>' + escape(value.label) + '</span>';
  }
  function setHTML(target, content) {
    const element = byId(target);
    if (element && element.dataset.graphRendered !== content) { element.innerHTML = content; element.dataset.graphRendered = content; }
  }
  function error(target, message) { const el = byId(target); if (el) { el.hidden = !message; el.textContent = message || ''; } }
  function displayDate(value) { return typeof date === 'function' ? date(value,true) || 'Not recorded' : String(value || 'Not recorded'); }
  function stableId(value) { if (!numericIds.has(value)) numericIds.set(value, ++numericId); return numericIds.get(value); }
  function requests(key, body) {
    const content = JSON.stringify(body), saved = actionRequests.get(key);
    if (saved?.content === content) return saved.id;
    const record = {content,id:crypto.randomUUID()}; actionRequests.set(key,record); return record.id;
  }
  function draftFor(node) {
    if (!fieldDrafts.has(node.id)) fieldDrafts.set(node.id,{evidence:properties(node).latest_review?.submitted_evidence || properties(node).evidence || '',reason:''});
    return fieldDrafts.get(node.id);
  }
  function syncDraft() {
    if (!inspectorNodeId || !byId('graph-task-evidence')) return;
    const draft = fieldDrafts.get(inspectorNodeId) || {evidence:'',reason:''};
    fieldDrafts.set(inspectorNodeId,draft); draft.evidence = byId('graph-task-evidence').value;
    if (byId('graph-decision-reason')) draft.reason = byId('graph-decision-reason').value;
  }
  function busyControls() {
    const node = currentNode(); if (!node) return;
    const busy = pending.has(node.id);
    byId('graph-inspector').querySelectorAll('[data-graph-operation]').forEach(button => { button.disabled = busy; button.setAttribute('aria-busy',String(busy)); });
    const review = properties(node).latest_review;
    const edited = review && String(review.submitted_evidence || '').trim() !== String(byId('graph-task-evidence')?.value || '').trim();
    const canDecide = review && review.review_current !== false && review.status !== 'decided' && !edited;
    byId('graph-inspector').querySelectorAll('[data-decision]').forEach(button => { button.disabled = busy || !canDecide; });
    if (byId('graph-review-edited')) byId('graph-review-edited').hidden = !edited;
  }
  function updateFilters() {
    const cases = arr(state?.cases);
    if (caseFilter && !cases.some(item => item.id === caseFilter)) caseFilter = '';
    setHTML('graph-case-filter','<option value="">All cases in this workspace</option>' + cases.map(item => '<option value="' + escape(item.id) + '">' + escape(item.title) + (item.visibility === 'private' ? ' · Private' : '') + '</option>').join(''));
    byId('graph-case-filter').value = caseFilter;
    const sessions = arr(payload?.nodes).filter(node => canonicalType(node) === 'Session');
    if (sessionFilter && sessionFilter !== '__all__' && !sessions.some(node => node.id === sessionFilter)) sessionFilter = '';
    sessions.sort((a,b) => (properties(a).created_at || 0) - (properties(b).created_at || 0));
    setHTML('graph-session-filter','<option value="">Current work</option><option value="__all__">All sessions · task history</option>' + sessions.map((node,index) => '<option value="' + escape(node.id) + '">Session ' + (properties(node).ordinal || index + 1) + ' · ' + escape(label(node)) + '</option>').join(''));
    byId('graph-session-filter').value = sessionFilter;
    byId('graph-new-session').disabled = !cases.some(item => item.resolution_status !== 'resolved');
  }
  function sessionView(data, filter) {
    if (!filter) return {nodes:arr(data?.nodes),edges:arr(data?.edges)};
    const allNodes = arr(data.nodes), allEdges = arr(data.edges), selected = allNodes.find(node => node.id === filter);
    if (!selected) return {nodes:[],edges:[]};
    const keep = new Set([filter]), allowed = new Set(['WORKED_ON','CARRIED_FORWARD','PLANNED','HAS_REVIEW','HAS_DECISION','USES_EVIDENCE','CONTAINS','EXECUTED','ABOUT','PRODUCED','CARRIES','USED_MEMORY','USED_INPUT','RECOVERS','ASSIGNED_TO','DEPENDS_ON','HANDOFF_TO','HAS_FINDING','HAS_ACTION']);
    let added = true;
    while (added) {
      added = false;
      allEdges.forEach(edge => { if (allowed.has(edge.type) && keep.has(edge.source) && !keep.has(edge.target)) { keep.add(edge.target); added = true; } });
    }
    if (currentCase(selected)) keep.add(currentCase(selected));
    return {nodes:allNodes.filter(node => keep.has(node.id)),edges:allEdges.filter(edge => keep.has(edge.source) && keep.has(edge.target))};
  }
  function projectView(data) {
    const nodes = arr(data?.nodes).filter(node => canonicalType(node) === 'WorkItem');
    const ids = new Set(nodes.map(node => node.id));
    return {nodes,edges:arr(data?.edges).filter(edge => edge.type === 'DEPENDS_ON' && ids.has(edge.source) && ids.has(edge.target))};
  }
  function defaultMode(data) {
    return arr(data?.nodes).some(node => canonicalType(node) === 'WorkItem') && !arr(data?.nodes).some(node => canonicalType(node) === 'Case' && properties(node).kind !== 'recovery') ? 'project' : 'workflow';
  }
  function fitCurrentGraph(duration = 250) {
    const instance = byId('work-canvas').getGraph?.(), rect = byId('graph-stage').getBoundingClientRect();
    const nodes = arr(instance?.graphData?.()?.nodes).filter(node => Number.isFinite(node.x) && Number.isFinite(node.y));
    if (!nodes.length || rect.width <= 0 || rect.height <= 0) return;
    const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    // Read the live simulation coordinates and leave room for labels; never zoom into a tiny cluster.
    const card = graphMode === 'workflow';
    const zoom = Math.max(card ? .78 : .15,Math.min(card ? 1.15 : 1.4,(rect.width - (card ? 40 : 100)) / (right - left + (card ? 270 : 150)),(rect.height - 100) / (bottom - top + (card ? 130 : 120))));
    instance.centerAt?.((left + right) / 2,(top + bottom) / 2,duration); instance.zoom?.(zoom,duration);
  }
  function pinWorkflow() {
    if (graphMode !== 'workflow' || !workflowPlan) return;
    const graph = byId('work-canvas').getGraph?.(), data = graph?.graphData?.();
    if (!data) return;
    data.nodes.forEach(node => {
      const point = workflowPlan.positions[node.data.graph_id];
      if (point) { node.x = node.fx = point.x; node.y = node.fy = point.y; }
    });
    graph.cooldownTicks?.(0); graph.graphData(data);
  }
  function workflowEdges(data, all = false) {
    if (all) return data.edges;
    const typesById = new Map(data.nodes.map(node => [node.id,canonicalType(node)]));
    return data.edges.filter(edge => {
      if (edge.type === 'REVIEWS' || edge.type === 'DECIDES') return false;
      if (typesById.get(edge.source) !== 'Case') return true;
      const richer = {HAS_SESSION:['NEXT_SESSION'],HAS_JOB:['WORKED_ON','HANDOFF_TO'],HAS_TASK:['PLANNED','CARRIED_FORWARD'],HAS_REVIEW:['HAS_REVIEW'],HAS_EVIDENCE:['USES_EVIDENCE'],HAS_DECISION:['HAS_DECISION']};
      if (!richer[edge.type]) return true;
      return !data.edges.some(other => other.source !== edge.source && other.target === edge.target && richer[edge.type].includes(other.type));
    });
  }
  async function ensureCanvas() {
    if (canvasReady) return canvasReady;
    canvasReady = (async () => {
      await import('/static/vendor/falkordb-canvas.js');
      await customElements.whenDefined('falkordb-canvas');
      const canvas = byId('work-canvas');
      canvas.setConfig({layoutMode:'tree',layoutOptions:{tree:{direction:'lr',levelDistance:150,nodeSpacing:115}},backgroundColor:'#fafbf8',foregroundColor:'#365b49',nodeStyle:{fontFamily:'Segoe UI, sans-serif',fontSize:12,textFillRatio:0,strokeWidthUnselected:1.2,strokeWidthSelected:3},captionsKeys:['title'],largeGraph:{skipArrowsAtLowZoom:false,skipLabelsAtLowZoom:false},isNodeSelected:node => node.data.graph_id === selectedNode,eventHandlers:{onNodeClick:node => select(node.data.graph_id)}});
      // User-written titles are plain text, never tooltip HTML.
      const graph = canvas.getGraph();
      if (graph?.nodeLabel) graph.nodeLabel(node => { const el = document.createElement('span'); el.textContent = node.data?.title || ''; return el; });
      if (graph?.linkLabel) graph.linkLabel(link => { const el = document.createElement('span'); el.textContent = String(link.relationship || '').replaceAll('_',' '); return el; });
      let previousWidth = 0, resizeTimer;
      new ResizeObserver(() => {
        if (byId('view-graph').hidden) return;
        const rect = byId('graph-stage').getBoundingClientRect(), instance = canvas.getGraph?.();
        if (instance && rect.width > 0 && rect.height > 0) {
          instance.width?.(rect.width); instance.height?.(rect.height);
          if (graphMode === 'workflow' && workflowNarrow !== matchMedia('(max-width:640px)').matches) { forceFit = true; void draw(); }
          else if (previousWidth && Math.abs(previousWidth - rect.width) > .5) {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { if (!byId('view-graph').hidden) fitCurrentGraph(120); },100);
          }
          previousWidth = rect.width;
        }
      }).observe(byId('graph-stage'));
      return canvas;
    })().catch(cause => { canvasReady = null; throw cause; });
    return canvasReady;
  }
  async function draw() {
    const version = generation, allRelationships = graphMode === 'all' || byId('graph-all-links').checked, fingerprint = JSON.stringify([visible,allRelationships,graphMode]);
    setHTML('graph-render-mode','<span class="sync-dot connected"></span>' + ({project:'Project dependencies',workflow:'Task flow',all:'Focused evidence'}[graphMode] || 'Workflow view'));
    if (drawnFingerprint === fingerprint && !forceFit) return;
    try {
      const canvas = await ensureCanvas();
      if (version !== generation || byId('view-graph').hidden) return;
      const nextLayout = 'tree';
      if (nextLayout !== graphLayout) { canvas.setLayout(nextLayout); graphLayout = nextLayout; forceFit = true; }
      if (rendererMode !== graphMode) {
        canvas.setConfig(graphMode === 'workflow' ? window.RelayWorkflowCanvas.createRenderer(node => node.data.graph_id === selectedNode) : {node:undefined,link:undefined});
        rendererMode = graphMode;
      }
      if (graphMode === 'workflow') {
        workflowNarrow = matchMedia('(max-width:640px)').matches;
        workflowPlan = window.RelayWorkflowCanvas.plan(visible.nodes,visible.edges,{narrow:workflowNarrow,allSessions:sessionFilter === '__all__'});
        byId('graph-stage').style.height = Math.min(sessionFilter === '__all__' ? 6000 : 1600,Math.max(660,workflowPlan.height + 110)) + 'px';
      } else { workflowPlan = null; byId('graph-stage').style.height = ''; }
      byId('graph-stage').dataset.mode = graphMode;
      const data = {
        nodes:visible.nodes.map(node => ({id:stableId('node:' + node.id),labels:[types[node.type] || node.type],color:highlightedPath.includes(node.id) ? '#d2efcf' : fills[status(node).key],borderColor:highlightedPath.includes(node.id) ? '#17695e' : colors[status(node).key],visible:true,size:graphMode === 'workflow' ? 124 : canonicalType(node) === 'Case' ? 54 : canonicalType(node) === 'Task' ? 52 : 46,data:{graph_id:node.id,title:label(node),type:canonicalType(node),agent:properties(node).flow_agent || properties(node).execution_agent || properties(node).agent || 'Agent not assigned',statusLabel:status(node).label,statusColor:colors[status(node).key],sessionLabel:properties(node).flow_session_title || '',sessionId:properties(node).flow_session_id || '',cardWidth:246,cardHeight:112,titleFontSize:14}})),
        links:workflowEdges(visible,allRelationships).map(edge => ({id:stableId('edge:' + (edge.id || edge.source + ':' + edge.type + ':' + edge.target)),source:stableId('node:' + edge.source),target:stableId('node:' + edge.target),relationship:edge.type || edge.label,color:highlightedPath.some((nodeId,index) => nodeId === edge.source && highlightedPath[index+1] === edge.target || nodeId === edge.target && highlightedPath[index+1] === edge.source) ? '#17695e' : edge.type === 'NEXT_SESSION' || edge.type === 'NEXT_TASK' ? '#6d927d' : '#a2b8aa',visible:true,data:{graph_id:edge.id,title:edge.label || edge.type}}))
      };
      const shouldFit = forceFit || !canvasStarted;
      if (canvasStarted && !forceFit && typeof canvas.setGraphData === 'function') canvas.setGraphData(data);
      else canvas.setData(data);
      pinWorkflow();
      canvasStarted = true; forceFit = false; drawnFingerprint = fingerprint;
      const rect = byId('graph-stage').getBoundingClientRect(), graph = canvas.getGraph?.();
      graph?.enableZoomInteraction?.(graphMode !== 'workflow');
      if (rect.width > 0) { graph?.width?.(rect.width); graph?.height?.(rect.height); }
      if (shouldFit) [100,600].forEach(delay => setTimeout(() => { if (version === generation && drawnFingerprint === fingerprint && !byId('view-graph').hidden) { pinWorkflow(); fitCurrentGraph(); } },delay));
      byId('graph-loading').hidden = true;
    } catch (cause) {
      if (version === generation) { byId('graph-loading').hidden = true; error('graph-error','The visual graph could not load. The accessible record list below still shows your saved work. ' + cause.message); }
    }
  }
  function renderNodes() {
    const query = byId('graph-node-search').value.trim().toLowerCase();
    const source = graphMode === 'all' && query ? payload.nodes : visible.nodes;
    const nodes = source.filter(node => (label(node) + ' ' + (types[node.type] || node.type) + ' ' + status(node).label).toLowerCase().includes(query));
    byId('graph-node-count').textContent = '(' + visible.nodes.length + ')';
    setHTML('graph-node-list',nodes.length ? nodes.map(node => '<button type="button" class="graph-node-button' + (node.id === selectedNode ? ' selected' : '') + (highlightedPath.includes(node.id) ? ' recovery-path-selected' : '') + '" data-graph-node="' + escape(node.id) + '" data-node-type="' + escape(canonicalType(node)) + '" aria-pressed="' + (node.id === selectedNode) + '" aria-label="' + escape((types[node.type] || node.type) + ': ' + label(node) + ', ' + status(node).label) + '"><span class="node-type-icon">' + svg(icons[node.type] || 'source') + '</span><span class="graph-node-text"><strong>' + escape(label(node)) + '</strong><small>' + escape((types[node.type] || node.type) + ' · ' + status(node).label) + '</small></span><i class="flow-dot" style="--flow-color:' + colors[status(node).key] + '"></i></button>').join('') : '<div class="graph-inline-empty">' + (query ? 'No matching records.' : 'No saved work in this view yet.') + '</div>');
  }
  function relationships(node) {
    const edges = arr(payload?.edges).filter(edge => edge.source === node.id || edge.target === node.id);
    if (!edges.length) return '';
    return '<details class="graph-relationships"><summary>Saved relationships · ' + edges.length + '</summary>' + edges.map(edge => {
      const outgoing = edge.source === node.id, other = payload.nodes.find(item => item.id === (outgoing ? edge.target : edge.source));
      if (!other) return '';
      return '<button type="button" class="graph-edge-button" data-graph-node="' + escape(other.id) + '"><span>' + (outgoing ? '→' : '←') + '</span><span>' + escape(String(edge.type || edge.label).replaceAll('_',' ').toLowerCase()) + '<strong>' + escape(label(other)) + '</strong></span></button>';
    }).join('') + '</details>';
  }
  function executionContext(node) {
    if (!['Task','WorkItem'].includes(canonicalType(node))) return '';
    const p = properties(node), output = payload.nodes.find(item => item.id === (p.output_artifact_id || p.current_artifact_id));
    const outputId = output?.id, job = payload.nodes.find(item => item.id === p.flow_job_id);
    const inputs = payload.edges.filter(edge => edge.source === outputId && edge.type === 'USED_INPUT').map(edge => payload.nodes.find(item => item.id === edge.target)).filter(Boolean);
    const memories = payload.edges.filter(edge => edge.source === outputId && edge.type === 'USED_MEMORY').map(edge => payload.nodes.find(item => item.id === edge.target)).filter(Boolean);
    const handoffs = payload.nodes.filter(item => canonicalType(item) === 'Handoff' && job && [properties(item).from_job_id,properties(item).to_job_id].includes(job.id));
    const links = items => items.map(item => '<button type="button" class="graph-edge-button" data-graph-node="' + escape(item.id) + '">' + escape(label(item)) + '</button>').join('');
    return '<div class="workflow-task-context">' + (p.flow_agent ? '<span>Agent<strong>' + escape(p.flow_agent) + '</strong></span>' : '') + (p.flow_session_title ? '<span>Work session<strong>' + escape(p.flow_session_title) + '</strong></span>' : '') + '</div>' +
      (output ? '<details class="workflow-inputs"><summary>Inputs &amp; shared memory · ' + inputs.length + ' outputs, ' + memories.length + ' memories</summary>' +
        (inputs.length ? '<h3>Prerequisite outputs used</h3>' + links(inputs) : '<p>No prerequisite output was required.</p>') +
        (memories.length ? '<h3>Memory read by this agent</h3>' + links(memories) : '') +
        (handoffs.length ? '<h3>Saved handoffs</h3>' + links(handoffs) : '') + '</details>' : '');
  }
  function reviewMarkup(review) {
    if (!review) return '';
    const verdicts = {ready:'Evidence supports completion',not_ready:'Keep working',needs_evidence:'More evidence needed'};
    return '<div class="graph-review-result"><header><div><strong>AI evidence review</strong><small>' + escape(review.provider === 'demo' ? 'Scripted demo · not model inference' : String(review.provider || 'Configured AI') + ' · advisory review') + '</small></div><span class="review-verdict ' + escape(review.verdict) + '">' + escape(({ready:'Ready',not_ready:'Not ready',needs_evidence:'Needs evidence'})[review.verdict] || 'Review') + '</span></header><div class="review-body"><p><strong>' + escape(verdicts[review.verdict] || 'Review recorded') + '</strong></p><p>' + escape(review.rationale) + '</p>' + (arr(review.checks).length ? '<ul class="review-checks">' + arr(review.checks).map(check => '<li><div><span class="check-verdict ' + escape(check.verdict) + '" aria-label="' + escape(check.verdict) + '">' + (check.verdict === 'pass' ? '✓' : check.verdict === 'fail' ? '×' : '?') + '</span><strong>' + escape(check.criterion) + '</strong></div><p>' + escape(check.evidence || 'No supporting evidence recorded.') + '</p></li>').join('') + '</ul>' : '') + (arr(review.missing_evidence).length ? '<div class="review-missing"><strong>Still needed</strong><ul>' + review.missing_evidence.map(item => '<li>' + escape(item) + '</li>').join('') + '</ul></div>' : '') + '<p class="review-source-ids">' + arr(review.evidence_ids).length + ' saved evidence record' + (arr(review.evidence_ids).length === 1 ? '' : 's') + ' linked to this review · ' + escape(displayDate(review.created_at)) + '</p></div></div>';
  }
  function taskInspector(node) {
    const p = properties(node), draft = draftFor(node), review = p.latest_review;
    const decided = review?.status === 'decided', stale = review?.review_current === false;
    return (p.guidance_current === false ? '<div class="review-stale">The guidance behind this task changed. Review the current sources before approving.</div>' : '')
      + '<form id="graph-review-form" class="graph-review-form"><label for="graph-task-evidence">What shows this task is complete?</label><textarea id="graph-task-evidence" required maxlength="6000" rows="5" placeholder="Describe what was done and checked. Include test results, observed outcomes, or references your team can inspect.">' + escape(draft.evidence) + '</textarea><p class="form-hint">Use evidence you are allowed to share with this case. This is saved with the review.</p><button type="submit" class="button secondary" data-graph-operation>' + svg('spark') + (review ? 'Review this evidence again' : 'Ask AI to review') + '</button><p id="graph-review-error" class="form-error" role="alert" hidden></p></form>'
      + reviewMarkup(review)
      + (stale && !decided ? '<div class="review-stale">The task, case or source evidence changed after this review. Ask for a fresh review before deciding.</div>' : '')
      + (review ? '<div id="graph-review-edited" class="review-stale" hidden>The evidence has been edited. Ask AI to review the new evidence before deciding.</div>' : '')
      + (decided ? '<div class="graph-decision-saved' + (p.status === 'done' ? '' : ' reject') + '">' + (p.approval_status === 'approved' ? 'You approved this task’s completion.' : 'A human decision has been recorded. The saved task status is shown above.') + ' A new review is required for another decision.</div>' : review ? '<form id="graph-decision-form" class="graph-decision-form"><label for="graph-decision-reason">Your decision and reason</label><textarea id="graph-decision-reason" required maxlength="2000" rows="3" placeholder="Record what you checked and why you’re approving completion or keeping the task open.">' + escape(draft.reason) + '</textarea><div class="graph-decision-buttons"><button type="submit" class="button primary" data-decision="approve" data-graph-operation>' + svg('check') + 'Approve completion</button><button type="submit" class="button secondary" data-decision="reject" data-graph-operation>Keep open</button></div><p id="graph-decision-error" class="form-error" role="alert" hidden></p></form>' : '')
      + '<p class="graph-advisory">AI checks the evidence recorded here; it does not verify external systems. You make the final decision and may disagree with its recommendation with a reason.</p>';
  }
  function renderInspector() {
    const node = currentNode();
    if (!node) {
      inspectorFingerprint = ''; inspectorNodeId = null;
      setHTML('graph-inspector','<div class="graph-inspector-empty">' + svg('graph') + (graphMode === 'project' ? '<h2>Follow the prerequisites.</h2><p>Each arrow points to a step that must happen first. Select a step to inspect its dependencies.<br><br>Choose Agent workflow to review tasks, handoffs and sessions.</p>' : '<h2>Inspect the work.</h2><p>Select a task card to see its output, the evidence the agent used, and the saved AI review.<br><br>You approve completion. The session controls above show earlier work.</p>') + '</div>'); return;
    }
    const fingerprint = JSON.stringify([node,visible.edges.filter(edge => edge.source === node.id || edge.target === node.id)]);
    if (inspectorFingerprint === fingerprint) { busyControls(); return; }
    syncDraft(); inspectorFingerprint = fingerprint; inspectorNodeId = node.id;
    const p = properties(node), type = canonicalType(node), caseId = currentCase(node);
    let body = '<div class="eyebrow">' + escape(types[node.type] || node.type) + '</div><h2>' + escape(label(node)) + '</h2>' + badge(node);
    if (!visible.nodes.some(item => item.id === node.id)) body += '<p class="graph-advisory">Inspecting a saved record. The task flow stays in place.</p><button type="button" class="text-button" data-graph-evidence="' + escape(node.id) + '">Explore this record’s connections →</button>';
    body += executionContext(node);
    if (p.description || p.rationale || p.reason) body += '<p class="graph-node-description">' + escape(p.description || p.rationale || p.reason) + '</p>';
    if (caseId && caseById(caseId)) body += '<button type="button" class="text-button" data-case="' + escape(caseId) + '">Open case conversation ' + svg('arrow') + '</button>';
    if (type === 'WorkItem' && p.execution_status) body += '<div class="graph-execution-summary"><strong>' + escape(p.execution_agent || 'Assigned agent') + '</strong><br>' + escape(status(node).label) + '<br>Execution produces the output. You approve completion after reviewing it.' + (p.current_artifact_id ? '<button type="button" class="text-button" data-execution-artifact="' + escape(p.current_artifact_id) + '" data-execution-case="' + escape(caseId) + '">Open the actual output →</button>' : '') + (p.execution_task_id ? '<button type="button" class="text-button" data-execution-task="' + escape(p.execution_task_id) + '" data-execution-case="' + escape(caseId) + '">Review evidence &amp; approve →</button>' : '') + '</div>';
    if (type === 'Task' && p.output_artifact_id) body += '<div class="graph-execution-summary"><strong>Agent output saved</strong><br>The evidence below is linked to the file and checks produced by this task.<button type="button" class="text-button" data-execution-artifact="' + escape(p.output_artifact_id) + '" data-execution-case="' + escape(caseId) + '">Inspect the output before approving →</button></div>';
    if (node.type === 'ExecutionArtifact') body += '<button type="button" class="button secondary small" data-execution-artifact="' + escape(node.id) + '" data-execution-case="' + escape(caseId) + '">Open generated files</button>';
    if (['WorkItem','Agent','Capability','ToolCall','Finding','RecoveryAction','Handoff','Memory','Job','Task'].includes(type)) {
      const fields = ['agent','agent_id','role','name','capability','task_id','session_id','attempt','tool','duration_ms','created_at','graph_revision','source_graph_revision','source','source_id','source_episode_ids','recorded_by','work_item_key','assigned_agent','from_agent','to_agent','finding_id','reused_finding_id','consumed_session_id','execution_status','execution_completed_at','status'];
      const present = fields.filter(key => p[key] != null && p[key] !== '');
      if (present.length || p.arguments != null) body += '<details class="recovery-technical"><summary>Technical details</summary>' + (present.length ? '<div class="graph-attribution"><h3>Saved execution &amp; source</h3><dl class="recovery-meta">' + present.map(key => '<div><dt>' + escape(key.replaceAll('_',' ')) + '</dt><dd>' + escape(key.endsWith('_at') ? displayDate(p[key]) : p[key]) + '</dd></div>').join('') + '</dl></div>' : '') + (p.arguments != null ? '<h3>Actual tool arguments</h3><pre class="recovery-json">' + escape(typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments,null,2)) + '</pre>' : '') + '</details>';
      if (p.result != null) body += '<h3>Recorded graph result</h3>' + (window.RelayRecovery ? window.RelayRecovery.resultMarkup(p.result,caseId) : '<pre class="recovery-json">' + escape(JSON.stringify(p.result,null,2)) + '</pre>');
      if (p.paths != null && window.RelayRecovery) { let paths = p.paths; if (typeof paths === 'string') { try { paths = JSON.parse(paths); } catch { paths = []; } } body += '<ol class="recovery-paths">' + window.RelayRecovery.pathsMarkup(paths,caseId) + '</ol>'; }
    }
    if (type === 'Task') body += taskInspector(node);
    else if (type === 'Review') {
      body += reviewMarkup(p) + '<p class="graph-advisory">This is an AI recommendation. Open the linked task to review its current evidence and make a human decision.</p>';
    } else if (type === 'Session') {
      body += '<div class="graph-record-meta"><span>Started<b>' + escape(displayDate(p.created_at || p.started_at)) + '</b></span><span>' + (p.status === 'active' ? 'Continuity' : 'Closed') + '<b>' + (p.status === 'active' ? 'Continues across reloads' : escape(displayDate(p.closed_at || p.ended_at))) + '</b></span>' + (p.ordinal != null ? '<span>Session number<b>' + escape(p.ordinal) + '</b></span>' : '') + '</div><p class="graph-advisory">A session is a saved period of case work. Starting another carries unfinished tasks forward; reloading the page keeps this session.</p><button type="button" class="button secondary small graph-session-button" data-graph-start-session="' + escape(caseId) + '">' + svg('plus') + 'Start next session</button>';
    } else if (p.content || p.evidence || p.submitted_evidence) body += '<div class="graph-value-block">' + escape(p.content || p.evidence || p.submitted_evidence) + '</div>';
    if (type === 'Job') body += '<p class="graph-advisory">This record tracks an agent attempt, its session and execution state. Follow its output and linked task to inspect what ran and the human approval.</p>';
    if (type !== 'Session') body += '<div class="graph-record-meta">' + (p.created_at ? '<span>Recorded<b>' + escape(displayDate(p.created_at)) + '</b></span>' : '') + (p.revision != null ? '<span>Revision<b>' + escape(p.revision) + '</b></span>' : '') + (p.owner ? '<span>Scope<b>' + escape(p.visibility === 'private' ? 'Private to owner' : 'Shared with workspace') + '</b></span>' : '') + '</div><details class="recovery-technical"><summary>Record identifier</summary><code>' + escape(node.id) + '</code></details>';
    body += relationships(node);
    setHTML('graph-inspector',body); busyControls();
  }
  function render() {
    if (!payload) return;
    updateFilters();
    if (!graphMode) graphMode = defaultMode(payload);
    if (selectionWanted && graphMode === 'project' && payload.nodes.some(node => node.id === selectionWanted && canonicalType(node) !== 'WorkItem')) graphMode = 'workflow';
    if (highlightedPath.length && payload.nodes.some(node => highlightedPath.includes(node.id) && canonicalType(node) !== 'WorkItem')) graphMode = 'all';
    const hasProject = payload.nodes.some(node => canonicalType(node) === 'WorkItem');
    if (graphMode === 'project' && !hasProject) graphMode = 'workflow';
    byId('graph-view-mode').value = graphMode; byId('graph-view-mode').querySelector('[value="project"]').disabled = !hasProject;
    byId('graph-session-filter').disabled = graphMode === 'project';
    byId('graph-all-links').closest('label').hidden = true;
    if (selectionWanted && payload.nodes.some(node => node.id === selectionWanted)) { selectedNode = selectionWanted; selectionWanted = null; }
    if (!payload.nodes.some(node => node.id === selectedNode)) selectedNode = null;
    const projection = window.RelayWorkflowProjection;
    visible = graphMode === 'project' ? projectView(payload) : graphMode === 'workflow' ? projection.workflow(payload,sessionFilter) :
      projection.evidence(payload,selectedNode || highlightedPath[0] || projection.workflow(payload,'').nodes[0]?.id,highlightedPath);
    if (graphMode === 'all' && !selectedNode) selectedNode = visible.focusId || null;
    const tasks = visible.nodes.filter(node => canonicalType(node) === 'Task');
    const sessions = arr(visible.activeSessions).length, agents = new Set(visible.nodes.map(node => properties(node).flow_agent).filter(Boolean)).size;
    setHTML('graph-summary',graphMode === 'project' ? '<span><b>' + visible.nodes.length + '</b>project steps</span><span><b>' + visible.edges.length + '</b>dependencies</span><span><b>' + visible.nodes.filter(node => status(node).key === 'approved').length + '</b>approved</span>' : graphMode === 'workflow' ?
      '<span><b>' + visible.nodes.length + '</b>tasks</span><span><b>' + agents + '</b>agents</span><span><b>' + sessions + '</b>work sessions</span><span><b>' + (visible.outputCount || 0) + '</b>outputs</span><span><b>' + tasks.filter(node => status(node).key === 'approved').length + '</b>approved</span>' :
      '<span><b>' + visible.nodes.length + '</b>connected records</span><span><b>' + (visible.hiddenRecordCount || 0) + '</b>other records available in search</span>');
    byId('graph-view-help').textContent = graphMode === 'project' ? 'Each arrow points to a prerequisite. Agent workflow shows who performs each task and passes work onward.' : graphMode === 'workflow' ?
      'Arrows run from prerequisite to next task. Agent badges show who did the work; approval stays separate. Select a card for its output, shared memory and handoffs. Earlier attempts remain in the session history.' :
      'This view shows one record and its immediate connections. Search the saved records to inspect more evidence without drawing the whole database.';
    byId('graph-canvas-help').innerHTML = graphMode === 'workflow' ? 'Follow the arrows ↓<br>Select a task to review its work' : 'Drag to explore · scroll to zoom<br>Select a node for its evidence';
    byId('graph-watermark').textContent = graphMode === 'workflow' ? 'FalkorDB · task dependencies and recorded execution' : 'FalkorDB Canvas · saved graph relationships';
    byId('graph-session-strip').hidden = graphMode !== 'workflow';
    if (graphMode === 'workflow') {
      setHTML('graph-session-strip','<span class="workflow-history-label">Work history</span><button type="button" data-graph-session="" class="' + (!sessionFilter ? 'active' : '') + '" aria-pressed="' + (!sessionFilter) + '">Current work</button>' +
        arr(visible.sessions).map((session,index) => (index ? '<span class="workflow-session-arrow" aria-hidden="true">→</span>' : '<span class="workflow-session-divider" aria-hidden="true"></span>') + '<button type="button" data-graph-session="' + escape(session.id) + '" class="' + (sessionFilter === session.id ? 'active' : '') + '" aria-pressed="' + (sessionFilter === session.id) + '" title="' + escape(label(session)) + '"><small>Session ' + (properties(session).ordinal || index + 1) + '</small>' + escape(label(session)) + '</button>').join(''));
    }
    byId('graph-truncated').hidden = !payload.truncated;
    byId('graph-path-note').hidden = !highlightedPath.length;
    if (highlightedPath.length) byId('graph-path-label').textContent = 'Highlighted evidence path: ' + highlightedPath.filter(nodeId => visible.nodes.some(node => node.id === nodeId)).length + ' of ' + highlightedPath.length + ' nodes visible. Exact path order remains in the query result.';
    byId('graph-empty').hidden = !!visible.nodes.length;
    renderNodes(); renderInspector(); void draw();
  }
  async function load(force = false) {
    if (typeof state === 'undefined' || !state || byId('view-graph').hidden) return;
    if (firstScope) { caseFilter = (typeof selected === 'string' && state.cases.some(item => item.id === selected) ? selected : state.cases[0]?.id) || ''; firstScope = false; }
    if (activeRequest) { if (!force) return activeRequest; await activeRequest.catch(() => {}); }
    const version = generation, requestedCase = caseFilter;
    const promise = (async () => {
      try {
        const data = await api('flow' + (requestedCase ? '?case_id=' + encodeURIComponent(requestedCase) : ''));
        if (version !== generation || requestedCase !== caseFilter) return;
        syncDraft(); payload = data; error('graph-error',''); render();
      } catch (cause) {
        if (version === generation && cause.name !== 'StaleWorkspace') { error('graph-error',cause.message); byId('graph-loading').hidden = true; }
      } finally { if (activeRequest === promise) activeRequest = null; }
    })();
    activeRequest = promise; return promise;
  }
  function select(nodeId, scroll = false) {
    if (!payload?.nodes.some(node => node.id === nodeId)) return;
    syncDraft(); selectedNode = nodeId; inspectorFingerprint = ''; renderNodes(); renderInspector();
    if (graphMode === 'all') { forceFit = true; render(); }
    else { byId('work-canvas').refresh?.(); pinWorkflow(); }
    if (scroll && matchMedia('(max-width:1250px)').matches) byId('graph-inspector').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function open(caseId, taskId) {
    if (caseId !== undefined) firstScope = false;
    if (caseId !== undefined && caseId !== caseFilter) { syncDraft(); caseFilter = caseId || ''; sessionFilter = ''; graphMode = ''; payload = null; forceFit = true; generation++; highlightedPath = []; }
    if (taskId) { selectionWanted = taskId; selectedNode = taskId; graphMode = 'workflow'; inspectorFingerprint = ''; }
    if (view !== 'graph') changeView('graph');
    else { updateFilters(); void load(true); }
  }
  function highlight(caseId, nodeIds) {
    open(caseId,nodeIds[0]); highlightedPath = arr(nodeIds); drawnFingerprint = ''; forceFit = true;
    if (payload) render();
  }
  function reset() {
    generation++; activeRequest = null; payload = null; selectedNode = null; selectionWanted = null; caseFilter = ''; sessionFilter = '';
    highlightedPath = []; graphMode = ''; firstScope = true; workflowPlan = null; byId('graph-path-note').hidden = true;
    visible = {nodes:[],edges:[]}; numericIds.clear(); numericId = 0; fieldDrafts.clear(); actionRequests.clear(); pending.clear();
    drawnFingerprint = ''; inspectorFingerprint = ''; inspectorNodeId = null; forceFit = true; canvasStarted = false;
    byId('work-canvas').setGraphData?.({nodes:[],links:[]});
    ['graph-summary','graph-node-list','graph-inspector'].forEach(target => setHTML(target,''));
    byId('graph-node-search').value = ''; byId('graph-all-links').checked = false; byId('graph-loading').hidden = false; byId('graph-empty').hidden = true; error('graph-error','');
    setHTML('graph-case-filter','<option value="">All cases in this workspace</option>');setHTML('graph-session-filter','<option value="">All sessions</option>');
  }
  async function operation(node, target, work) {
    if (pending.has(node.id)) return;
    const version = generation; pending.add(node.id); busyControls(); error(target,'');
    try {
      await work();
      if (version !== generation) return;
      await refresh(true); await load(true);
    } catch (cause) {
      if (cause.name !== 'StaleWorkspace' && version === generation) {
        if (selectedNode === node.id) error(target,cause.message); else notify(cause.message,true);
        await load(true);
      }
    } finally { pending.delete(node.id); busyControls(); }
  }
  function showSession(caseId) {
    const cases = arr(state?.cases).filter(item => item.resolution_status !== 'resolved');
    if (!cases.length) { notify('Create an open case before starting a session.'); return; }
    if (caseId && !cases.some(item => item.id === caseId)) { notify('This case is resolved. Choose an open case to start a new session.'); return; }
    setHTML('graph-session-case',cases.map(item => '<option value="' + escape(item.id) + '">' + escape(item.title) + '</option>').join(''));
    byId('graph-session-case').value = cases.some(item => item.id === caseId) ? caseId : cases.some(item => item.id === caseFilter) ? caseFilter : cases[0].id;
    byId('graph-session-name').value = ''; error('graph-session-error',''); byId('graph-session-dialog').showModal();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.graphNode) { select(button.dataset.graphNode,true); return; }
    if (button.hasAttribute('data-graph-session')) { byId('graph-session-filter').value = button.dataset.graphSession; byId('graph-session-filter').dispatchEvent(new Event('change')); return; }
    if (button.dataset.graphEvidence) { syncDraft(); graphMode = 'all'; selectedNode = button.dataset.graphEvidence; forceFit = true; render(); return; }
    if (button.dataset.graphStartSession) { showSession(button.dataset.graphStartSession); return; }
    if (button.hasAttribute('data-graph-fit')) { fitCurrentGraph(350); return; }
    if (button.hasAttribute('data-graph-clear-path')) { highlightedPath = []; drawnFingerprint = ''; render(); return; }
    if (button.dataset.graphZoom) { const graph = byId('work-canvas').getGraph?.(); if (graph?.zoom) graph.zoom(graph.zoom() * (button.dataset.graphZoom === 'in' ? 1.3 : 1 / 1.3),200); }
  });
  byId('graph-case-filter').addEventListener('change',event => { syncDraft(); firstScope = false; caseFilter = event.target.value; graphMode = ''; highlightedPath = []; sessionFilter = ''; selectedNode = null; payload = null; generation++; forceFit = true; byId('graph-loading').hidden = false; void load(true); });
  byId('graph-view-mode').addEventListener('change',event => { syncDraft(); graphMode = event.target.value; sessionFilter = ''; highlightedPath = []; selectedNode = null; selectionWanted = null; inspectorFingerprint = ''; forceFit = true; render(); });
  byId('graph-session-filter').addEventListener('change',event => { syncDraft(); graphMode = 'workflow'; sessionFilter = event.target.value; selectedNode = null; inspectorFingerprint = ''; forceFit = true; render(); });
  byId('graph-node-search').addEventListener('input',renderNodes);
  byId('graph-all-links').addEventListener('change',() => { forceFit = true; void draw(); });
  byId('graph-inspector').addEventListener('input',() => { syncDraft(); busyControls(); });
  byId('graph-inspector').addEventListener('submit',event => {
    event.preventDefault(); const node = currentNode(); if (!node || canonicalType(node) !== 'Task') return;
    syncDraft(); const p = properties(node), evidence = byId('graph-task-evidence').value.trim(), base = 'cases/' + encodeURIComponent(currentCase(node)) + '/tasks/' + encodeURIComponent(node.id);
    if (event.target.id === 'graph-review-form') {
      const body = {expected_revision:p.revision,evidence}; body.request_id = requests('review:' + node.id,body);
      void operation(node,'graph-review-error',async () => {
        const result = await api(base + '/review',body);
        actionRequests.delete('review:' + node.id);
        p.latest_review = result.review || result; inspectorFingerprint = ''; renderInspector(); notify(p.latest_review.review_current === false ? 'This saved review is outdated. Ask again to review the current evidence.' : 'Evidence review saved. Your decision is next.');
      });
    } else if (event.target.id === 'graph-decision-form') {
      const review = p.latest_review, decision = event.submitter?.dataset.decision, reason = byId('graph-decision-reason').value.trim();
      if (!review || !['approve','reject'].includes(decision) || !reason) return;
      const body = {review_id:review.id,decision,expected_revision:p.revision,reason}; body.request_id = requests('decision:' + node.id,body);
      void operation(node,'graph-decision-error',async () => {
        const result = await api(base + '/decision',body);
        actionRequests.delete('decision:' + node.id);
        node.properties = {...p,...result.task,latest_review:result.review || {...review,status:'decided'}};
        node.status = result.task?.status || node.status;
        const reviewNode = payload?.nodes.find(item => item.id === review.id); if (reviewNode && result.review) reviewNode.properties = result.review;
        draftFor(node).reason = ''; inspectorFingerprint = ''; render(); notify(decision === 'approve' ? 'Completion approved and saved with your evidence.' : 'Task kept open. Your reason stays with the work.');
      });
    }
  });
  byId('graph-new-session').addEventListener('click',() => showSession(caseFilter));
  byId('graph-session-form').addEventListener('submit',event => {
    event.preventDefault(); const form = event.currentTarget, caseId = byId('graph-session-case').value;
    const body = {title:byId('graph-session-name').value.trim()}; body.request_id = requests('session:' + caseId,body);
    void mutate('graph-session',event.submitter,'graph-session-error',async () => {
      const result = await api('cases/' + encodeURIComponent(caseId) + '/sessions',body);
      byId('graph-session-dialog').close(); form.reset(); actionRequests.delete('session:' + caseId);
      open(caseId,result.id || result.session?.id); notify('New session saved. Unfinished work carries forward.');
    });
  });
  return {open,highlight,load,reset,sync:() => { if (!byId('view-graph').hidden) { updateFilters(); void load(); } },status,sessionView,workflowEdges,projectView,defaultMode};
})();
