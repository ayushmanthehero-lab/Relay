'use strict';

// Task output is fetched from the authorized case graph. Execution and approval
// are separate: a successful tool run never approves its own completion.
window.RelayExecution = (() => {
  const el = id => document.getElementById(id);
  const arr = value => Array.isArray(value) ? value : [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return []; } };
  const summaryText = value => String(value || '').replace(/\[([A-Za-z0-9_:.-]+)\]/g,(match,reference) => {
    const memory = typeof memoryById === 'function' ? memoryById(reference) : null;
    return memory ? '[' + memory.title + ']' : /^execution_artifact_[a-f0-9]+_(memory|semantic)$/.test(reference) ? '[saved project memory]' : match;
  });
  const states = {pending:'Waiting for prerequisites',queued:'Queued',running:'Agent working',succeeded:'Output ready',completed:'Output ready',failed:'Needs another try',blocked:'Blocked',stale:'Needs a fresh run'};
  let current = null, generation = 0, active = null, starting = false, artifact = null, artifactCase = null, artifactVersion = 0;
  const cache = new Map(), requestIds = new Map();
  function endpoint(caseId) { return 'cases/' + encodeURIComponent(caseId) + '/execution'; }
  function setHTML(id, content) { const target = el(id); if (target && target.dataset.rendered !== content) { target.innerHTML = content; target.dataset.rendered = content; } }
  function error(message) { el('execution-error').hidden = !message; el('execution-error').textContent = message || ''; }
  function checksMarkup(checks) {
    const values = arr(parse(checks));
    return values.length ? '<ul class="execution-checks">' + values.map(check => '<li class="' + (check.passed ? 'passed' : 'failed') + '"><span aria-hidden="true">' + (check.passed ? '✓' : '×') + '</span><div><strong>' + escape(check.name || 'Validation') + '</strong><p>' + escape(check.detail || '') + '</p></div></li>').join('') + '</ul>' : '<p class="form-hint">No validation checks saved for this output.</p>';
  }
  function taskState(item) { return states[item.execution_status] || (item.execution_status ? String(item.execution_status).replaceAll('_',' ') : 'Not started'); }
  function outputCard(output) {
    return '<button type="button" class="execution-output" data-execution-artifact="' + escape(output.id) + '" data-execution-case="' + escape(current) + '"><span class="execution-output-icon" aria-hidden="true">' + (arr(parse(output.files)).some(file => file.media_type === 'text/html') ? '▣' : '≡') + '</span><strong>' + escape(output.title || output.key || 'Saved task output') + '</strong><span>' + escape(summaryText(output.summary)) + '</span><small>' + escape(output.agent || 'Agent') + ' · ' + arr(parse(output.files)).length + ' file(s) · ' + (output.current === false ? 'Historical output' : output.passed === false ? 'Checks need attention' : 'Open output →') + '</small></button>';
  }
  function shell() {
    el('execution-panel').innerHTML = '<div class="execution-heading"><div><div class="eyebrow">AGENTS DO THE WORK. YOU APPROVE IT.</div><h3 id="execution-title">A working signup page, with evidence.</h3><p id="execution-description">The team writes requirements, builds the page, tests the signup journey and packages the local release. FalkorDB chooses the order and carries each agent’s output to the next.</p></div><button type="button" class="button primary" id="execution-start"><svg><use href="#i-play"/></svg>Run tasks</button></div><p id="execution-scope" class="execution-scope">Local website example · no production deployment or real signup collection</p><p id="execution-error" class="notice error" role="alert" hidden></p><div id="execution-progress" class="execution-progress" aria-live="polite"></div><ol id="execution-items" class="execution-items"></ol><div id="execution-outputs"></div><details id="execution-handoff-details" class="execution-handoff-details"><summary>How outputs moved between agents and sessions</summary><div id="execution-handoffs"></div></details>';
  }
  function render(data) {
    if (data?.case?.id && data.case.id !== current) return;
    const outputs = arr(data.artifacts);
    const items = arr(data.items).map(item => ({...item,execution_status:['succeeded','completed'].includes(item.execution_status) && ((item.execution_graph_revision != null && item.execution_graph_revision !== data.case?.project_revision) || outputs.some(output => output.id === (item.current_artifact_id || item.artifact_id) && output.current === false)) ? 'stale' : item.execution_status}));
    const finished = items.filter(item => ['succeeded','completed'].includes(item.execution_status)).length;
    const website = items.some(item => item.capability === 'build_page') || ['security-review','api-contract','integration','qa','launch','docs'].every(key => items.some(item => item.key === key));
    el('execution-title').textContent = website ? 'A working signup page, with evidence.' : 'Work your agents can execute.';
    el('execution-description').textContent = website ? 'The team writes requirements, builds the page, tests the signup journey and packages the local release. FalkorDB chooses the order and carries each agent’s output to the next.' : 'FalkorDB selects tasks with ready prerequisites and matching agent capabilities. Each agent creates a saved output for the next task. Tasks without an execution tool are reported as blocked.';
    el('execution-scope').textContent = website ? 'Local website example · no production deployment or real signup collection' : 'Available tools: write documents, define signup contracts, build local signup pages, run browser checks and package a local release.';
    const running = items.find(item => item.execution_status === 'running');
    const queued = arr(data.jobs).some(job => ['pending','queued','running'].includes(job.status));
    const paused = data.case?.workflow_status === 'paused' || data.status === 'paused';
    const allFinished = items.length > 0 && finished === items.length;
    const statusText = paused ? 'Paused. Resume from the case controls above; saved outputs carry forward.' : running ? (running.execution_agent || running.agent || 'An agent') + ' is working on ' + (running.title || running.key) + '.' : allFinished ? 'All outputs saved. Inspect the work and approve completion.' : queued ? 'Agents are processing eligible tasks. Outputs appear as each task finishes.' : data.blocked_reason || 'Ready to work. Start the team once; dependent tasks continue automatically.';
    setHTML('execution-progress','<div><strong>' + finished + ' / ' + items.length + ' tasks executed</strong><span>' + escape(statusText) + '</span></div><progress value="' + finished + '" max="' + Math.max(1,items.length) + '" aria-label="Tasks executed"></progress>');
    const button = el('execution-start');
    button.disabled = starting || paused || queued || allFinished;
    button.setAttribute('aria-busy',String(starting));
    button.innerHTML = '<svg><use href="#i-' + (allFinished ? 'check' : 'play') + '"/></svg>' + (starting ? 'Starting…' : paused ? 'Paused' : allFinished ? 'Outputs ready' : queued ? 'Agents working…' : data.enabled ? 'Continue tasks' : 'Run tasks');
    setHTML('execution-items',items.map(item => {
      const task = item.execution_task_id || item.task_id, output = item.current_artifact_id || item.artifact_id;
      const approved = item.status === 'done' && item.approval_status === 'approved';
      return '<li class="execution-item ' + escape(item.execution_status || 'pending') + '"><div class="execution-step-mark" aria-hidden="true">' + (['succeeded','completed'].includes(item.execution_status) ? '✓' : item.execution_status === 'running' ? '↻' : '○') + '</div><div class="execution-item-main"><strong>' + escape(item.title || item.key) + '</strong><span>' + escape(item.execution_agent || item.agent || 'Agent assigned from the graph when ready') + '</span><small>' + escape(taskState(item)) + (approved ? ' · Human approved' : item.status === 'done' ? ' · Human marked complete' : output ? ' · Awaiting your approval' : '') + '</small>' + (item.execution_error ? '<p class="form-error">' + escape(item.execution_error) + '</p>' : '') + '</div><div class="execution-item-actions">' + (output ? '<button type="button" class="text-button" data-execution-artifact="' + escape(output) + '" data-execution-case="' + escape(current) + '">View output</button>' : '') + (task ? '<button type="button" class="text-button" data-execution-task="' + escape(task) + '" data-execution-case="' + escape(current) + '">' + (approved ? 'View approval' : 'Review &amp; approve') + '</button>' : '') + '</div></li>';
    }).join(''));
    const currentOutputs = outputs.filter(output => output.current !== false), historicalOutputs = outputs.filter(output => output.current === false);
    setHTML('execution-outputs',outputs.length ? '<div class="execution-output-heading"><h4>Work the agents produced</h4><span>Saved in FalkorDB</span></div><div class="execution-output-grid">' + currentOutputs.map(outputCard).join('') + '</div>' + (historicalOutputs.length ? '<details class="execution-history"><summary>Earlier runs · ' + historicalOutputs.length + ' saved output(s)</summary><p class="form-hint">These outputs remain in the graph as history. Current tasks use the latest valid results shown above.</p><div class="execution-output-grid">' + historicalOutputs.map(outputCard).join('') + '</div></details>' : '') : '<div class="execution-empty"><svg><use href="#i-source"/></svg><div><strong>Your agents’ work will appear here.</strong><p>Open the generated page, read the documents and inspect the actual browser test report.</p></div></div>');
    setHTML('execution-handoffs',arr(data.handoffs).length ? arr(data.handoffs).map(handoff => '<article class="execution-handoff"><strong>' + escape(handoff.from_agent || 'Agent') + ' → ' + escape(handoff.to_agent || 'Agent') + '</strong><p>' + escape(handoff.summary || handoff.title || 'Saved prerequisite output shared with the next task') + '</p><small>' + escape(handoff.status || 'Saved') + (handoff.session_id && handoff.consumed_session_id && handoff.session_id !== handoff.consumed_session_id ? ' · Picked up in a later session' : '') + '</small></article>').join('') : '<p class="form-hint">The next agent receives the saved prerequisite files from the graph. Handoffs appear when work starts moving.</p>');
  }
  async function load(caseId = current) {
    if (!caseId) return;
    if (active?.caseId === caseId) return active.promise;
    const version = generation, request = {caseId,promise:null};
    request.promise = (async () => {
      try {
        const data = await api(endpoint(caseId));
        if (version !== generation) return;
        cache.set(caseId,data);
        if (caseId === current) { render(data); error(''); }
        return data;
      } catch (cause) { if (version === generation && caseId === current && cause.name !== 'StaleWorkspace') error(cause.message); }
      finally { if (active === request) active = null; }
    })();
    active = request; return request.promise;
  }
  function sync(item) {
    const recovery = item?.kind === 'recovery';
    el('execution-panel').hidden = !recovery;
    if (!recovery) { current = null; return; }
    if (current !== item.id) { current = item.id; shell(); }
    if (cache.has(current)) render(cache.get(current));
    void load(current);
  }
  async function start() {
    if (!current || starting) return;
    const caseId = current, version = generation;
    if (!requestIds.has(caseId)) requestIds.set(caseId,crypto.randomUUID());
    starting = true; el('execution-start').disabled = true; error('');
    try {
      await api(endpoint(caseId) + '/start',{request_id:requestIds.get(caseId)});
      if (version !== generation) return;
      requestIds.delete(caseId);
      await load(caseId); await refresh(true);
      notify('Tasks started. The agents will create outputs and pass them to the next eligible task.');
    } catch (cause) { if (version === generation && cause.name !== 'StaleWorkspace') { if (caseId === current) error(cause.message); else notify(cause.message,true); } }
    finally { if (version === generation) { starting = false; if (cache.has(current)) render(cache.get(current)); else if (el('execution-start')) el('execution-start').disabled = false; } }
  }
  function fileContent(file) { return typeof file.content === 'string' ? file.content : JSON.stringify(file.content ?? '',null,2); }
  function selectFile(index) {
    const file = arr(artifact?.files)[index]; if (!file) return;
    el('execution-file-select').value = String(index);
    el('execution-file-content').textContent = fileContent(file);
    const html = file.media_type?.split(';')[0] === 'text/html' || /\.html?$/i.test(file.path || '');
    const frame = el('execution-preview');
    frame.removeAttribute('srcdoc'); frame.hidden = !html;
    el('execution-preview-label').hidden = !html;
    el('execution-file-source').open = !html;
    if (html) {
      const document = new DOMParser().parseFromString(fileContent(file),'text/html');
      document.querySelectorAll('meta[http-equiv],base,iframe,frame,object,embed').forEach(node => node.remove());
      const policy = document.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
      document.head.prepend(policy);
      frame.srcdoc = '<!doctype html>' + document.documentElement.outerHTML;
    }
  }
  async function openArtifact(caseId, artifactId) {
    const version = generation, requestVersion = ++artifactVersion;
    artifact = null; artifactCase = caseId;
    el('execution-artifact-title').textContent = 'Loading saved output…';
    el('execution-artifact-body').hidden = true; el('execution-artifact-error').hidden = true;
    el('execution-preview').removeAttribute('srcdoc');
    if (!el('execution-artifact-dialog').open) el('execution-artifact-dialog').showModal();
    try {
      const result = await api(endpoint(caseId) + '/artifacts/' + encodeURIComponent(artifactId));
      if (generation !== version || requestVersion !== artifactVersion || !el('execution-artifact-dialog').open) return;
      artifact = result.artifact || result;
      if (arr(cache.get(caseId)?.artifacts).some(saved => saved.id === artifact.id && saved.current === false)) artifact.current = false;
      artifact.files = arr(parse(artifact.files));
      el('execution-artifact-title').textContent = artifact.title || 'Saved task output';
      el('execution-artifact-summary').textContent = summaryText(artifact.summary);
      el('execution-artifact-summary').title = artifact.summary || '';
      el('execution-artifact-byline').textContent = (artifact.current === false ? 'Historical output. ' : '') + 'Produced by ' + (artifact.agent || 'the agent team') + (artifact.created_at ? ' · ' + date(artifact.created_at,true) : '') + '. Human completion approval is recorded separately.';
      el('execution-artifact-checks').innerHTML = checksMarkup(artifact.checks);
      el('execution-file-select').innerHTML = artifact.files.map((file,index) => '<option value="' + index + '">' + escape(file.path) + '</option>').join('');
      el('execution-artifact-body').hidden = false;
      el('execution-artifact-review').hidden = !(artifact.task_id || artifact.execution_task_id);
      el('execution-artifact-review').textContent = artifact.current === false ? 'View saved review' : 'Review & approve';
      el('execution-artifact-review').dataset.executionTask = artifact.task_id || artifact.execution_task_id || '';
      el('execution-artifact-review').dataset.executionCase = caseId;
      selectFile(0);
    } catch (cause) { if (generation === version && requestVersion === artifactVersion && cause.name !== 'StaleWorkspace') { el('execution-artifact-error').textContent = cause.message; el('execution-artifact-error').hidden = false; } }
  }
  function download() {
    const file = arr(artifact?.files)[Number(el('execution-file-select').value)]; if (!file) return;
    const url = URL.createObjectURL(new Blob([fileContent(file)],{type:'application/octet-stream'}));
    const link = document.createElement('a'); link.href = url; link.download = String(file.path || 'output.txt').replaceAll('\\','/').split('/').pop();
    link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  document.addEventListener('click',event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.id === 'execution-start') return void start();
    if (button.dataset.executionArtifact) return void openArtifact(button.dataset.executionCase || current,button.dataset.executionArtifact);
    if (button.dataset.executionTask) { el('execution-artifact-dialog').close(); return window.RelayWorkGraph?.open(button.dataset.executionCase || current,button.dataset.executionTask); }
    if (button.id === 'execution-download') download();
  });
  el('execution-file-select').addEventListener('change',event => selectFile(Number(event.target.value)));
  el('execution-artifact-dialog').addEventListener('close',() => { artifactVersion++; artifact = null; artifactCase = null; el('execution-preview').removeAttribute('srcdoc'); });
  function reset() {
    generation++; artifactVersion++; current = null; active = null; starting = false; artifact = null; artifactCase = null;
    cache.clear(); requestIds.clear(); el('execution-panel').innerHTML = ''; el('execution-panel').hidden = true;
    el('execution-artifact-dialog').close(); el('execution-preview').removeAttribute('srcdoc');
  }
  return {sync,reset,load,openArtifact};
})();
