'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const list = value => Array.isArray(value) ? value : [];
const id = value => encodeURIComponent(value);
const uid = () => crypto.randomUUID();
const kinds = {semantic:'Known fact', procedural:'Playbook', episodic:'Past outcome'};
const roleLabels = {Researcher:'Investigation', Planner:'Resolution plan', Reviewer:'Evidence review'};
const roleIcons = {Researcher:'search', Planner:'list', Reviewer:'check'};
const phases = ['Researcher', 'Planner', 'Reviewer'];
let boot = {}, state = null, detail = null, token = '', selected = null;
let view = 'projects', caseTab = 'conversation', caseFilter = 'open', knowledgeKind = 'all';
let identityVersion = 0, activeFetch = null, polling = false, toastTimer = null;
let composerCase = null, dialogRecord = {}, lastSynced = null;
const busy = new Set(), drafts = new Map();

function date(value, full = false) {
  if (!value) return '';
  const parsed = new Date(typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString(undefined, full
    ? {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}
    : {month:'short', day:'numeric'});
}
function getStorage(storage, key) { try { return storage.getItem(key); } catch { return null; } }
function setStorage(storage, key, value) { try { value == null ? storage.removeItem(key) : storage.setItem(key, value); } catch {} }
function identityKey() { return (state?.principal?.tenant || '') + ':' + (state?.principal?.id || ''); }
function selectionKey() { return 'relay.case.' + identityKey(); }
function caseById(value) { return list(state?.cases).find(item => item.id === value); }
function memoryById(value) { return [...list(detail?.memories), ...list(state?.memories)].find(item => item.id === value); }
function memoryIsCurrent(memory) { return memory.current !== false && memory.retrieval_current !== false; }
function memoryStatus(memory) { return memory.current === false ? 'Earlier version' : memory.retrieval_current === false ? 'Source retired' : 'Current'; }
function artifactIsCurrent(artifact) {
  return artifact.evidence_current !== false && list(artifact.memory_ids).every(memoryId => {
    const memory = memoryById(memoryId);
    return !memory || memoryIsCurrent(memory);
  });
}
function selectedCase() { return detail?.case?.id === selected ? detail.case : caseById(selected); }
function descendants(key) {
  if (detail?.case?.id === selected && Array.isArray(detail[key])) return detail[key];
  return list(state?.[key]).filter(item => item.case_id === selected || item.origin_case_id === selected);
}
function sourceLabel(memory) {
  const sourceCase = caseById(memory.origin_case_id || memory.case_id);
  if (sourceCase) return sourceCase.title;
  if (memory.source_title || memory.source_label) return memory.source_title || memory.source_label;
  const source = memory.source || '';
  if (source && !/^(case|episode|src|mem)[_:]/i.test(source)) return source;
  return memory.origin_case_id ? 'A previously resolved case' : 'Linked source record';
}
function textHTML(value) {
  return esc(value).replace(/\[([A-Za-z0-9_:-]+)\]/g, (match, reference) => {
    const memory = memoryById(reference);
    return memory ? '<button type="button" class="citation-link" data-memory="' + esc(reference) + '">' + esc(memory.title) + '</button>' : match;
  }).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}
function html(target, value) {
  const element = $(target);
  if (element && element.dataset.rendered !== value) {
    element.innerHTML = value;
    element.dataset.rendered = value;
  }
}
function errorAt(target, message) {
  const element = $(target);
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || '';
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').hidden = false;
  $('toast').classList.toggle('error', error);
  $('toast').querySelector('span').textContent = message;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 6500);
}
function staleError() { const error = new Error('Workspace changed'); error.name = 'StaleWorkspace'; return error; }
async function api(path, body, bootstrap = false) {
  const version = identityVersion, requestToken = token, controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), body === undefined ? 20000 : 120000);
  try {
    const response = await fetch(bootstrap ? '/api/bootstrap' : path.startsWith('/api/projects') ? path : '/api/support/' + path, {
      method:body === undefined ? 'GET' : 'POST',
      headers:{'Content-Type':'application/json', ...(requestToken ? {Authorization:'Bearer ' + requestToken} : {})},
      body:body === undefined ? undefined : JSON.stringify(body), signal:controller.signal
    });
    if (version !== identityVersion) throw staleError();
    let data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Refresh to check saved work.'); }
    if (!response.ok) {
      const explanation = typeof data.detail === 'string' ? data.detail : list(data.detail).map(item => item.msg).filter(Boolean).join('; ');
      const error = new Error(explanation || 'The request could not be completed. Saved work remains available.');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (version !== identityVersion) throw staleError();
    if (error.name === 'AbortError') throw new Error('The request timed out. Your team may still be working; check the saved case progress before retrying.');
    if (error instanceof TypeError) throw new Error('We could not reach Relay. Saved work will reappear when the connection returns.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function syncBusy() {
  document.querySelectorAll('[data-busy-key]').forEach(button => {
    button.disabled = busy.has(button.dataset.busyKey);
    button.setAttribute('aria-busy', String(button.disabled));
  });
}
async function mutate(key, button, errorTarget, operation) {
  if (busy.has(key)) return;
  const version = identityVersion, errorCase = selected;
  busy.add(key);
  if (button) button.dataset.busyKey = key;
  syncBusy();
  errorAt(errorTarget, '');
  try {
    await operation();
    if (version !== identityVersion) return;
    await refresh(true);
  } catch (error) {
    if (error.name !== 'StaleWorkspace' && version === identityVersion) {
      const movedCase = ['case-error','chat-error','task-error'].includes(errorTarget) && selected !== errorCase;
      if (!movedCase) errorAt(errorTarget, error.message);
      if (!errorTarget || movedCase) notify(error.message, true);
      void refresh(true).catch(() => {});
    }
  } finally {
    busy.delete(key);
    syncBusy();
  }
}
async function refresh(force = false) {
  const version = identityVersion;
  if (!token) return;
  if (activeFetch?.version === version) {
    if (!force) return activeFetch.promise;
    await activeFetch.promise.catch(() => {});
    if (version !== identityVersion) return;
  }
  const request = {version, promise:null};
  request.promise = (async () => {
    try {
      const nextState = await api('state');
      if (version !== identityVersion) return;
      state = nextState;
      if (!selected || !caseById(selected)) {
        const remembered = getStorage(localStorage, selectionKey());
        selected = caseById(remembered)?.id || list(state.cases).find(item => item.resolution_status !== 'resolved')?.id || list(state.cases)[0]?.id || null;
        detail = null;
      }
      const requestedCase = selected;
      if (requestedCase) {
        try {
          const nextDetail = await api('cases/' + id(requestedCase));
          if (requestedCase === selected && version === identityVersion) detail = nextDetail;
        } catch (error) {
          if (error.name === 'StaleWorkspace') throw error;
          detail = null;
          errorAt('case-error', error.message);
        }
      }
      if (version !== identityVersion) return;
      lastSynced = new Date();
      errorAt('global-error', '');
      $('sync-dot').className = 'sync-dot connected';
      $('sync-label').textContent = 'Saved workspace · up to date';
      render();
    } catch (error) {
      if (error.name !== 'StaleWorkspace' && version === identityVersion) {
        errorAt('global-error', error.message);
        $('sync-dot').className = 'sync-dot error';
        $('sync-label').textContent = 'Connection interrupted';
      }
      throw error;
    } finally { if (activeFetch === request) activeFetch = null; }
  })();
  activeFetch = request;
  return request.promise;
}
function startPolling() {
  if (polling) return;
  polling = true;
  const poll = async () => {
    if (token && !document.hidden) await refresh().catch(() => {});
    setTimeout(poll, document.hidden ? 7000 : 2600);
  };
  setTimeout(poll, 2600);
}
function changeView(next) {
  view = ['projects','cases','graph','knowledge','activity'].includes(next) ? next : 'projects';
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
  });
  ['projects','cases','graph','knowledge','activity'].forEach(name => { $('view-' + name).hidden = name !== view; });
  $('page-label').textContent = {projects:'Projects',cases:'Cases',graph:'Work graph', knowledge:'Knowledge', activity:'Activity'}[view];
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'graph') window.RelayWorkGraph?.sync();
  if (view === 'projects') window.RelayProjects?.sync();
}
function selectCase(caseId, scroll = false) {
  if (!caseById(caseId)) return;
  saveDraft();
  selected = caseId;
  detail = null;
  caseTab = 'conversation';
  setStorage(localStorage, selectionKey(), selected);
  changeView('cases');
  errorAt('case-error', '');
  errorAt('chat-error', '');
  errorAt('task-error', '');
  renderCases();
  renderCase();
  void refresh(true).catch(() => {});
  if (scroll && matchMedia('(max-width:640px)').matches) $('case-workspace').scrollIntoView({behavior:'smooth', block:'start'});
}
function saveDraft() {
  if (composerCase) drafts.set(composerCase, $('chat-message').value);
}
function setCaseTab(next) {
  caseTab = next === 'plan' ? 'plan' : 'conversation';
  ['conversation','plan'].forEach(name => {
    $('tab-' + name).classList.toggle('active', caseTab === name);
    $('tab-' + name).setAttribute('aria-selected', String(caseTab === name));
    $('tab-' + name).tabIndex = caseTab === name ? 0 : -1;
    $('panel-' + name).hidden = caseTab !== name;
  });
}
function workflowLabel(item) {
  if (item.resolution_status === 'resolved') return 'Resolved';
  if (item.kind === 'recovery' && item.workflow_status === 'ready' && item.phase === 'Scout') return 'Ready to begin';
  if (item.workflow_status === 'running') return ({Researcher:'Investigating', Planner:'Making a plan', Scout:'Tracing blockers', Coordinator:'Coordinating recovery', Reviewer:'Checking the evidence'})[item.phase] || 'Working';
  return ({queued:'Queued', paused:'Paused', ready:'Ready for review', error:'Needs attention'})[item.workflow_status] || 'Open';
}
function statusMarkup(item) {
  const status = item.resolution_status === 'resolved' ? 'resolved' : item.workflow_status;
  return '<span class="status-label ' + esc(status) + '"><span class="status-dot"></span>' + esc(workflowLabel(item)) + '</span>';
}
function planFirstAction(plan, tasks) {
  const lines = String(plan.content || '').split('\n').map(line => line.trim().replace(/\*\*/g, '').replace(/^#{1,6}\s*/, ''));
  const index = lines.findIndex(line => /^(first|next) action(\s*:|$)/i.test(line));
  if (index !== -1) {
    const action = lines[index].replace(/^(first|next) action\s*:?\s*/i, '');
    if (action) return action;
    const following = lines.slice(index + 1).find(line => line.trim());
    if (following) return following;
  }
  return tasks[0]?.description || tasks[0]?.title || 'Read the complete plan to review the next action.';
}
function taskMarkup(task) {
  const historical = task.guidance_current === false;
  const status = task.approval_status === 'approved' || task.completion_basis === 'reviewed_approval' ? 'Approved complete' : ({todo:'To do',doing:'In progress',done:'Reported complete'})[task.status] || task.status;
  const note = task.guidance_notice || 'The source guidance changed. Review current evidence before further work.';
  return '<article class="task-row ' + esc(task.status) + (historical ? ' historical-guidance' : '') + '"><button type="button" class="task-check ' + (task.status === 'done' ? 'done' : '') + '" data-task="' + esc(task.id) + '" data-task-status="' + (task.status === 'done' ? 'todo' : 'done') + '" data-busy-key="task-' + esc(task.id) + '" aria-label="' + esc('Review task completion: ' + task.title) + '" aria-pressed="' + (task.status === 'done') + '">' + (task.status === 'done' ? icon('check') : '') + '</button><div class="task-content">'
    + (historical ? '<div class="guidance-notice"><strong>Historical guidance</strong><span>' + esc(note) + '</span></div>' : '')
    + '<div class="task-instructions"><h4>' + esc(task.title) + '</h4>' + (task.description ? '<p>' + textHTML(task.description) + '</p>' : '') + '</div><div class="task-meta"><span>' + (historical ? 'Recorded status: ' : '') + esc(status) + '</span>'
    + (!historical && task.status === 'todo' ? '<button type="button" class="text-button" data-task="' + esc(task.id) + '" data-task-status="doing" data-busy-key="task-' + esc(task.id) + '">Start task</button>' : '') + '</div>'
    + (task.evidence ? '<div class="task-evidence"><strong>Recorded evidence</strong><p>' + textHTML(task.evidence) + '</p></div>' : '') + '</div></article>';
}
function pendingLearning() { return list(state?.learning).filter(item => item.status === 'proposed'); }
function render() {
  if (!state) return;
  $('workspace-name').textContent = (state.principal?.tenant || 'Your') + ' workspace';
  $('workspace-member').textContent = state.principal?.name || 'Connected';
  $('workspace-initial').textContent = (state.principal?.tenant || 'R').charAt(0).toUpperCase();
  const provider = state.provider || boot.provider;
  $('provider').textContent = provider === 'demo' ? 'SCRIPTED DEMO' : String(provider || 'Connected').toUpperCase() + ' · LIVE MODEL';
  $('provider').classList.toggle('demo', provider === 'demo');
  $('case-count').textContent = list(state.cases).filter(item => item.resolution_status !== 'resolved').length || '';
  $('learning-dot').hidden = !pendingLearning().length;
  renderCases(); renderCase(); renderKnowledge(); renderActivity(); syncBusy(); window.RelayWorkGraph?.sync(); window.RelayProjects?.sync();
}
function renderCases() {
  const query = $('case-search').value.trim().toLowerCase();
  const all = list(state?.cases);
  const filtered = all.filter(item => (caseFilter === 'all' || (caseFilter === 'resolved') === (item.resolution_status === 'resolved')) && (item.title + ' ' + item.description).toLowerCase().includes(query));
  $('inbox-count').textContent = all.length;
  html('case-list', filtered.length ? filtered.map(item => {
    const tasks = list(state.tasks).filter(task => task.case_id === item.id);
    const executing = item.kind === 'recovery' && item.execution_enabled;
    const currentIds = new Set(executing ? list(state.jobs).filter(job => job.case_id === item.id && job.kind === 'execution' && job.run_id === item.execution_run_id).map(job => job.task_id) : []);
    const currentTasks = tasks.filter(task => currentIds.has(task.id));
    const produced = currentTasks.filter(task => task.execution_status === 'succeeded' && task.output_artifact_id).length;
    const approved = currentTasks.filter(task => task.status === 'done' && (task.approval_id || task.completion_basis === 'reviewed_approval')).length;
    const progress = executing ? produced + ' output' + (produced === 1 ? '' : 's') + ' · ' + approved + ' approved' : tasks.length ? tasks.filter(task => task.status === 'done').length + '/' + tasks.length + ' tasks' : '';
    return '<button type="button" class="case-item ' + (selected === item.id ? 'selected' : '') + '" data-case="' + esc(item.id) + '" aria-pressed="' + (selected === item.id) + '"><span class="case-item-top"><span>' + esc(item.visibility === 'private' ? 'Private case' : 'Shared case') + '</span><time>' + date(item.created_at) + '</time></span><span class="case-item-title">' + esc(item.title) + '</span><span class="case-item-excerpt">' + esc(item.description) + '</span><span class="case-item-bottom' + (executing ? ' case-execution-counts' : '') + '">' + statusMarkup(item) + '<span>' + (progress || icon(item.visibility === 'private' ? 'lock' : 'people')) + '</span></span></button>';
  }).join('') : '<div class="list-empty">' + icon('inbox') + '<strong>' + (all.length ? 'No matching cases.' : 'A fresh start.') + '</strong>' + (all.length ? 'Try another filter or search.' : 'Your first case starts something useful.') + '</div>');
}
function renderCase() {
  const item = selectedCase();
  window.RelayRecovery?.sync(item);
  window.RelayExecution?.sync(item);
  $('case-empty').hidden = !!item;
  $('case-detail').hidden = !item;
  if (!item) return;
  const draftKey = identityKey() + ':' + item.id;
  if (composerCase !== draftKey) {
    saveDraft();
    composerCase = draftKey;
    $('chat-message').value = drafts.get(draftKey) || '';
  }
  $('chat-form').querySelector('button[type="submit"]').dataset.busyKey = 'chat-' + item.id;
  const resolved = item.resolution_status === 'resolved';
  const waiting = ['paused','error'].includes(item.workflow_status);
  const showPause = !resolved && ['queued','running'].includes(item.workflow_status);
  const actionButtons = (showPause ? '<button type="button" class="button secondary small" data-action="pause" data-busy-key="case-control">' + icon('pause') + 'Pause team</button>' : '')
    + (!resolved && waiting ? '<button type="button" class="button primary small" data-action="resume" data-busy-key="case-control">' + icon('play') + (item.workflow_status === 'error' ? 'Retry work' : 'Continue work') + '</button>' : '')
    + (!resolved ? '<button type="button" class="button ' + (item.workflow_status === 'ready' ? 'primary' : 'secondary') + ' small" data-action="outcome">' + icon('check') + 'Record outcome</button>' : '');
  html('case-heading', '<div class="case-heading-main"><div class="case-overline">' + icon(item.visibility === 'private' ? 'lock' : 'people') + esc(item.visibility === 'private' ? 'Only you' : 'Shared with your workspace') + '<span>·</span><span>Started ' + date(item.created_at) + '</span></div><h2>' + esc(item.title) + '</h2><p class="case-description">' + esc(item.description) + '</p>' + (item.description?.length > 250 ? '<button type="button" class="text-button case-description-button" data-action="case-description">Read the full brief</button>' : '') + '</div><div class="case-heading-actions">' + actionButtons + '</div>');
  const artifacts = descendants('artifacts').slice().sort((a,b) => (a.stage ?? phases.indexOf(a.agent)) - (b.stage ?? phases.indexOf(b.agent)));
  const completed = new Set(artifacts.map(artifact => artifact.agent));
  if (item.kind === 'recovery') descendants('tasks').filter(task => task.task_kind === 'agent_execution' && task.execution_status === 'succeeded').forEach(task => completed.add(task.agent));
  const executionPhases = ['Writer','Contract Designer','Builder','Tester','Release Manager'];
  if (item.kind === 'recovery') descendants('tasks').filter(task => task.task_kind === 'execution_work' && task.execution_status === 'succeeded').forEach(task => completed.add(task.agent));
  const casePhases = item.kind === 'recovery' ? executionPhases : phases;
  const track = casePhases.map((phase,index) => {
    const done = completed.has(phase), current = !done && item.phase === phase && item.workflow_status === 'running';
    return (index ? '<span class="stage-join"></span>' : '') + '<span class="stage ' + (done ? 'completed' : current ? 'current' : '') + '"><span class="stage-circle">' + (done ? icon('check') : index + 1) + '</span>' + (item.kind === 'recovery' ? ['Write','Define','Build','Test','Package'][index] : ['Investigate','Make a plan','Check'][index]) + '</span>';
  }).join('');
  const staleGuidance = descendants('tasks').some(task => task.guidance_current === false) || artifacts.some(artifact => !artifactIsCurrent(artifact));
  const freshRecovery = item.kind === 'recovery' && !descendants('tasks').length;
  const note = resolved ? 'Outcome recorded' : staleGuidance ? 'Saved guidance needs a fresh review' : item.workflow_status === 'paused' ? 'Progress saved · ready to continue' : item.workflow_status === 'ready' ? (item.kind === 'recovery' ? (freshRecovery ? 'Ready — run tasks to create the outputs' : 'Saved work · inspect execution and outputs below') : 'Plan saved · your review is next') : item.workflow_status === 'error' ? 'Progress saved · needs a retry' : workflowLabel(item);
  html('case-status', '<div class="stage-track" aria-label="Case progress">' + track + '</div><span class="progress-note">' + icon(resolved ? 'check' : 'clock') + esc(note) + '</span>');
  if (item.latest_error) errorAt('case-error', item.latest_error);
  else if (!busy.has('case-control')) errorAt('case-error', '');
  renderConversation(item);
  html('case-artifacts', artifacts.map(artifact => '<button type="button" class="artifact-card' + (!artifactIsCurrent(artifact) ? ' historical-artifact' : '') + '" data-artifact="' + esc(artifact.id) + '"><span class="artifact-icon">' + icon(roleIcons[artifact.agent] || 'source') + '</span><div><b>' + esc(roleLabels[artifact.agent] || artifact.agent || 'Saved work') + '</b><small>' + (!artifactIsCurrent(artifact) ? 'Historical evidence · ' : '') + 'Saved ' + date(artifact.created_at, true) + ' · ' + list(artifact.memory_ids).length + ' linked memories</small></div>' + icon('chevron') + '</button>').join(''));
  const tasks = descendants('tasks').slice().sort((a,b) => a.position - b.position);
  $('task-count').textContent = tasks.length ? tasks.filter(task => task.status === 'done').length + '/' + tasks.length : '';
  const plan = artifacts.find(artifact => artifact.agent === 'Planner');
  const planCurrent = plan && artifactIsCurrent(plan) && !tasks.some(task => task.guidance_current === false);
  const firstAction = planCurrent ? planFirstAction(plan, tasks) : '';
  html('plan-summary', plan ? '<div class="plan-card' + (!planCurrent ? ' historical-plan' : '') + '"><div class="eyebrow">' + (planCurrent ? 'YOUR FIRST ACTION' : 'HISTORICAL PLAN') + '</div><p>' + (planCurrent ? textHTML(firstAction) : 'The guidance behind this saved plan changed. Review current evidence before continuing. Recorded task status and evidence are preserved.') + '</p><button type="button" class="text-button" data-artifact="' + esc(plan.id) + '">' + (planCurrent ? 'Read the complete plan ' : 'View the historical plan ') + icon('arrow') + '</button></div>' : '');
  html('task-list', tasks.length ? tasks.map(taskMarkup).join('') : '<div class="empty-panel">' + icon('list') + '<b>Your next steps will live here.</b>' + (item.workflow_status === 'paused' ? 'Continue the case to let your team prepare a plan.' : 'The team creates follow-up work as it prepares the resolution plan.') + '</div>');
  renderReceipts(artifacts);
  html('case-history', descendants('events').slice().sort((a,b) => b.created_at - a.created_at).slice(0,12).map(event => '<div class="history-item"><b>' + esc(eventTitle(event)) + '</b>' + (event.message ? '<p>' + esc(event.message) + '</p>' : '') + '<time>' + date(event.created_at, true) + '</time></div>').join('') || '<div class="history-item">Saved case activity will appear here.</div>');
  setCaseTab(caseTab); syncBusy();
}
function renderConversation(item) {
  const element = $('conversation'), nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
  const messages = descendants('messages').slice().sort((a,b) => a.created_at - b.created_at);
  const intro = messages.some(message => message.content === item.description) ? '' : '<div class="message user"><span class="message-avatar">' + icon('inbox') + '</span><div class="message-body"><div class="message-meta"><strong>Case brief</strong><time>' + date(item.created_at, true) + '</time></div><div class="message-content">' + textHTML(item.description) + '</div></div></div>';
  const outcome = item.resolution_status === 'resolved' && item.resolution ? '<div class="message outcome"><span class="message-avatar">' + icon('check') + '</span><div class="message-body"><div class="message-meta"><strong>Confirmed outcome</strong><time>' + date(item.resolved_at || item.updated_at, true) + '</time></div><div class="message-content">' + textHTML(item.resolution) + '</div></div></div>' : '';
  const content = intro + messages.map(message => {
    const user = message.role === 'user';
    const actor = list(boot.personas).find(person => person.id === message.actor);
    const name = user ? (message.author_name || message.name || (message.actor && message.actor !== state.principal?.id ? actor?.name || 'Teammate' : 'You')) : message.agent || 'Relay';
    return '<div class="message ' + (user ? 'user' : 'assistant') + '"><span class="message-avatar">' + (user ? esc(name.charAt(0).toUpperCase()) : icon('spark')) + '</span><div class="message-body"><div class="message-meta"><strong>' + esc(name) + '</strong><time>' + date(message.created_at, true) + '</time></div><div class="message-content">' + textHTML(message.content || message.message || '') + '</div></div></div>';
  }).join('') + outcome;
  const changed = element.dataset.rendered !== content;
  html('conversation', content);
  if (changed && nearBottom) element.scrollTop = element.scrollHeight;
}
function renderReceipts(artifacts) {
  const used = new Set(artifacts.flatMap(artifact => list(artifact.memory_ids)));
  const raw = list(detail?.case?.id === selected ? detail.memory_receipts : []);
  const receipts = new Map();
  raw.forEach(receipt => {
    const memory = receipt.memory || memoryById(receipt.memory_id || receipt.id);
    if (memory) receipts.set(memory.id, {...memory, influence:receipt.influence || receipt.explanation || receipt.applied_to || ''});
  });
  used.forEach(memoryId => { const memory = memoryById(memoryId); if (memory && !receipts.has(memoryId)) receipts.set(memoryId, memory); });
  html('memory-receipts', receipts.size ? [...receipts.values()].map(memory => {
    const historical = !memoryIsCurrent(memory);
    return '<article class="memory-receipt ' + esc(memory.kind) + (historical ? ' historical-memory' : '') + '"><div class="memory-kind">' + icon(memory.kind === 'episodic' ? 'clock' : memory.kind === 'procedural' ? 'list' : 'source') + esc(kinds[memory.kind] || 'Memory') + '<span>· v' + esc(memory.revision || 1) + '</span></div>' + (historical ? '<span class="historical-label">' + memoryStatus(memory) + '</span>' : '') + '<h4>' + esc(memory.title) + '</h4><p class="clamp">' + esc(memory.content) + '</p>' + (historical ? '<p class="receipt-history-note">Historical evidence; excluded from current guidance.</p>' : memory.influence ? '<p class="receipt-influence">' + esc(memory.influence) + '</p>' : '') + '<div class="receipt-source">' + icon('source') + '<span>' + esc(sourceLabel(memory)) + '</span></div><button type="button" class="text-button" data-memory="' + esc(memory.id) + '">See the evidence ' + icon('arrow') + '</button></article>';
  }).join('') : '<div class="rail-empty"><strong>A head start, when there’s a match.</strong>Relevant facts, past outcomes and playbooks appear here when the team uses them.</div>');
  const candidates = descendants('learning').filter(item => item.status === 'proposed');
  const anyCandidates = pendingLearning();
  html('case-learning', candidates.length ? candidates.map(item => '<div class="learning-mini">' + icon('spark') + '<h4>This case has something to teach.</h4><p>' + esc(item.title) + '</p><button type="button" class="button secondary" data-learning="' + esc(item.id) + '">Review the learning ' + icon('arrow') + '</button></div>').join('') : anyCandidates.length ? '<div class="learning-mini">' + icon('spark') + '<h4>A playbook is waiting for review.</h4><p>Approve what worked in a previous case before your team uses it again.</p><button type="button" class="button secondary" data-view="knowledge">Review team learning ' + icon('arrow') + '</button></div>' : '');
}
function renderKnowledge() {
  const proposed = pendingLearning();
  html('learning-queue', proposed.length ? '<div class="learning-queue"><div class="learning-queue-heading">' + icon('spark') + '<h2>' + proposed.length + ' ' + (proposed.length === 1 ? 'learning is' : 'learnings are') + ' ready for your review</h2></div><p>Review what worked before it becomes guidance for the next case.</p>' + proposed.map(item => '<div class="learning-row"><div><h3>' + esc(item.title) + '</h3><p>From ' + esc(caseById(item.case_id || item.origin_case_id)?.title || 'a confirmed case outcome') + '</p></div><button type="button" class="button secondary small" data-learning="' + esc(item.id) + '">Review & approve ' + icon('arrow') + '</button></div>').join('') + '</div>' : '');
  const query = $('knowledge-search').value.trim().toLowerCase();
  const memories = list(state?.memories).filter(memory => ($('show-history').checked || memoryIsCurrent(memory)) && (knowledgeKind === 'all' || memory.kind === knowledgeKind) && (memory.title + ' ' + memory.content).toLowerCase().includes(query));
  $('knowledge-count').textContent = memories.length + (memories.length === 1 ? ' memory' : ' memories');
  html('knowledge-list', memories.length ? memories.map(memory => '<article class="knowledge-row ' + (!memoryIsCurrent(memory) ? 'historical' : '') + '"><span class="knowledge-icon ' + esc(memory.kind) + '">' + icon(memory.kind === 'procedural' ? 'list' : memory.kind === 'episodic' ? 'clock' : 'source') + '</span><div class="knowledge-row-main"><h3>' + esc(memory.title) + '</h3><p>' + textHTML(memory.content) + '</p><div class="knowledge-meta"><span class="tag">' + esc(kinds[memory.kind] || memory.kind) + '</span><span>' + memoryStatus(memory) + ' · v' + esc(memory.revision || 1) + '</span><span>' + esc(sourceLabel(memory)) + '</span><span>' + (memory.visibility === 'private' ? 'Only you' : 'Workspace shared') + '</span></div></div><div class="knowledge-actions"><button type="button" class="button secondary small" data-memory="' + esc(memory.id) + '">View evidence</button>' + (memoryIsCurrent(memory) && (!memory.owner || memory.owner === state.principal?.id) ? '<button type="button" class="text-button" data-revise="' + esc(memory.id) + '">Improve ' + icon('arrow') + '</button>' : '') + '</div></article>').join('') : '<div class="empty-panel">' + icon('book') + '<b>' + (query || knowledgeKind !== 'all' ? 'No matching knowledge yet.' : 'Your team’s experience starts here.') + '</b>' + (query ? 'Try another search.' : 'Confirmed case outcomes and reviewed playbooks give the next case a head start.') + '</div>');
}
function eventTitle(event) {
  return event.title || ({created:'Case opened',case_created:'Case opened',completed:'Work saved',handoff:'Work handed forward',paused:'Team paused',resumed:'Work resumed',resolved:'Outcome recorded',learning_approved:'Playbook approved',memory_revised:'Learning updated',chat:'Conversation saved',task_updated:'Follow-up work updated',retry:'Retry recorded',error:'Work needs attention'})[event.kind] || String(event.kind || 'Saved activity').replaceAll('_', ' ');
}
function renderActivity() {
  const capabilities = state?.capabilities || {};
  const graphiti = capabilities.graphiti || capabilities.knowledge || {};
  let knowledgeStatus = typeof graphiti === 'string' ? graphiti : graphiti.detail || graphiti.status || graphiti.mode || (graphiti.enabled === false ? 'Not configured' : '');
  if (!knowledgeStatus) knowledgeStatus = 'See recorded indexing receipts below';
  const receiptStates = list(state?.episodes).reduce((counts, episode) => {
    const status = episode.ingestion_status || episode.index_status || episode.status;
    if (status) counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const receiptSummary = Object.entries(receiptStates).map(([status,count]) => count + ' ' + status.replaceAll('_',' ')).join(' · ');
  html('capability-status', '<div class="capability-card"><strong>Reasoning provider</strong><span>' + esc((state.provider || boot.provider) === 'demo' ? 'Scripted demo · synthetic example logic' : String(state.provider || boot.provider || 'Configured provider') + ' · live model') + '</span></div><div class="capability-card"><strong>Long-term indexing</strong><span>' + esc(knowledgeStatus) + (receiptSummary ? '<br>' + esc(receiptSummary) : '') + '</span></div><div class="capability-card"><strong>Last workspace sync</strong><span>' + (lastSynced ? esc(lastSynced.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})) + ' · saved FalkorDB state' : 'Waiting for connection') + '</span></div>');
  const needsIndexing = list(state?.episodes).filter(episode => ['blocked','error'].includes(episode.index_status));
  $('indexing-recovery').hidden = !needsIndexing.length;
  html('indexing-list', needsIndexing.map(episode => {
    const sourceCase = caseById(episode.case_id);
    return '<article class="indexing-row"><div><div class="indexing-row-title"><h3>' + esc(episode.title || sourceCase?.title || 'Saved case outcome') + '</h3><span class="indexing-status">' + (episode.index_status === 'blocked' ? 'Blocked' : 'Retry needed') + '</span></div>' + (sourceCase ? '<button type="button" class="text-button" data-case="' + esc(sourceCase.id) + '">Open saved case ' + icon('arrow') + '</button>' : '') + (episode.index_error ? '<details><summary>Why indexing needs attention</summary><p>' + esc(episode.index_error) + '</p></details>' : '') + '</div><button type="button" class="button secondary small" data-index-retry="' + esc(episode.id) + '" data-busy-key="episode-' + esc(episode.id) + '">' + icon('refresh') + 'Retry indexing</button></article>';
  }).join(''));
  const events = list(state?.events).slice().sort((a,b) => b.created_at - a.created_at).slice(0,40);
  html('activity-list', events.length ? events.map(event => '<article class="activity-row"><span class="activity-row-icon">' + icon(event.kind?.includes('learning') ? 'book' : event.kind?.includes('pause') ? 'pause' : 'check') + '</span><div><h3>' + esc(eventTitle(event)) + '</h3>' + (event.message ? '<p>' + esc(event.message) + '</p>' : '') + (caseById(event.case_id) ? '<button type="button" class="text-button" data-case="' + esc(event.case_id) + '">' + esc(caseById(event.case_id).title) + ' ' + icon('arrow') + '</button>' : '') + '<time>' + date(event.created_at,true) + '</time></div></article>').join('') : '<div class="empty-panel">' + icon('activity') + '<b>Work leaves a useful trail.</b>Saved progress, handoffs and learning will appear here as your team works.</div>');
}
function showDialog(name) {
  const dialog = $(name);
  if (!dialog.open) dialog.showModal();
}
function showMemory(memoryId) {
  const memory = memoryById(memoryId);
  if (!memory) { notify('This memory is not in the current visible workspace.', true); return; }
  $('inspect-eyebrow').textContent = (kinds[memory.kind] || 'Memory') + ' · ' + memoryStatus(memory) + ' · v' + (memory.revision || 1);
  $('inspect-title').textContent = memory.title;
  $('inspect-content').innerHTML = (!memoryIsCurrent(memory) ? '<div class="guidance-notice"><strong>' + memoryStatus(memory) + '</strong><span>This record is historical and is excluded from current guidance.</span></div>' : '') + textHTML(memory.content);
  const originId = memory.origin_case_id || memory.case_id;
  $('inspect-evidence').innerHTML = '<p><strong>Source:</strong> ' + esc(sourceLabel(memory)) + '</p>' + (caseById(originId) ? '<button type="button" class="text-button" data-origin-case="' + esc(originId) + '">Open the source case ' + icon('arrow') + '</button>' : '') + '<details><summary>Record details</summary><pre>' + esc(JSON.stringify({memory:memory.id,kind:memory.kind,source:memory.source || memory.source_id,revision:memory.revision,visibility:memory.visibility,origin_case:originId,created:date(memory.created_at,true)},null,2)) + '</pre></details>';
  showDialog('inspect-dialog');
}
function showArtifact(artifactId) {
  const artifact = [...descendants('artifacts'), ...list(state?.artifacts)].find(item => item.id === artifactId);
  if (!artifact) return;
  $('inspect-eyebrow').textContent = 'SAVED WORK · ' + (artifact.provider === 'demo' ? 'SCRIPTED DEMO' : String(artifact.provider || state.provider || '').toUpperCase());
  $('inspect-title').textContent = roleLabels[artifact.agent] || artifact.agent || 'Saved artifact';
  $('inspect-content').innerHTML = (!artifactIsCurrent(artifact) ? '<div class="guidance-notice"><strong>Historical evidence</strong><span>The evidence behind this artifact changed. Review current guidance before further work.</span></div>' : '') + textHTML(artifact.content);
  $('inspect-evidence').innerHTML = '<p>Saved ' + date(artifact.created_at,true) + '. This artifact retains the evidence used when it was written.</p><div class="evidence-links">' + list(artifact.memory_ids).map(memoryId => memoryById(memoryId) ? '<button type="button" class="citation-link" data-memory="' + esc(memoryId) + '">' + esc(memoryById(memoryId).title) + '</button>' : '').join('') + '</div><details><summary>Record details</summary><pre>' + esc(JSON.stringify({artifact:artifact.id,case:artifact.case_id,agent:artifact.agent,memory_ids:artifact.memory_ids,source_ids:artifact.source_ids},null,2)) + '</pre></details>';
  showDialog('inspect-dialog');
}
function openLearning(learningId) {
  const learning = [...descendants('learning'), ...list(state?.learning)].find(item => item.id === learningId);
  if (!learning) return;
  dialogRecord.learning = {...learning};
  $('learning-name').value = learning.title || 'A procedure worth reusing';
  $('learning-content').value = learning.content || learning.procedure || '';
  $('learning-origin').textContent = 'From ' + (caseById(learning.case_id || learning.origin_case_id)?.title || 'a confirmed case outcome') + '.';
  errorAt('learning-error',''); showDialog('learning-dialog');
}
function openRevision(memoryId) {
  const memory = memoryById(memoryId);
  if (!memory) return;
  if (!memoryIsCurrent(memory)) { notify('This record is historical. Review its current source before creating guidance.', true); return; }
  dialogRecord.memory = {...memory};
  $('revision-title').textContent = memory.kind === 'procedural' ? 'Improve this playbook.' : 'Keep this learning current.';
  $('revision-label').textContent = memory.title + ' · current version ' + (memory.revision || 1);
  $('revision-content').value = memory.content || '';
  $('revision-reason').value = '';
  errorAt('revision-error',''); showDialog('revision-dialog');
}
function requestId(form) {
  const fields = [...form.querySelectorAll('input,textarea,select')].map(field => field.value);
  const fingerprint = JSON.stringify(fields);
  if (form.dataset.requestFingerprint !== fingerprint) {
    form.dataset.requestId = uid();
    form.dataset.requestFingerprint = fingerprint;
  }
  return form.dataset.requestId || (form.dataset.requestId = uid());
}
async function guided(button) {
  await mutate('seed', button, 'global-error', async () => {
    const result = await api('seed', {});
    await refresh(true);
    caseFilter = 'all'; updateFilters();
    const first = result.case_id || result.case?.id || list(state.cases).find(item => /csv|import/i.test(item.title))?.id;
    if (first) selectCase(first);
    notify('Synthetic guided case loaded. Review the proposed playbook in Knowledge, then continue the paused case.');
  });
}
function updateFilters() {
  document.querySelectorAll('[data-filter]').forEach(button => {
    button.classList.toggle('active',button.dataset.filter === caseFilter);
    button.setAttribute('aria-pressed',String(button.dataset.filter === caseFilter));
  });
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.hasAttribute('data-close')) { button.closest('dialog').close(); return; }
  if (button.dataset.view) { changeView(button.dataset.view); return; }
  if (button.dataset.case) { selectCase(button.dataset.case, true); return; }
  if (button.dataset.originCase) { $('inspect-dialog').close(); caseFilter = 'all'; updateFilters(); selectCase(button.dataset.originCase, true); return; }
  if (button.dataset.filter) { caseFilter = button.dataset.filter; updateFilters(); renderCases(); return; }
  if (button.dataset.caseTab) { setCaseTab(button.dataset.caseTab); return; }
  if (button.dataset.kind) {
    knowledgeKind = button.dataset.kind;
    document.querySelectorAll('[data-kind]').forEach(item => { item.classList.toggle('active',item.dataset.kind === knowledgeKind); item.setAttribute('aria-pressed',String(item.dataset.kind === knowledgeKind)); });
    renderKnowledge(); return;
  }
  if (button.dataset.memory) { showMemory(button.dataset.memory); return; }
  if (button.dataset.artifact) { showArtifact(button.dataset.artifact); return; }
  if (button.dataset.learning) { openLearning(button.dataset.learning); return; }
  if (button.dataset.revise) { openRevision(button.dataset.revise); return; }
  if (button.dataset.indexRetry) {
    const episodeId = button.dataset.indexRetry;
    void mutate('episode-' + episodeId, button, 'indexing-error', async () => {
      const result = await api('episodes/' + id(episodeId) + '/retry', {});
      if (result.episode && state) {
        state.episodes = list(state.episodes).map(episode => episode.id === episodeId ? result.episode : episode);
        renderActivity();
      }
      notify('Indexing retry queued. The saved case is intact; your team will retry in the background.');
    });
    return;
  }
  if (button.dataset.task) {
    const task = descendants('tasks').find(item => item.id === button.dataset.task), caseId = selected;
    if (!task) return;
    if (button.dataset.taskStatus !== 'doing') { window.RelayWorkGraph?.open(caseId,task.id); return; }
    void mutate('task-' + task.id, button, 'task-error', async () => {
      await api('cases/' + id(caseId) + '/tasks/' + id(task.id), {status:button.dataset.taskStatus,expected_revision:task.revision});
    });
    return;
  }
  const action = button.dataset.action;
  if (action === 'case-graph') { window.RelayWorkGraph?.open(selected); return; }
  if (action === 'new-case') { errorAt('new-case-error',''); showDialog('new-case-dialog'); }
  if (action === 'guided') void guided(button);
  if (action === 'outcome') {
    dialogRecord.case = {...selectedCase()};
    $('outcome-case-label').textContent = selectedCase()?.title || '';
    $('outcome-text').value = '';
    errorAt('outcome-error',''); showDialog('outcome-dialog');
  }
  if (action === 'case-description') {
    $('inspect-eyebrow').textContent = 'CASE BRIEF';
    $('inspect-title').textContent = selectedCase().title;
    $('inspect-content').textContent = selectedCase().description;
    $('inspect-evidence').innerHTML = '';
    showDialog('inspect-dialog');
  }
  if (action === 'pause' || action === 'resume') {
    const caseId = selected;
    void mutate('case-control', button, 'case-error', async () => {
      await api('cases/' + id(caseId) + '/' + action, {});
      notify(action === 'pause' ? 'Progress saved. Continue this case whenever you’re ready.' : 'Your team is continuing from the saved work.');
    });
  }
});
$('new-case-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget, fingerprint = JSON.stringify([$('new-title').value,$('new-description').value,$('new-visibility').value]);
  const body = {title:$('new-title').value.trim(),description:$('new-description').value.trim(),visibility:$('new-visibility').value,request_id:requestId(form)};
  void mutate('new-case', event.submitter, 'new-case-error', async () => {
    const result = await api('cases', body);
    selected = result.id || result.case?.id || result.case_id;
    setStorage(localStorage, selectionKey(), selected);
    detail = null; caseFilter = 'open'; updateFilters(); changeView('cases');
    if (fingerprint === JSON.stringify([$('new-title').value,$('new-description').value,$('new-visibility').value])) form.reset();
    $('new-case-dialog').close();
    delete form.dataset.requestId; delete form.dataset.requestFingerprint;
    notify('Case opened. Your team is picking it up.');
  });
});
$('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!selected) return;
  const form = event.currentTarget, caseId = selected, message = $('chat-message').value.trim(), draftKey = composerCase;
  if (!message) return;
  const body = {message, request_id:requestId(form)};
  void mutate('chat-' + caseId, event.submitter, 'chat-error', async () => {
    await api('cases/' + id(caseId) + '/chat', body);
    if (composerCase === draftKey && $('chat-message').value.trim() === message) $('chat-message').value = '';
    if (drafts.get(draftKey)?.trim() === message) drafts.delete(draftKey);
    delete form.dataset.requestId; delete form.dataset.requestFingerprint;
    notify('Your conversation is saved with the case.');
  });
});
$('outcome-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget, caseId = dialogRecord.case?.id;
  if (!caseId) return;
  const body = {resolution:$('outcome-text').value.trim(),request_id:requestId(form)};
  void mutate('outcome-' + caseId, event.submitter, 'outcome-error', async () => {
    await api('cases/' + id(caseId) + '/resolve', body);
    $('outcome-dialog').close(); form.reset();
    delete form.dataset.requestId; delete form.dataset.requestFingerprint;
    caseFilter = 'all'; updateFilters();
    notify('Outcome recorded. Review proposed learning in Knowledge when it is ready.');
  });
});
$('learning-form').addEventListener('submit', event => {
  event.preventDefault();
  const learning = dialogRecord.learning;
  if (!learning) return;
  const body = {expected_revision:learning.revision,title:$('learning-name').value.trim(),content:$('learning-content').value.trim()};
  void mutate('learning-' + learning.id, event.submitter, 'learning-error', async () => {
    await api('learning/' + id(learning.id) + '/approve', body);
    $('learning-dialog').close();
    notify('Playbook approved. Future related work can use this learning.');
  });
});
$('revision-form').addEventListener('submit', event => {
  event.preventDefault();
  const memory = dialogRecord.memory;
  if (!memory) return;
  const body = {content:$('revision-content').value.trim(),expected_revision:memory.revision,reason:$('revision-reason').value.trim()};
  void mutate('revision-' + memory.id, event.submitter, 'revision-error', async () => {
    await api('memories/' + id(memory.id) + '/revise', body);
    $('revision-dialog').close();
    notify('New version saved. Earlier evidence remains in history.');
  });
});
$('workers-form').addEventListener('submit', event => {
  event.preventDefault();
  void mutate('workers', event.submitter, 'workers-error', async () => {
    const result = await api('workers/run', {workers:Number($('worker-count').value),limit:24});
    $('workers-result').hidden = false;
    $('workers-result').textContent = (result.claimed ?? 0) + ' jobs claimed · ' + (result.completed ?? 0) + ' results saved in this invocation.' + (result.elapsed_ms != null ? ' Measured duration: ' + Number(result.elapsed_ms).toLocaleString() + ' ms.' : '');
  });
});
$('case-search').addEventListener('input',renderCases);
$('knowledge-search').addEventListener('input',renderKnowledge);
$('show-history').addEventListener('change',renderKnowledge);
$('chat-message').addEventListener('input',saveDraft);
$('chat-message').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('chat-form').requestSubmit(); });
$('refresh').addEventListener('click', () => { void mutate('refresh', $('refresh'), 'global-error', async () => { await refresh(true); notify('Workspace refreshed from saved state.'); }); });
document.querySelector('.case-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault(); setCaseTab(caseTab === 'conversation' ? 'plan' : 'conversation'); $('tab-' + caseTab).focus();
});
window.addEventListener('hashchange',() => changeView(location.hash.slice(1)));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || dialog.id === 'auth-dialog') return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});
async function switchIdentity(nextToken) {
  saveDraft(); identityVersion++; token = nextToken; selected = null; state = null; detail = null; composerCase = null;
  window.RelayWorkGraph?.reset();
  window.RelayRecovery?.reset();
  window.RelayExecution?.reset();
  window.RelayProjects?.reset();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  document.querySelectorAll('dialog form').forEach(form => { form.reset(); delete form.dataset.requestId; delete form.dataset.requestFingerprint; });
  dialogRecord = {};
  $('chat-message').value = ''; $('case-detail').hidden = true; $('case-empty').hidden = false;
  html('case-list','<div class="list-empty">Opening this workspace…</div>');
  ['case-heading','case-status','conversation','case-artifacts','plan-summary','task-list','memory-receipts','case-learning','case-history','knowledge-list','learning-queue','activity-list','capability-status','indexing-list'].forEach(target => html(target,''));
  $('indexing-recovery').hidden = true; errorAt('indexing-error','');
  $('inspect-title').textContent = ''; $('inspect-content').textContent = ''; $('inspect-evidence').textContent = '';
  $('workers-result').hidden = true;
  errorAt('case-error',''); errorAt('chat-error',''); errorAt('global-error','');
  try { await refresh(true); } catch {}
}
$('persona').addEventListener('change', () => {
  setStorage(localStorage,'agentmemory.persona',$('persona').value);
  void switchIdentity($('persona').value);
});
$('auth-form').addEventListener('submit', event => {
  event.preventDefault();
  const nextToken = $('auth-token').value.trim();
  void mutate('auth',event.submitter,'auth-error',async () => {
    token = nextToken;
    await refresh(true);
    setStorage(sessionStorage,'relay.access',token);
    $('auth-token').value = ''; $('auth-dialog').close(); startPolling();
  });
});
async function initialize() {
  changeView(location.hash.slice(1));
  try {
    boot = await api('',undefined,true);
    document.querySelectorAll('[data-demo-only]').forEach(element => { element.hidden = !boot.demo_mode; });
    const personas = list(boot.personas);
    if (personas.length) {
      $('persona').innerHTML = personas.map(person => '<option value="' + esc(person.token) + '">' + esc(person.name) + '</option>').join('');
      const saved = getStorage(localStorage,'agentmemory.persona');
      token = personas.some(person => person.token === saved) ? saved : personas[0].token;
      $('persona').value = token;
    } else {
      $('persona').innerHTML = '<option>Authenticated workspace</option>';
      $('persona').disabled = true;
      token = getStorage(sessionStorage,'relay.access') || '';
      if (!token) { showDialog('auth-dialog'); return; }
    }
    await refresh(true); startPolling();
  } catch (error) {
    errorAt('global-error',error.message);
    $('provider').textContent = 'CONNECTION INTERRUPTED';
    if (!list(boot.personas).length && boot.provider) showDialog('auth-dialog');
    startPolling();
  }
}
void initialize();
