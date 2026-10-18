'use strict';

(function (root) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const array = value => Array.isArray(value) ? value : [];
  const tools = {write_document:'Write a document',design_contract:'Define a signup contract',build_page:'Build a signup page',test_page:'Run browser tests',package_release:'Package a local release'};
  const symbol = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const text = value => escape(value).replace(/\n/g,'<br>');

  function parsePlan(content) {
    let plan;
    try { plan = JSON.parse(content); } catch { throw new Error('Choose the plan JSON exported from Automate. This file is not valid JSON.'); }
    if (!plan || plan.schema_version !== 1 || !Number.isInteger(plan.version) || plan.version < 1 || typeof plan.plan_id !== 'string' || !plan.plan_id || typeof plan.title !== 'string' || !plan.title.trim()) throw new Error('The file needs a version 1 plan with a title, plan ID and version. Export the plan again from Automate.');
    if (!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 40) throw new Error('A project plan needs between 1 and 40 tasks.');
    const ids = new Set();
    for (const task of plan.tasks) {
      if (!task || typeof task.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(task.id) || ids.has(task.id) || typeof task.title !== 'string' || !task.title.trim()) throw new Error('Each task needs a title and a unique ID starting with a letter or number. IDs can include hyphens, dots or underscores.');
      if (!Object.hasOwn(tools,task.capability)) throw new Error('Task "' + task.title + '" needs a supported Relay tool. Adjust the plan in Automate before importing it.');
      if (!Array.isArray(task.depends_on) || new Set(task.depends_on).size !== task.depends_on.length) throw new Error('Each task must list its unique prerequisites in depends_on.');
      ids.add(task.id);
    }
    if (plan.tasks.reduce((sum,t) => sum + t.depends_on.length,0) > 80) throw new Error('A project plan supports at most 80 prerequisites.');
    const tasks = new Map(plan.tasks.map(task => [task.id,task])), visited = new Set(), path = new Set();
    function visit(taskId) {
      if (path.has(taskId)) throw new Error('This plan contains a dependency cycle. Each task must be able to run after its prerequisites.');
      if (visited.has(taskId)) return;
      if (!tasks.has(taskId)) throw new Error('A task refers to a prerequisite that is missing from the plan.');
      path.add(taskId); tasks.get(taskId).depends_on.forEach(visit); path.delete(taskId); visited.add(taskId);
    }
    ids.forEach(visit);
    return plan;
  }
  function startBody(project,plan,item,requestId) {
    const taskId = item?.key;
    if (!item?.can_start || !array(plan?.tasks).some(task => task.id === taskId)) throw new Error('This task is not ready to run. Refresh the project to see its current prerequisites.');
    if (!Number.isInteger(project?.revision) || !Number.isInteger(plan?.version)) throw new Error('Refresh the project before approving this task.');
    return {task_id:taskId,expected_revision:project.revision,plan_version:plan.version,approved:true,request_id:requestId};
  }
  function taskCard(item,task,artifacts,caseId) {
    const outputId = item.current_artifact_id || item.artifact_id;
    const output = array(artifacts).find(a => a.id === outputId && a.current !== false);
    const oldOutput = outputId && !output;
    const status = item.execution_status || 'not_started';
    const success = ['succeeded','completed'].includes(status) && output;
    const approved = success && item.status === 'done' && item.approval_status === 'approved';
    const label = success ? 'Output ready' : oldOutput ? 'Earlier output · new work required' : ({running:'Agent working',queued:'Queued for execution',pending:'Waiting to run',failed:'Execution failed',blocked:'Waiting on prerequisites',stale:'New work required'})[status] || (item.can_start ? 'Ready for your approval' : 'Waiting to run');
    const taskId = item.execution_task_id || item.task_id;
    const owner = item.owner?.name || task.owner?.name;
    const agent = item.execution_agent || item.agent;
    const description = item.description || task.description;
    return '<article class="project-task-card ' + (success ? 'has-output' : item.can_start ? 'is-ready' : '') + '" data-project-task="' + escape(task.id) + '"><div class="project-task-top"><span class="project-task-state ' + (success ? 'output' : status === 'running' || status === 'queued' ? 'running' : item.can_start ? 'ready' : '') + '">' + symbol(success ? 'source' : status === 'running' ? 'activity' : item.can_start ? 'play' : 'clock') + escape(label) + '</span><span class="project-task-tool">' + escape(tools[task.capability] || task.capability) + '</span></div><h3>' + escape(task.title || item.title) + '</h3>'
      + (description ? '<p class="project-task-description">' + text(description) + '</p>' : '')
      + '<div class="project-task-meta">' + (owner ? '<span>' + symbol('people') + escape(owner) + '</span>' : '') + (agent ? '<span>' + escape(agent) + '</span>' : '') + (array(task.depends_on).length ? '<span>' + array(task.depends_on).length + ' prerequisite' + (task.depends_on.length > 1 ? 's' : '') + '</span>' : '') + '</div>'
      + (item.blocked_reason && !success ? '<p class="project-task-blocked">' + escape(item.blocked_reason) + '</p>' : '')
      + (item.execution_error ? '<p class="form-error">' + escape(item.execution_error) + '</p>' : '')
      + (array(task.acceptance_criteria).length ? '<details class="project-task-criteria"><summary>What good looks like</summary><ul>' + task.acceptance_criteria.map(c => '<li>' + escape(c) + '</li>').join('') + '</ul></details>' : '')
      + (success ? '<p class="project-completion-note">' + symbol(approved ? 'check' : 'clock') + (approved ? 'Completion approved' : 'Human review pending') + '</p>' : '')
      + '<div class="project-task-actions">'
      + (item.can_start === true ? '<button type="button" class="button primary small" data-project-start="' + escape(task.id) + '">' + symbol('play') + 'Approve &amp; run task</button>' : '')
      + (output ? '<button type="button" class="button secondary small" data-execution-artifact="' + escape(output.id) + '" data-execution-case="' + escape(caseId) + '">' + symbol('source') + 'Open output</button>' : '')
      + (success && taskId ? '<button type="button" class="text-button" data-execution-task="' + escape(taskId) + '" data-execution-case="' + escape(caseId) + '">' + (approved ? 'View approval' : 'Review completion') + '</button>' : '')
      + '<button type="button" class="text-button" data-project-revise="' + escape(task.id) + '">Request revision</button></div></article>';
  }
  const model = {parsePlan,startBody,taskCard,tools};
  if (typeof module !== 'undefined' && module.exports) { module.exports = model; return; }

  root.RelayProjects = (() => {
    const el = id => document.getElementById(id);
    let generation = 0, active = null, current = null, data = null, projects = [], stale = false;
    let createMode = 'manual', importedPlan = null, fileVersion = 0, lastListAt = 0, creating = false, sending = false;
    const requests = new Map(), running = new Set(), messageDrafts = new Map();
    let editorTasks = [], nextTaskNumber = 0;
    const endpoint = projectId => '/api/projects' + (projectId ? '/' + encodeURIComponent(projectId) : '');
    function setHTML(target,value) { const node = el(target); if (node.dataset.rendered !== value) { node.innerHTML = value; node.dataset.rendered = value; } }
    function error(target,message) { el(target).textContent = message || ''; el(target).hidden = !message; }
    function requestId(key,body) { const fingerprint = JSON.stringify(body), saved = requests.get(key); if (saved?.fingerprint === fingerprint) return saved.id; const value = {id:crypto.randomUUID(),fingerprint}; requests.set(key,value); return value.id; }
    function caseId() { return data?.case?.id || data?.project?.case_id; }
    function currentArtifacts() { return array(data?.execution?.artifacts); }
    function itemFor(taskId) { return array(data?.items).find(item => item.key === taskId); }
    function renderList() {
      const query = el('projects-search').value.trim().toLowerCase();
      const filtered = projects.filter(p => (p.title + ' ' + (p.description || '')).toLowerCase().includes(query));
      el('project-count').textContent = projects.length || '';
      el('projects-total').textContent = projects.length;
      setHTML('projects-list',filtered.length ? filtered.map(project => '<article class="project-card"><div class="project-card-top"><span class="project-card-mark">' + symbol('graph') + '</span><span class="project-card-visibility">' + symbol(project.visibility === 'private' ? 'lock' : 'people') + (project.visibility === 'private' ? 'Only you' : 'Workspace') + '</span></div><h3><button type="button" data-project-open="' + escape(project.id) + '">' + escape(project.title) + '</button></h3><p>' + escape(project.description) + '</p><div class="project-card-footer"><span>Plan v' + escape(project.plan_version || 1) + (project.task_count != null ? ' · ' + escape(project.task_count) + ' tasks' : '') + '</span><button type="button" class="text-button" data-project-open="' + escape(project.id) + '">Open project ' + symbol('arrow') + '</button></div></article>').join('') : '<div class="projects-empty">' + symbol(query ? 'search' : 'list') + '<h3>' + (query ? 'No matching projects' : 'Your next project starts here') + '</h3><p>' + (query ? 'Try another name or clear your search.' : 'Create a plan here, or upload one from Automate. Your team will wait for your approval before running each task.') + '</p>' + (query ? '' : '<button type="button" class="button primary" data-project-create="manual">' + symbol('plus') + 'Create your first project</button>') + '</div>');
    }
    function renderWorkspace() {
      el('projects-dashboard').hidden = !!current;
      el('project-workspace').hidden = !current;
      if (!current) return;
      if (!data || data.project?.id !== current) {
        setHTML('project-heading','<h1>Opening project...</h1>'); setHTML('project-thread','<p class="project-loading">Reading the saved project plan and task state...</p>');
        setHTML('project-plan-summary',''); setHTML('project-attempts',''); el('project-send').disabled = true; return;
      }
      const project = data.project, plan = data.plan || {}, artifacts = currentArtifacts(), rows = array(data.items);
      const ready = stale ? 0 : rows.filter(item => item.can_start === true).length;
      const working = rows.some(item => ['running','queued'].includes(item.execution_status));
      setHTML('project-heading','<div><div class="project-heading-meta"><span>' + (project.visibility === 'private' ? 'Private project' : 'Workspace project') + '</span><span>Attempt ' + Math.max(1,array(data.attempts).length) + '</span><span>Plan v' + escape(plan.version) + '</span></div><h1>' + escape(project.title) + '</h1><p>' + escape(project.description) + '</p></div><div class="project-heading-actions"><button type="button" class="button secondary small" data-project-graph="' + escape(caseId()) + '">' + symbol('graph') + 'Open work graph</button></div>');
      el('project-chat-status').textContent = stale ? 'Refresh needed' : working ? 'Agents working' : ready ? ready + ' task' + (ready === 1 ? '' : 's') + ' ready for approval' : 'Saved with your project';
      const messages = array(data.messages).slice().sort((a,b) => (a.created_at || 0) - (b.created_at || 0));
      const messageHTML = messages.map(message => '<article class="project-message ' + (message.role === 'user' ? 'user' : 'assistant') + '"><span class="project-message-avatar">' + symbol(message.role === 'user' ? 'people' : 'spark') + '</span><div><div class="project-message-meta"><strong>' + escape(message.role === 'user' ? (message.actor === state?.principal?.id ? 'You' : message.author_name || message.actor || 'Teammate') : message.agent || 'Relay') + '</strong><time>' + escape(date(message.created_at,true)) + '</time></div><p>' + text(message.content || message.message) + '</p></div></article>').join('');
      const cards = array(plan.tasks).map(task => {
        const item = itemFor(task.id) || {key:task.id,can_start:false,blocked_reason:'Reading task state. Refresh before approving execution.'};
        return taskCard(stale ? {...item,can_start:false,blocked_reason:'Refresh the project to confirm current state.'} : item,task,artifacts,caseId());
      }).join('');
      setHTML('project-thread',messageHTML + '<div class="project-team-message"><div class="project-message-meta"><span class="project-message-avatar">' + symbol('spark') + '</span><strong>Your team’s work</strong><span>Current attempt</span></div><p class="project-approval-help">Review each task below. “Approve &amp; run task” authorizes its agent to create the output. Tasks with prerequisites wait for those outputs.</p><div class="project-task-cards">' + cards + '</div></div>');
      const names = new Map(array(plan.tasks).map(task => [task.id,task.title]));
      setHTML('project-plan-summary','<div class="project-rail-eyebrow">THE PLAN</div><h2>' + array(plan.tasks).length + ' steps to the goal</h2><ol class="project-plan-steps">' + array(plan.tasks).map(task => '<li><button type="button" data-project-scroll="' + escape(task.id) + '">' + escape(task.title) + '</button><span>' + escape(task.owner?.name || tools[task.capability] || '') + '</span>' + (array(task.depends_on).length ? '<small>After ' + task.depends_on.map(dep => escape(names.get(dep) || dep)).join(', ') + '</small>' : '') + '</li>').join('') + '</ol>' + (array(plan.assumptions).length ? '<details class="project-assumptions"><summary>Plan assumptions</summary><ul>' + plan.assumptions.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul></details>' : '') + '<div class="project-plan-origin">' + symbol('source') + '<div><strong>' + (plan.provenance?.source === 'automate' ? 'Planned in Automate' : 'Planned in Relay') + '</strong><span>Plan v' + escape(plan.version) + (plan.provenance?.source_tenant ? ' · ' + escape(plan.provenance.source_tenant) : '') + '</span></div></div>');
      const history = array(data.attempts).filter(attempt => attempt.current === false || attempt.case_id !== caseId());
      setHTML('project-attempts',history.length ? '<details class="project-history"><summary>Earlier attempts · ' + history.length + '</summary><p>Saved outputs and decisions stay with their original attempt.</p>' + history.map(attempt => '<button type="button" class="text-button" data-project-history="' + escape(attempt.case_id) + '">Plan v' + escape(attempt.plan_version) + symbol('arrow') + '</button>').join('') + '</details>' : '');
      const selectedTask = el('project-revision-task').value;
      setHTML('project-revision-task',array(plan.tasks).map(task => '<option value="' + escape(task.id) + '">' + escape(task.title) + '</option>').join(''));
      if (names.has(selectedTask)) el('project-revision-task').value = selectedTask;
      el('project-send').disabled = sending || stale;
      running.forEach(taskId => { const button = [...el('project-thread').querySelectorAll('[data-project-start]')].find(b => b.dataset.projectStart === taskId); if (button) { button.disabled = true; button.textContent = 'Starting agent...'; } });
    }
    async function load(force = false) {
      if (typeof token === 'undefined' || !token || typeof state === 'undefined' || !state) return;
      if (active) { if (!force) return active; await active.catch(() => {}); }
      const version = generation, projectId = current;
      const promise = (async () => {
        try {
          const fetchList = force || !lastListAt || Date.now() - lastListAt > 8000;
          const [listResult,detailResult] = await Promise.all([fetchList ? api(endpoint()) : null,projectId ? api(endpoint(projectId)) : null]);
          if (version !== generation) return;
          if (listResult) { projects = array(listResult.projects); lastListAt = Date.now(); renderList(); }
          if (projectId === current && detailResult) { data = detailResult; stale = false; renderWorkspace(); }
          error('projects-error','');
        } catch (cause) {
          if (version !== generation || cause.name === 'StaleWorkspace') return;
          if ([401,403,404].includes(cause.status)) { reset(); root.RelayExecution?.reset(); error('projects-error',cause.message); return; }
          stale = true; if (projectId === current) renderWorkspace(); error('projects-error',cause.message);
        } finally { if (active === promise) active = null; }
      })();
      active = promise; return promise;
    }
    function sync() { if (!el('view-projects').hidden) void load(); }
    async function open(projectId) {
      if (current) messageDrafts.set(current,el('project-message').value);
      current = projectId; data = null; stale = false;
      el('project-message').value = messageDrafts.get(projectId) || ''; el('project-chat-mode').value = 'status'; setComposerMode();
      error('project-chat-error',''); changeView('projects'); renderWorkspace(); await load(true);
    }
    function back() { if (current) messageDrafts.set(current,el('project-message').value); current = null; data = null; renderWorkspace(); void load(true); }
    async function start(taskId) {
      if (!data || stale || running.has(taskId)) return;
      const projectId = current, version = generation, item = itemFor(taskId), key = 'start:' + projectId + ':' + taskId;
      try {
        const body = startBody(data.project,data.plan,item,''); body.request_id = requestId(key,{...body,request_id:undefined});
        running.add(taskId); renderWorkspace(); error('project-chat-error','');
        await api(endpoint(projectId) + '/start',body);
        if (version !== generation) return;
        requests.delete(key); await load(true); await refresh(true);
        notify('Task approved. The agent is now queued to produce its output.');
      } catch (cause) {
        if (version === generation && cause.name !== 'StaleWorkspace') { if (current === projectId) error('project-chat-error',cause.message); else notify(cause.message,true); await load(true); }
      } finally { if (version === generation) { running.delete(taskId); renderWorkspace(); } }
    }
    function setComposerMode() {
      const revise = el('project-chat-mode').value === 'revise';
      el('project-revision-options').hidden = !revise;
      el('project-send').innerHTML = (revise ? 'Save revision' : 'Send') + symbol('arrow');
      el('project-message').placeholder = revise ? 'Describe what should change in the next attempt...' : 'What is ready to run? What is waiting on another task?';
    }
    async function send(event) {
      event.preventDefault(); if (!data || sending || stale) return;
      const message = el('project-message').value.trim(); if (!message) return;
      const projectId = current, version = generation, revise = el('project-chat-mode').value === 'revise', task = el('project-revision-task').value;
      const body = revise ? {prompt:message,expected_revision:data.project.revision,task_id:task} : {message,mode:'status'};
      const key = 'chat:' + projectId; body.request_id = requestId(key,body); sending = true; el('project-send').disabled = true; error('project-chat-error','');
      try {
        await api(endpoint(projectId) + (revise ? '/revisions' : '/chat'),body);
        if (version !== generation) return;
        requests.delete(key);
        if (current === projectId && el('project-message').value.trim() === message) { el('project-message').value = ''; messageDrafts.delete(projectId); }
        await load(true); await refresh(true);
        if (revise) notify('New attempt saved. Review the revised tasks and approve each one before it runs.');
      } catch (cause) { if (version === generation && cause.name !== 'StaleWorkspace') { if (current === projectId) error('project-chat-error',cause.message); else notify(cause.message,true); } }
      finally { if (version === generation) { sending = false; renderWorkspace(); } }
    }
    function saveEditor() {
      el('project-task-editor').querySelectorAll('[data-editor-task]').forEach(row => {
        const task = editorTasks.find(value => value.id === row.dataset.editorTask); if (!task) return;
        task.title = row.querySelector('[data-field="title"]').value;
        task.description = row.querySelector('[data-field="description"]').value;
        task.capability = row.querySelector('[data-field="capability"]').value;
        task.depends_on = [...row.querySelector('[data-field="depends_on"]').selectedOptions].map(option => option.value);
      });
    }
    function renderEditor() {
      el('project-task-editor').innerHTML = editorTasks.map((task,index) => '<fieldset class="project-editor-task" data-editor-task="' + escape(task.id) + '"><legend>Task ' + (index + 1) + '</legend><label for="editor-title-' + index + '">Task name</label><input id="editor-title-' + index + '" data-field="title" maxlength="160" value="' + escape(task.title) + '" placeholder="What should this agent produce?"><div class="project-editor-columns"><div><label for="editor-tool-' + index + '">Agent tool</label><select id="editor-tool-' + index + '" data-field="capability">' + Object.entries(tools).map(([key,label]) => '<option value="' + key + '"' + (key === task.capability ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div><div><label for="editor-deps-' + index + '">Run after</label><select id="editor-deps-' + index + '" data-field="depends_on" multiple size="2"' + (!index ? ' disabled' : '') + ' aria-describedby="editor-deps-help-' + index + '">' + editorTasks.slice(0,index).map((other,n) => '<option value="' + escape(other.id) + '"' + (task.depends_on.includes(other.id) ? ' selected' : '') + '>' + escape(other.title || 'Task ' + (n + 1)) + '</option>').join('') + '</select><small id="editor-deps-help-' + index + '">' + (index ? 'Optional. Ctrl / Cmd to select multiple.' : 'No prerequisites for the first task.') + '</small></div></div><label for="editor-description-' + index + '">Instructions and acceptance criteria</label><textarea id="editor-description-' + index + '" data-field="description" rows="2" maxlength="6000" placeholder="What should be included? How should the result be checked?">' + escape(task.description) + '</textarea>' + (editorTasks.length > 1 ? '<button type="button" class="text-button" data-project-remove-task="' + escape(task.id) + '">Remove task</button>' : '') + '</fieldset>').join('');
      el('project-add-task').disabled = editorTasks.length >= 40;
    }
    function addTask() { saveEditor(); if (editorTasks.length >= 40) return; editorTasks.push({id:'task-' + (++nextTaskNumber),title:'',description:'',capability:'write_document',depends_on:[],acceptance_criteria:[],owner:{company_person_id:'',name:'',relay_person_id:''}}); renderEditor(); }
    function createModeSet(mode) {
      createMode = mode === 'import' ? 'import' : 'manual';
      const importing = createMode === 'import';
      el('project-manual-fields').hidden = importing; el('project-import-fields').hidden = !importing;
      el('project-manual-tab').setAttribute('aria-selected',String(!importing)); el('project-import-tab').setAttribute('aria-selected',String(importing));
      el('project-create-title').textContent = importing ? 'Bring your plan to Relay' : 'New project';
      el('project-create-description').textContent = importing ? 'Your Automate plan becomes real tasks and dependencies in the work graph.' : 'Describe the work and the tasks your agents should carry out.';
      el('project-create-submit').disabled = creating || (importing && !importedPlan);
      el('project-create-submit').innerHTML = (creating ? 'Creating project...' : importing ? 'Import project' : 'Create project') + symbol('arrow');
      error('project-create-error','');
    }
    function showCreate(mode) {
      if (!editorTasks.length) addTask();
      createModeSet(mode); if (!el('project-create-dialog').open) el('project-create-dialog').showModal();
    }
    async function chooseFile() {
      const file = el('project-plan-file').files[0], version = ++fileVersion;
      importedPlan = null; setHTML('project-import-preview',''); el('project-file-name').textContent = file?.name || ''; createModeSet('import');
      if (!file) return;
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('The plan file must be smaller than 2 MB.');
        const content = await file.text(); if (version !== fileVersion) return;
        importedPlan = parsePlan(content);
        setHTML('project-import-preview','<div class="project-import-summary"><span class="project-task-state ready">' + symbol('check') + 'Ready to import</span><h3>' + escape(importedPlan.title) + '</h3><p>' + escape(importedPlan.description) + '</p><div>' + importedPlan.tasks.length + ' tasks · ' + importedPlan.tasks.reduce((sum,t) => sum + t.depends_on.length,0) + ' dependencies · plan v' + importedPlan.version + '</div><ol>' + importedPlan.tasks.map(task => '<li><strong>' + escape(task.title) + '</strong><span>' + escape(tools[task.capability]) + (task.owner?.name ? ' · ' + escape(task.owner.name) : '') + '</span></li>').join('') + '</ol></div>');
        createModeSet('import');
      } catch (cause) { if (version === fileVersion) error('project-create-error',cause.message); }
    }
    async function create(event) {
      event.preventDefault(); if (creating) return;
      const version = generation;
      try {
        let plan = importedPlan;
        if (createMode === 'manual') {
          saveEditor(); const title = el('project-new-title').value.trim(), description = el('project-new-description').value.trim();
          if (!title || !description) throw new Error('Add a project name and describe the goal.');
          if (editorTasks.some(task => !task.title.trim() || !task.description.trim())) throw new Error('Give each task a name and instructions before creating the project.');
          const planId = requestId('manual-plan',{title,description,tasks:editorTasks});
          plan = {schema_version:1,plan_id:planId,version:1,title,description,assumptions:[],tasks:editorTasks,provenance:{source:'relay',source_plan_id:planId,source_tenant:state?.principal?.tenant || '',source_version:1,generated_at:new Date().toISOString()}};
          plan = parsePlan(JSON.stringify(plan));
        }
        if (!plan) throw new Error('Choose an exported plan JSON file first.');
        const body = {plan,visibility:el('project-visibility').value};
        // A retry carries the same immutable plan, timestamp and idempotency key.
        const previous = requests.get('create-body');
        const fingerprint = JSON.stringify({...body,plan:{...plan,provenance:{...plan.provenance,generated_at:''}}});
        if (previous?.fingerprint === fingerprint) body.plan = previous.plan;
        else requests.set('create-body',{fingerprint,plan});
        body.request_id = requestId('create',body);
        const importing = createMode === 'import'; creating = true; createModeSet(createMode);
        const result = await api(endpoint() + (importing ? '/import' : ''),body);
        if (version !== generation) return;
        const projectId = result.project?.id || result.id;
        if (!projectId) throw new Error('The project was saved but its ID was not returned. Refresh Projects before retrying.');
        requests.delete('create'); requests.delete('create-body'); requests.delete('manual-plan');
        el('project-create-dialog').close(); el('project-create-form').reset(); editorTasks = []; importedPlan = null; setHTML('project-import-preview','');
        await refresh(true); await open(projectId);
        notify('Project saved. Approve a ready task in the chat to start its agent.');
      } catch (cause) { if (version === generation && cause.name !== 'StaleWorkspace') error('project-create-error',cause.message); }
      finally { if (version === generation) { creating = false; el('project-create-submit').disabled = createMode === 'import' && !importedPlan; el('project-create-submit').innerHTML = (createMode === 'import' ? 'Import project' : 'Create project') + symbol('arrow'); } }
    }
    document.addEventListener('click',event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.projectCreate) return showCreate(button.dataset.projectCreate);
      if (button.dataset.projectMode) return createModeSet(button.dataset.projectMode);
      if (button.dataset.projectOpen) return void open(button.dataset.projectOpen);
      if (button.dataset.projectStart) return void start(button.dataset.projectStart);
      if (button.dataset.projectGraph) return root.RelayWorkGraph?.open(button.dataset.projectGraph);
      if (button.dataset.projectHistory) return selectCase(button.dataset.projectHistory,true);
      if (button.dataset.projectRevise) { el('project-chat-mode').value = 'revise'; el('project-revision-task').value = button.dataset.projectRevise; setComposerMode(); el('project-message').focus(); el('project-chat-form').scrollIntoView({behavior:'smooth',block:'center'}); }
      if (button.dataset.projectScroll) { [...el('project-thread').querySelectorAll('[data-project-task]')].find(card => card.dataset.projectTask === button.dataset.projectScroll)?.scrollIntoView({behavior:'smooth',block:'center'}); }
      if (button.dataset.projectRemoveTask) { saveEditor(); editorTasks = editorTasks.filter(task => task.id !== button.dataset.projectRemoveTask); editorTasks.forEach(task => { task.depends_on = task.depends_on.filter(dep => dep !== button.dataset.projectRemoveTask); }); renderEditor(); }
    });
    el('projects-back').addEventListener('click',back);
    el('projects-search').addEventListener('input',renderList);
    el('project-chat-mode').addEventListener('change',setComposerMode);
    el('project-chat-form').addEventListener('submit',event => void send(event));
    el('project-message').addEventListener('input',() => { if (current) messageDrafts.set(current,el('project-message').value); });
    el('project-create-form').addEventListener('submit',event => void create(event));
    el('project-add-task').addEventListener('click',addTask);
    el('project-plan-file').addEventListener('change',() => void chooseFile());
    function reset() {
      generation++; fileVersion++; current = null; data = null; projects = []; active = null; lastListAt = 0; stale = false; creating = false; sending = false;
      requests.clear(); running.clear(); messageDrafts.clear(); editorTasks = []; importedPlan = null;
      el('project-create-dialog').close(); el('project-create-form').reset(); el('project-message').value = ''; el('projects-search').value = '';
      ['project-thread','project-heading','project-plan-summary','project-attempts','project-import-preview','project-task-editor'].forEach(target => setHTML(target,''));
      ['projects-error','project-chat-error','project-create-error'].forEach(target => error(target,''));
      renderList(); renderWorkspace();
    }
    return {sync,reset,load,open};
  })();
})(typeof window === 'undefined' ? globalThis : window);
