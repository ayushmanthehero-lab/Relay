'use strict';

// Recovery evidence is rendered from saved server records and explicit query results.
window.RelayRecovery = (() => {
  const el = key => document.getElementById(key);
  const arr = value => Array.isArray(value) ? value : [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const decode = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
  const json = value => escape(JSON.stringify(decode(value), null, 2) ?? 'Not recorded');
  const empty = text => '<p class="recovery-empty">' + escape(text) + '</p>';
  const stamp = value => typeof date === 'function' ? date(value, true) || 'Date not recorded' : String(value || 'Date not recorded');
  const memo = new Map(), draft = new Map(), previews = new Map(), requests = new Map(), active = new Map(), itemDrafts = new Map();
  const tools = {
    trace_blockers:'Trace unfinished prerequisites', trace_dependents:'Trace downstream impact',
    explain_connection:'Shortest paths · algo.SPpaths', rank_bottlenecks:'Bottlenecks · algo.pageRank', ready_assignments:'Find ready assignments'
  };
  let current = null, generation = 0, loading = null, panelKey = '', itemRecord = null;
  function updateBusy() {
    el('recovery-panel').querySelectorAll('[data-recovery-query],#recovery-ask-form button[type="submit"],#recovery-remember-form button[type="submit"]').forEach(button => { button.disabled = Boolean(loading); button.setAttribute('aria-busy',String(Boolean(loading))); });
  }
  function error(target, message) { const element = el(target); if (element) { element.hidden = !message; element.textContent = message || ''; } }
  function requestId(key, body) {
    const fingerprint = JSON.stringify(body), saved = requests.get(key);
    if (saved?.fingerprint === fingerprint) return saved.id;
    const record = {fingerprint, id:crypto.randomUUID()}; requests.set(key,record); return record.id;
  }
  function saveDraft() {
    if (!current || !el('recovery-question')) return;
    draft.set(current,{question:el('recovery-question').value,subject:el('recovery-subject').value,depth:el('recovery-depth').value,target:el('recovery-target').value,remember:el('recovery-remember').value});
  }
  function pathsMarkup(rows, caseId, direction = 'outgoing') {
    return arr(rows).map((row,index) => {
      const keys = arr(row.keys), titles = arr(row.titles), ids = arr(row.ids), relationships = arr(row.relationship_types);
      if (!keys.length && !ids.length) return '';
      const nodes = keys.length ? keys : ids;
      return '<li class="recovery-path"><span>' + nodes.map((key,i) => (i ? '<small> ' + (direction === 'incoming' || direction === 'capability' && i === 2 ? '←' : '—') + escape(String(relationships[i-1] || 'relationship not recorded').replaceAll('_',' ').toLowerCase()) + (direction === 'incoming' || direction === 'capability' && i === 2 ? '—' : '→') + ' </small>' : '') + '<b title="' + escape(ids[i] || key) + '">' + escape(titles[i] || key) + '</b>').join('') + '</span><div class="recovery-path-meta">' + escape(row.hops ?? Math.max(0,nodes.length-1)) + ' hop(s)' + (row.weight != null ? ' · weight ' + escape(row.weight) : '') + (caseId && ids.length ? '<button type="button" class="text-button" data-recovery-case="' + escape(caseId) + '" data-recovery-path="' + escape(JSON.stringify(ids)) + '">Highlight in work graph</button>' : '') + '</div></li>';
    }).join('');
  }
  function resultMarkup(raw, caseId) {
    const result = decode(raw);
    if (!result || typeof result !== 'object') return '<pre class="recovery-json">' + escape(raw || 'No result recorded.') + '</pre>';
    const rows = arr(result.rows), unknown = result.outcome === 'unknown_entity', noPath = result.outcome === 'not_in_graph';
    let content = '<div class="recovery-result-heading"><strong>' + escape(result.tool || 'Graph result') + '</strong><span>' + escape(result.algorithm || 'Algorithm not recorded') + (result.depth != null ? ' · depth ' + escape(result.depth) : '') + '</span></div>';
    content += '<p class="' + (unknown || noPath ? 'recovery-unknown' : '') + '">' + escape(unknown ? 'Unknown entity: ' + (arr(result.unresolved_keys).join(', ') || result.subject || result.source || 'the requested entity') + '. It is not a known key in this project graph.' : noPath ? 'Known entity; no matching paths or ready work were found in this bounded graph query. This does not establish that real-world work is unblocked.' : result.summary || 'Saved graph query result.') + '</p>';
    if (rows.some(row => arr(row.ids).length)) content += '<ol class="recovery-paths">' + pathsMarkup(rows,caseId,result.tool === 'trace_dependents' ? 'incoming' : 'outgoing') + '</ol>';
    if (rows.some(row => row.score != null)) content += '<p class="form-hint">Dependency centrality indicates graph structure, not severity or probability.</p><div class="recovery-table-wrap"><table class="recovery-table"><thead><tr><th>Work item</th><th>Status</th><th>PageRank</th></tr></thead><tbody>' + rows.map(row => '<tr><td>' + escape(row.title || row.key) + '<small>' + escape(row.key) + '</small></td><td>' + escape(row.status) + '</td><td>' + escape(row.score) + '</td></tr>').join('') + '</tbody></table></div>';
    if (rows.some(row => Array.isArray(row.agents))) content += rows.map(row => '<article class="recovery-assignment"><strong>' + escape(row.title || row.key) + '</strong><p>' + escape(arr(row.agents).length ? arr(row.agents).map(agent => agent.role || agent.id).join(', ') : 'Unassigned: no matching capable agent was found in the graph.') + '</p><ol class="recovery-paths">' + pathsMarkup(row.paths,caseId) + pathsMarkup(row.agents,caseId,'capability') + '</ol></article>').join('');
    if (result.truncated) content += '<p class="recovery-unknown">Results truncated at the server limit. Other paths may exist.</p>';
    content += '<div class="recovery-evidence-meta">Graph revision ' + escape(result.project_revision ?? result.graph_revision ?? 'not recorded') + ' · ' + rows.length + ' returned row(s)</div><details><summary>Exact graph result</summary><pre class="recovery-json">' + json(result) + '</pre></details>';
    return content;
  }
  function recordDetails(record, fields = []) {
    return '<details class="recovery-technical"><summary>Technical details</summary><dl class="recovery-meta">' + fields.filter(key => record[key] != null && record[key] !== '').map(key => '<div><dt>' + escape(key.replaceAll('_',' ')) + '</dt><dd>' + escape(key.endsWith('_at') ? stamp(record[key]) : typeof record[key] === 'object' ? JSON.stringify(record[key]) : record[key]) + '</dd></div>').join('') + '</dl></details>';
  }
  function memoryMarkup(memory, caseId) {
    const content = decode(memory.content || memory.summary);
    const graphResult = content && typeof content === 'object' && Array.isArray(content.rows) ? content : null;
    return '<article class="recovery-memory"><strong>' + escape(memory.title || memory.kind || 'Saved memory') + '</strong><p class="recovery-content">' + escape(graphResult ? graphResult.summary || 'Saved graph observation.' : memory.content || memory.summary) + '</p><small>' + escape(stamp(memory.created_at)) + ' · ' + escape(memory.agent || memory.author || 'Saved case memory') + ' · source graph revision ' + escape(memory.graph_revision ?? memory.source_graph_revision ?? graphResult?.project_revision ?? 'not recorded') + (memory.current === false ? ' · historical' : '') + '</small>' + (graphResult ? '<details><summary>Inspect saved graph evidence</summary>' + resultMarkup(graphResult,caseId) + '</details>' : '') + '</article>';
  }
  function renderState(data) {
    if (!data || data.case?.id !== current) return;
    const records = arr(data.requests), caseId = current;
    el('recovery-revision').textContent = 'Graph revision ' + (data.case.project_revision ?? 'not recorded');
    el('recovery-known-keys').innerHTML = arr(data.items).map(item => '<option value="' + escape(item.key) + '">' + escape(item.title) + '</option>').join('');
    if (!el('recovery-subject').value && !draft.has(caseId)) el('recovery-subject').value = arr(data.items).find(item => item.key === 'launch')?.key || arr(data.items)[0]?.key || '';
    el('recovery-item-list').innerHTML = arr(data.items).map(item => '<div class="recovery-item-card"><button type="button" class="recovery-item" data-recovery-subject="' + escape(item.key) + '"><span class="status-dot"></span><b>' + escape(item.title || item.key) + '</b><small>' + escape(item.status === 'done' ? 'Reported complete' : 'To do') + '</small></button><button type="button" class="recovery-item-edit" data-recovery-item="' + escape(item.key) + '" aria-label="Record human-reported status for ' + escape(item.title || item.key) + '">Record status</button></div>').join('') || empty('No work items were returned.');
    const itemKey = value => arr(data.items).find(item => item.id === value || item.key === value)?.key || value;
    el('recovery-dependencies').innerHTML = arr(data.dependencies).length ? '<ul class="recovery-dependency-list">' + arr(data.dependencies).map(dep => '<li><code>' + escape(itemKey(dep.source)) + '</code><span> —DEPENDS_ON→ </span><code>' + escape(itemKey(dep.target)) + '</code><small>weight ' + escape(dep.weight ?? 1) + '</small></li>').join('') + '</ul>' : empty('No dependency relationships returned. Work items may be isolated.');
    el('recovery-requests').innerHTML = records.length ? records.map(record => '<article class="recovery-request"><div><strong>' + escape(record.question) + '</strong><span class="recovery-status">' + escape(record.status || 'Status not recorded') + '</span></div><p>' + escape(arr(data.items).find(item => item.key === record.subject)?.title || record.subject) + ' · depth ' + escape(record.depth) + ' · ' + escape(stamp(record.created_at)) + '</p>' + (record.reused_finding_id ? '<p class="recovery-reused">Answered from a saved finding that is still current.</p>' + recordDetails(record,['id','reused_finding_id']) : '') + (record.error ? '<p class="recovery-unknown">' + escape(record.error) + '</p>' : '') + '</article>').join('') : empty('Ask a question to queue Scout → Coordinator → Reviewer. Saved activity appears as the team runs.');
    el('recovery-agents').innerHTML = arr(data.agents).map(agent => '<div class="recovery-agent"><span>' + escape((agent.role || agent.name || 'A').slice(0,1)) + '</span><div><strong>' + escape(agent.role || agent.name || agent.id) + '</strong><small>' + escape(arr(agent.capabilities).join(', ') || agent.capability || 'Capabilities recorded in graph') + '</small></div></div>').join('');
    el('recovery-calls').innerHTML = arr(data.calls).length ? arr(data.calls).map(call => '<details class="recovery-call"><summary><span><strong>' + escape(call.agent || call.agent_id || 'Agent not recorded') + '</strong> · ' + escape(call.tool) + '<small>' + escape(stamp(call.created_at)) + ' · ' + escape(call.status) + (call.duration_ms != null ? ' · ' + escape(call.duration_ms) + ' ms' : '') + '</small></span></summary>' + recordDetails(call,['id','agent','task_id','session_id','attempt']) + '<h5>Actual MCP arguments</h5><pre class="recovery-json">' + json(call.arguments) + '</pre><h5>Recorded tool result</h5>' + resultMarkup(call.result,caseId) + '</details>').join('') : empty('No tool calls recorded yet. Query previews below are read-only and are separate from team execution.');
    el('recovery-actions').innerHTML = arr(data.actions).length ? arr(data.actions).map(action => '<article class="recovery-action">' + (Number(action.graph_revision) !== Number(data.case.project_revision) ? '<p class="recovery-unknown">Earlier graph revision. Query the current project and review fresh evidence before using this action.</p>' : '') + '<span class="recovery-status">' + escape(action.status || 'proposed') + '</span><h4>' + escape(action.title) + '</h4><p>' + escape(action.assigned_agent || 'Unassigned — capability match unresolved') + ' · ' + escape(arr(data.items).find(item => item.key === action.work_item_key || item.id === action.work_item_id)?.title || action.work_item_key || 'Work item not recorded') + '</p>' + recordDetails(action,['id','graph_revision','request_id','work_item_id']) + '<ol class="recovery-paths">' + pathsMarkup(decode(action.paths),caseId) + '</ol><button type="button" class="text-button" data-recovery-record="' + escape(action.task_id || action.id) + '">Inspect evidence in work graph →</button></article>').join('') : empty('No investigative recommendations yet. Use Run tasks above to produce the actual project outputs.');
    el('recovery-handoffs').innerHTML = arr(data.handoffs).length ? arr(data.handoffs).map(handoff => '<article class="recovery-handoff"><strong>' + escape(handoff.from_agent) + ' → ' + escape(handoff.to_agent) + '</strong><span class="recovery-status">' + escape(handoff.status || 'Saved') + '</span><p>' + escape(arr(data.findings).find(finding => finding.id === handoff.finding_id)?.title || 'Saved graph evidence passed to the next agent') + '</p><small>' + escape(stamp(handoff.created_at)) + '</small>' + recordDetails(handoff,['id','finding_id','session_id','consumed_session_id']) + '</article>').join('') : empty('Saved handoffs will show which result moved between agents and which session consumed it.');
    el('recovery-findings').innerHTML = arr(data.findings).length ? arr(data.findings).map(finding => '<details class="recovery-call"><summary><span><strong>' + escape(finding.title || finding.kind || 'Saved finding') + '</strong><small>' + escape(finding.agent || 'Human-reported finding') + ' · ' + escape(stamp(finding.created_at)) + ' · graph revision ' + escape(finding.graph_revision ?? 'not recorded') + '</small></span></summary><p class="recovery-content">' + escape(finding.result ? decode(finding.result)?.summary || 'Saved graph observation.' : finding.content) + '</p>' + (finding.result ? resultMarkup(finding.result,caseId) : '') + recordDetails(finding,['id','kind','source','session_id']) + '</details>').join('') : empty('No saved findings yet. Current findings can answer matching questions; changed graph revisions require new evidence.');
    el('recovery-memories').innerHTML = arr(data.memories).length ? arr(data.memories).map(memory => memoryMarkup(memory,caseId)).join('') : empty('Native recalled memories and human updates appear here when the server links them to this project.');
  }
  function shell(item) {
    const caseId = item.id, saved = draft.get(caseId) || {subject:'',depth:'4',question:'What unfinished prerequisites block this goal, and who can recover them?'};
    el('recovery-panel').innerHTML = '<details class="recovery-investigation"><summary>Investigate blockers, inspect graph paths and add remembered context</summary><div class="recovery-panel-heading"><div><div class="eyebrow">PROJECT RECOVERY</div><h3>Trace blockers. Recover the next step.</h3><p>Every action should point back to graph evidence. Pause and continue using the case controls above.</p></div><button type="button" class="button secondary small" data-recovery-graph>Open work graph →</button></div><p id="recovery-revision" class="recovery-evidence-meta"></p><div id="recovery-error" class="notice error" role="alert" hidden></div><form id="recovery-ask-form"><div class="recovery-question-row"><div><label for="recovery-subject">Goal / subject key</label><input id="recovery-subject" list="recovery-known-keys" required maxlength="160" value="' + escape(saved.subject) + '" placeholder="Type any key, or choose a known item"><datalist id="recovery-known-keys"></datalist></div><div><label for="recovery-depth">Dependency depth</label><select id="recovery-depth">' + [1,2,3,4].map(depth => '<option value="' + depth + '"' + (String(depth) === saved.depth ? ' selected' : '') + '>' + depth + ' hop' + (depth > 1 ? 's' : '') + '</option>').join('') + '</select></div></div><label for="recovery-question">Question for your agent team</label><textarea id="recovery-question" rows="2" required maxlength="3000" placeholder="What blocks this goal?">' + escape(saved.question) + '</textarea><div class="recovery-form-footer"><span>Scout recalls → queries via MCP → Coordinator acts → Reviewer checks</span><button type="submit" class="button primary small">Ask team →</button></div></form><div id="recovery-requests" aria-live="polite"></div><div class="recovery-section"><div class="recovery-section-heading"><h4>Project graph</h4><span>DEPENDS_ON points to a prerequisite</span></div><div id="recovery-item-list" class="recovery-items"></div><details class="recovery-dependency-details"><summary>Inspect saved dependencies</summary><div id="recovery-dependencies"></div></details></div><details class="recovery-query-panel"><summary>Explore actual graph queries</summary><p>Preview bounded graph evidence. These queries do not queue agent work or complete tasks.</p><div class="recovery-query-buttons"><button type="button" class="button secondary small" data-recovery-query="compare">Compare depth 1 &amp; 4</button><button type="button" class="button secondary small" data-recovery-query="trace_blockers">Trace blockers</button><button type="button" class="button secondary small" data-recovery-query="trace_dependents">Trace dependents</button><button type="button" class="button secondary small" data-recovery-query="ready_assignments">Ready assignments</button><button type="button" class="button secondary small" data-recovery-query="rank_bottlenecks">PageRank bottlenecks</button></div><div class="recovery-shortest"><label for="recovery-target">Connection target key</label><input id="recovery-target" list="recovery-known-keys" maxlength="160" value="' + escape(saved.target || 'security-review') + '"><button type="button" class="button secondary small" data-recovery-query="explain_connection">Shortest paths</button></div><p id="recovery-query-error" class="form-error" role="alert" hidden></p><div id="recovery-preview"></div><details><summary>Agent tool catalog</summary><ul class="recovery-tool-catalog">' + Object.entries(tools).map(([name,label]) => '<li><code>' + name + '</code><span>' + escape(label) + '</span></li>').join('') + '</ul></details></details><div class="recovery-two-column"><section><div class="recovery-section-heading"><h4>Agent activity &amp; MCP calls</h4></div><div id="recovery-agents" class="recovery-agents"></div><div id="recovery-calls"></div></section><section><div class="recovery-section-heading"><h4>Evidence-backed recovery actions</h4></div><p class="form-hint">These are investigative recommendations. The task runner above produces files and test results; review those outputs before approving completion.</p><div id="recovery-actions"></div></section></div><details class="recovery-section" open><summary>Saved handoffs &amp; session continuation</summary><div id="recovery-handoffs"></div></details><details class="recovery-section" open><summary>Dated findings &amp; memory reuse</summary><div id="recovery-findings"></div><div id="recovery-memories"></div></details><form id="recovery-remember-form" class="recovery-remember-form"><label for="recovery-remember">Remember an update from your conversation</label><textarea id="recovery-remember" rows="2" required maxlength="6000" placeholder="remember: Security review is awaiting the architecture owner’s sign-off.">' + escape(saved.remember || '') + '</textarea><div class="recovery-form-footer"><span>Saved as an attributed human report, with date and graph revision.</span><button type="submit" class="button secondary small">Remember update</button></div></form></details>';
    const preview = previews.get(caseId); if (preview) el('recovery-preview').innerHTML = preview;
    updateBusy();
  }
  async function load(caseId = current) {
    if (!caseId) return;
    if (active.has(caseId)) return active.get(caseId);
    const version = generation;
    const promise = (async () => {
      try {
        const data = await api('cases/' + encodeURIComponent(caseId) + '/recovery');
        if (version !== generation) return;
        memo.set(caseId,data);
        if (current === caseId) { renderState(data); error('recovery-error',''); }
        return data;
      } catch (cause) {
        if (version === generation && current === caseId && cause.name !== 'StaleWorkspace') error('recovery-error',cause.message);
      } finally { if (active.get(caseId) === promise) active.delete(caseId); }
    })();
    active.set(caseId,promise); return promise;
  }
  function sync(item) {
    saveDraft();
    const recovery = item?.kind === 'recovery';
    el('recovery-panel').hidden = !recovery;
    if (!recovery) { current = null; panelKey = ''; return; }
    current = item.id;
    if (panelKey !== current) { panelKey = current; shell(item); }
    if (memo.has(current)) renderState(memo.get(current));
    void load(current);
  }
  async function perform(key,button,target,operation) {
    if (loading) return;
    const version = generation, caseId = current;
    loading = key; button.disabled = true; button.setAttribute('aria-busy','true'); error(target,'');
    updateBusy();
    try { await operation(caseId); if (version === generation) { await load(caseId); await refresh(true); } }
    catch (cause) { if (version === generation && cause.name !== 'StaleWorkspace') { if (caseId === current) error(target,cause.message); else notify(cause.message,true); } }
    finally { if (version === generation) { loading = null; button.disabled = false; button.setAttribute('aria-busy','false'); updateBusy(); } }
  }
  function showCreate(sample) {
    error('recovery-create-error','');
    if (sample) {
      el('recovery-title').value = 'Website launch — fix signup before release';
      el('recovery-description').value = 'Build a standalone local signup page with required email and consent, reject invalid submissions, and show a confirmation for valid input without sending data anywhere. Agents write privacy requirements and a signup contract, build the page, run real browser checks and package the local release. No production deployment is requested.';
    }
    if (sample || !el('recovery-json').value.trim()) {
      const items = [['launch','Package the tested local release','package_release'],['qa','Test the signup journey','test_page'],['integration','Build the local signup page','build_page'],['api-contract','Define the signup contract','design_contract'],['security-review','Write privacy and consent requirements','write_document'],['docs','Write the launch checklist','write_document']].map(([key,title,capability]) => ({key,title,status:'pending',capability}));
      const dependencies = [['launch','qa'],['qa','integration'],['integration','api-contract'],['api-contract','security-review'],['launch','docs']].map(([source,target]) => ({source,target,weight:1}));
      el('recovery-json').value = JSON.stringify({items,dependencies},null,2);
    }
    el('recovery-create-dialog').showModal();
  }
  function saveItemDraft() {
    if (itemRecord) itemDrafts.set(itemRecord.caseId + ':' + itemRecord.key,{status:el('recovery-item-status').value,reason:el('recovery-item-reason').value});
  }
  function showItem(key) {
    const data = memo.get(current), item = arr(data?.items).find(record => record.key === key);
    if (!item || !Number.isInteger(data.case.project_revision)) { error('recovery-error','Refresh the project before recording an item status.'); return; }
    saveItemDraft();
    itemRecord = {caseId:current,key,expected_revision:data.case.project_revision};
    const saved = itemDrafts.get(current + ':' + key);
    el('recovery-item-label').textContent = (item.title || key) + ' · ' + key;
    el('recovery-item-revision').textContent = 'Updating project graph revision ' + itemRecord.expected_revision + '. Changing status invalidates earlier finding reuse; the team must query current evidence.';
    el('recovery-item-status').value = saved?.status || item.status || 'pending';
    el('recovery-item-reason').value = saved?.reason || '';
    error('recovery-item-error',''); el('recovery-item-dialog').showModal();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.hasAttribute('data-recovery-create')) return showCreate(false);
    if (button.hasAttribute('data-recovery-demo')) return showCreate(true);
    if (button.dataset.recoveryItem) return showItem(button.dataset.recoveryItem);
    if (button.dataset.recoverySubject) { el('recovery-subject').value = button.dataset.recoverySubject; saveDraft(); return; }
    if (button.hasAttribute('data-recovery-graph')) return window.RelayWorkGraph?.open(current);
    if (button.dataset.recoveryRecord) return window.RelayWorkGraph?.open(current,button.dataset.recoveryRecord);
    if (button.dataset.recoveryPath) return window.RelayWorkGraph?.highlight(button.dataset.recoveryCase || current,JSON.parse(button.dataset.recoveryPath));
    const tool = button.dataset.recoveryQuery;
    if (!tool || !current) return;
    saveDraft();
    const subject = el('recovery-subject').value.trim(), depth = Number(el('recovery-depth').value), target = el('recovery-target').value.trim();
    if (tool !== 'rank_bottlenecks' && !subject) { error('recovery-query-error','Enter a subject key.'); return; }
    if (tool === 'explain_connection' && !target) { error('recovery-query-error','Enter a connection target key.'); return; }
    void perform('preview',button,'recovery-query-error',async caseId => {
      const query = (name,args) => api('cases/' + encodeURIComponent(caseId) + '/recovery/query',{tool:name,arguments:args});
      let markup;
      if (tool === 'compare') {
        const one = await query('trace_blockers',{subject,depth:1});
        const four = await query('trace_blockers',{subject,depth:4});
        markup = '<div class="recovery-comparison"><section><h5>Depth 1 · immediate prerequisites</h5>' + resultMarkup(one,caseId) + '</section><section><h5>Depth 4 · up to four hops</h5>' + resultMarkup(four,caseId) + '</section></div>';
      } else {
        const args = tool === 'rank_bottlenecks' ? {limit:5} : tool === 'explain_connection' ? {source:subject,target,depth} : {subject,depth};
        markup = resultMarkup(await query(tool,args),caseId);
      }
      previews.set(caseId,markup); if (caseId === current) el('recovery-preview').innerHTML = markup;
    });
  });
  el('recovery-item-form').addEventListener('input',saveItemDraft);
  el('recovery-item-form').addEventListener('change',saveItemDraft);
  el('recovery-item-form').addEventListener('submit',event => {
    event.preventDefault(); if (!itemRecord) return;
    saveItemDraft();
    const record = {...itemRecord}, draftKey = record.caseId + ':' + record.key;
    const body = {status:el('recovery-item-status').value,expected_revision:record.expected_revision,reason:el('recovery-item-reason').value.trim()};
    if (!body.reason) { error('recovery-item-error','Record the evidence or reason for this human status report.'); return; }
    body.request_id = requestId('item:' + draftKey,body);
    void mutate('recovery-item',event.submitter,'recovery-item-error',async () => {
      await api('cases/' + encodeURIComponent(record.caseId) + '/recovery/items/' + encodeURIComponent(record.key),body);
      requests.delete('item:' + draftKey); itemDrafts.delete(draftKey);
      previews.delete(record.caseId);
      if (record.caseId === current) el('recovery-preview').innerHTML = empty('Project status changed. Run a new graph query to inspect current evidence.');
      if (itemRecord?.caseId === record.caseId && itemRecord?.key === record.key) { itemRecord = null; el('recovery-item-dialog').close(); }
      await load(record.caseId);
      notify('Human status report saved. Earlier graph findings require fresh evidence; task completion approval remains separate.');
    });
  });
  el('recovery-panel').addEventListener('input',saveDraft);
  el('recovery-panel').addEventListener('submit',event => {
    if (!current) return;
    event.preventDefault(); saveDraft();
    const formId = event.target.id, button = event.submitter;
    if (formId === 'recovery-ask-form') {
      const body = {question:el('recovery-question').value.trim(),subject:el('recovery-subject').value.trim(),depth:Number(el('recovery-depth').value)};
      body.request_id = requestId('ask:' + current,body);
      void perform('ask',button,'recovery-error',async caseId => { await api('cases/' + encodeURIComponent(caseId) + '/recovery/ask',body); requests.delete('ask:' + caseId); notify('Question queued. Saved agent activity will appear as the team runs.'); });
    } else if (formId === 'recovery-remember-form') {
      const original = el('recovery-remember').value;
      const body = {content:original.trim().replace(/^remember:\s*/i,'')}; body.request_id = requestId('remember:' + current,body);
      if (!body.content.trim()) { error('recovery-error','Add the update you want the team to remember.'); return; }
      void perform('remember',button,'recovery-error',async caseId => {
        await api('cases/' + encodeURIComponent(caseId) + '/recovery/remember',body); requests.delete('remember:' + caseId);
        if (current === caseId && el('recovery-remember').value === original) { el('recovery-remember').value = ''; saveDraft(); }
        notify('Human-reported update saved with its source and date.');
      });
    }
  });
  el('recovery-create-form').addEventListener('submit',event => {
    event.preventDefault(); const form = event.currentTarget;
    const body = {title:el('recovery-title').value.trim(),description:el('recovery-description').value.trim(),visibility:el('recovery-visibility').value};
    try {
      const imported = el('recovery-json').value.trim();
      if (imported) {
        const graph = JSON.parse(imported);
        if (!graph || !Array.isArray(graph.items) || !Array.isArray(graph.dependencies)) throw new Error('JSON must contain items and dependencies arrays.');
        if (graph.items.length > 40 || graph.dependencies.length > 80) throw new Error('Use at most 40 items and 80 dependencies.');
        body.items = graph.items; body.dependencies = graph.dependencies;
      }
    } catch (cause) { error('recovery-create-error',cause.message); return; }
    const fingerprint = JSON.stringify(body); body.request_id = requestId('create',body);
    void mutate('recovery-create',event.submitter,'recovery-create-error',async () => {
      const result = await api('recovery/projects',body), caseId = result.case?.id || result.id;
      await refresh(true); if (caseId) selectCase(caseId,true);
      el('recovery-create-dialog').close();
      const edited = {title:el('recovery-title').value.trim(),description:el('recovery-description').value.trim(),visibility:el('recovery-visibility').value};
      if (el('recovery-json').value.trim()) { try { const graph = JSON.parse(el('recovery-json').value); edited.items = graph.items; edited.dependencies = graph.dependencies; } catch {} }
      if (JSON.stringify(edited) === fingerprint) form.reset();
      requests.delete('create'); notify('Project graph saved. Run tasks to have the agents produce the outputs.');
    });
  });
  function reset() {
    generation++; current = null; loading = null; panelKey = ''; itemRecord = null; memo.clear(); draft.clear(); previews.clear(); requests.clear(); active.clear(); itemDrafts.clear();
    el('recovery-panel').innerHTML = ''; el('recovery-panel').hidden = true; el('recovery-create-form').reset(); el('recovery-item-form').reset(); error('recovery-create-error',''); error('recovery-item-error','');
  }
  return {sync,reset,load,resultMarkup,pathsMarkup};
})();
