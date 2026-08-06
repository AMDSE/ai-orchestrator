// ==========================================================================
// AI Orchestrator — Dashboard 前端交互逻辑
// 策略脑 × 执行脑 双脑协同，本地资源实时调用可视化
// ==========================================================================

'use strict';

/* ── 全局状态 ─────────────────────────────────────────────── */
let ws = null;
let projects = new Map();
let skills = [];
let toolDefinitions = [];
let selectedProjectId = null;
let currentView = 'dashboard';
let pendingFiles = [];
let createdAt = new Date().toISOString();

const $ = (id) => document.getElementById(id);

/* ── 工具函数：URL 编码 / 转义 ─────────────────────────────── */
const esc = (str) => String(str ?? '')
  .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
  .replace(/"/g, '"').replace(/'/g, '&#39;');

/* ── Toast 通知 ───────────────────────────────────────────── */
function toast(msg, type = 'success') {
  const box = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ── 视图切换 ─────────────────────────────────────────────── */
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = $('view' + view.charAt(0).toUpperCase() + view.slice(1));
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-btn, .side-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  if (view === 'projects') renderProjectList();
  if (view === 'tools') loadToolDefinitions();
  if (view === 'skills') renderSkillSelector();
}

/* ── WebSocket 连接 ───────────────────────────────────────── */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    setHealth(true);
    console.log('[WS] Connected');
  };

  ws.onclose = () => {
    setHealth(false);
    setTimeout(connectWS, 2000);
  };

  ws.onerror = () => { setHealth(false); };

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleWSMessage(data);
  };
}

function setHealth(ok) {
  const dot = $('healthDot');
  const text = $('healthText');
  if (dot) dot.className = `dot ${ok ? 'dot-green' : 'dot-red'}`;
  if (text) text.textContent = ok ? '实时连接' : '连接断开';
}

function handleWSMessage(data) {
  if (data.type === 'init') {
    skills = data.skills || [];
    (data.projects || []).forEach((p) => projects.set(p.id, p));
    renderAll();
    return;
  }

  if (data.type === 'skills_updated') {
    skills = data.skills || [];
    renderSkillSelector();
    return;
  }

  if (data.type === 'orchestrator_update') {
    const { projectId, type, data: d } = data;
    const project = projectId && projects.get(projectId);

    switch (type) {
      case 'project_created': {
        projects.set(projectId, { ...d.project, toolCalls: [] });
        break;
      }
      case 'status_change': {
        if (project) project.status = d.status;
        updateProjectStatus(projectId);
        break;
      }
      case 'project_queued': {
        if (project) project.status = 'queued';
        updateProjectStatus(projectId);
        break;
      }
      case 'plan_ready': {
        if (project) {
          project.plan = d.plan;
          project.tasks = d.plan?.tasks || [];
          project.iteration = d.iteration || 1;
        }
        break;
      }
      case 'task_start': {
        if (project) project.progress = d.progress;
        break;
      }
      case 'task_complete': {
        if (project) {
          project.progress = d.progress;
          const task = project.tasks?.find((t) => t.id === d.taskId);
          if (task) task.output = d.output;
        }
        break;
      }
      case 'iteration_update': {
        if (project) project.iteration = d.iteration;
        break;
      }
      case 'project_complete': {
        if (project) {
          project.status = 'completed';
          project.result = d.result;
          project.completedAt = d.completedAt;
          project.progress = 100;
        }
        break;
      }
      case 'message': {
        if (project) {
          project.messages = project.messages || [];
          project.messages.push(d.message);
          if (selectedProjectId === projectId) appendMessage(d.message);
        }
        break;
      }
      case 'thought': {
        if (selectedProjectId === projectId) appendThought(d.role, d.token);
        break;
      }
      case 'planner_token':
      case 'token': {
        if (selectedProjectId === projectId) appendStreamToken(d.token);
        break;
      }
      case 'file_action': {
        if (project) {
          project.fileActions = project.fileActions || [];
          project.fileActions.push(d.action);
          if (selectedProjectId === projectId) renderFiles();
        }
        break;
      }
      case 'tool_call': {
        if (project) {
          project.toolCalls = project.toolCalls || [];
          project.toolCalls.push(d.record);
          if (selectedProjectId === projectId) renderToolCalls();
        }
        addActivity(`🛠 双脑调用本地工具：${d.record?.tool || ''}`);
        break;
      }
      case 'config_change': {
        if (project) {
          project.plannerConfig = d.plannerConfig;
          project.executorConfig = d.executorConfig;
          project.maxIterations = d.maxIterations;
        }
        break;
      }
      case 'intervention_processed': {
        break;
      }
    }

    renderProjectList();
    if (selectedProjectId) renderSelectedProject();
  }
}

/* ── 健康检查 + 工具加载 ──────────────────────────────────── */
async function loadHealth() {
  try {
    const r = await fetch('/api/health');
    const h = await r.json();
    $('sideStrategyModel').textContent = h.strategyModel || '—';
    $('sideExecutorModel').textContent = h.executorModel || '—';
    $('statTools').textContent = h.localTools || 0;
  } catch {}
}

async function loadToolDefinitions() {
  try {
    const r = await fetch('/api/tools');
    const data = await r.json();
    toolDefinitions = data.tools || [];
    renderToolDefinitions();
    renderSideTools();
    $('statTools').textContent = toolDefinitions.length;
  } catch { }
}

function renderToolDefinitions() {
  const grid = $('toolsGrid');
  if (!grid) return;
  if (!toolDefinitions.length) {
    grid.innerHTML = '<div class="empty-state">暂无本地工具数据</div>';
    return;
  }
  grid.innerHTML = toolDefinitions.map((t) => `
    <div class="tool-card">
      <div class="tool-card-head">
        <span class="s-ico">⌬</span>
        <span class="tool-card-name">${esc(t.name)}</span>
      </div>
      <div class="tool-card-desc">${esc(t.description || '')}</div>
    </div>
  `).join('');
}

function renderSideTools() {
  const list = $('sideToolList');
  if (!list) return;
  if (!toolDefinitions.length) {
    list.innerHTML = '<div class="side-tool-empty">暂无工具</div>';
    return;
  }
  const icons = {
    read_local_file: '📖',
    write_local_file: '✍️',
    list_local_directory: '📂',
    run_local_command: '⚡',
    web_search: '🌐',
    search_image_assets: '🎨'
  };
  list.innerHTML = toolDefinitions.map((t) => `
    <div class="side-tool-item" title="${esc(t.description || '')}">
      <span class="side-tool-ico">${icons[t.name] || '🛠'}</span>
      <span>${esc(t.name)}</span>
    </div>
  `).join('');
}

/* ── 项目创建 ─────────────────────────────────────────────── */
async function createProject() {
  const userInput = $('projectInput').value.trim();
  if (!userInput) { toast('请输入项目想法', 'error'); return; }

  const plannerConfig = readPlannerConfig();
  const executorConfig = readExecutorConfig();

  const payload = {
    userInput,
    mode: 'standard', // 标准化模式（创意/标准选择已移除）
    agentMode: 'act', // 🔀 默认 Act 快速模式（可在项目栏切换 Plan/Act）
    plannerConfig,
    executorConfig,
    maxIterations: Number($('launchIterInput').value) || 3,
    selectedSkill: $('launchSkillSelect').value || 'bili_toy',
    workDir: $('workDirInput').value.trim()
  };

  try {
    const r = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.error || '创建失败');
    }
    const res = await r.json();
    $('projectInput').value = '';
    toast(`项目已启动：${res.projectId.substring(0, 8)}…`);
    switchView('projects');
    // 等待 WS 推送 project_created
  } catch (e) {
    toast(e.message, 'error');
  }
}

function readPlannerConfig() {
  return {
    provider: 'custom_api',
    apiKey: $('plannerApiKey').value.trim() || undefined,
    baseUrl: $('plannerBaseUrl').value.trim() || undefined,
    model: $('plannerCustomModel').value.trim() || undefined,
    webSearch: $('plannerWebSearchToggle').checked
  };
}

function readExecutorConfig() {
  return {
    provider: 'custom_api',
    apiKey: $('executorApiKey').value.trim() || undefined,
    baseUrl: $('executorBaseUrl').value.trim() || undefined,
    model: $('executorCustomModel').value.trim() || undefined,
    webSearch: $('executorWebSearchToggle').checked
  };
}

function saveSettings() {
  toast('配置已保存到本地（新建项目时生效）');
}

/* ── 技能 ─────────────────────────────────────────────────── */
function renderSkillSelector() {
  const sel = $('launchSkillSelect');
  const holder = $('skillSelector');
  const launchWrap = $('launchSkillWrap');

  if (sel) {
    sel.innerHTML = skills.map((s) => `<option value="${esc(s.id)}">${esc(s.icon || '⚪')} ${esc(s.name)}</option>`).join('');
    const name = $('selectedSkillName');
    if (name && skills.length) name.textContent = skills.find((s) => s.id === sel.value)?.name || '未知技能';
  }

  if (holder) {
    holder.innerHTML = skills.map((s) => `
      <div class="skill-item ${s.id === 'bili_toy' ? 'active' : ''}" data-skill="${esc(s.id)}" onclick="selectSkill('${esc(s.id)}')">
        <span class="skill-ico">${esc(s.icon || '⚪')}</span>
        <div>
          <div class="skill-name">${esc(s.name)}</div>
          <div class="skill-desc">${esc(s.description || '')}</div>
        </div>
      </div>
    `).join('');
  }

  if (launchWrap) {
    const s = $('launchSkillSelect');
    if (s) {
      const current = s.value;
      s.innerHTML = skills.map((sk) => `<option value="${esc(sk.id)}">${esc(sk.icon || '⚪')} ${esc(sk.name)}</option>`).join('');
      if (current) s.value = current;
    }
  }
}

function selectSkill(id) {
  const items = document.querySelectorAll('.skill-item');
  items.forEach((i) => i.classList.toggle('active', i.dataset.skill === id));
  const sel = $('launchSkillSelect');
  if (sel) sel.value = id;
  const name = $('selectedSkillName');
  const sk = skills.find((s) => s.id === id);
  if (name && sk) name.textContent = sk.name;
  toast(`已选择技能：${sk?.name || id}`);
}

/* ── 项目列表渲染 ─────────────────────────────────────────── */
function renderProjectList() {
  const list = $('projectList');
  const recent = $('recentProjects');
  const all = Array.from(projects.values()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (!list) return;

  if (!all.length) {
    list.innerHTML = '<div class="empty-state">暂无项目</div>';
  } else {
    list.innerHTML = all.map((p) => `
      <div class="project-card ${p.id === selectedProjectId ? 'active' : ''}" onclick="selectProject('${p.id}')">
        <div class="pc-title">${esc(firstLine(p.userInput) || p.id || '未命名')}</div>
        <div class="pc-meta">
          <span class="pc-status" data-status="${esc(p.status || 'idle')}">${statusLabel(p.status)}</span>
          <span>${p.progress || 0}%</span>
        </div>
      </div>
    `).join('');
  }

  if (recent) {
    const recentAll = all.slice(0, 5);
    recent.innerHTML = recentAll.length
      ? recentAll.map((p) => `
          <div class="project-card" onclick="selectProject('${p.id}')">
            <div class="pc-title">${esc(firstLine(p.userInput) || p.id)}</div>
            <div class="pc-meta">
              <span class="pc-status" data-status="${esc(p.status || 'idle')}">${statusLabel(p.status)}</span>
              <span>${p.progress || 0}%</span>
            </div>
          </div>
        `).join('')
      : '<div class="empty-state">暂无项目，在上方输入想法并启动编排吧。</div>';
  }

  renderStats();
}

function firstLine(str) {
  return String(str || '').split('\n')[0];
}

function statusLabel(status) {
  const map = {
    idle: '待命', planning: '策略脑规划中', executing: '执行脑执行中',
    awaiting_approval: '📋 待批准', waiting_answer: '等待回答',
    completed: '已完成', stopped: '已中止',
    error: '错误', queued: '排队中'
  };
  return map[status] || status || '—';
}

function renderStats() {
  const all = Array.from(projects.values());
  $('statTotal').textContent = all.length;
  $('statActive').textContent = all.filter((p) => ['planning', 'executing', 'waiting_answer', 'queued', 'awaiting_approval'].includes(p.status)).length;
  $('statDone').textContent = all.filter((p) => p.status === 'completed').length;
  $('activeCount').textContent = $('statActive').textContent;
  $('projectCount').textContent = all.length;
}

/* ── 选中项目 ─────────────────────────────────────────────── */
async function selectProject(projectId) {
  selectedProjectId = projectId;
  $('noSelection').style.display = 'none';
  $('messageArea').style.display = 'flex';
  renderProjectList();
  renderSelectedProject();

  // 加载最新项目详情（若 WS 快照滞后）
  try {
    const r = await fetch(`/api/projects/${projectId}`);
    const p = await r.json();
    projects.set(projectId, { ...projects.get(projectId), ...p });
    renderSelectedProject();
  } catch {}
}

function renderSelectedProject() {
  const p = projects.get(selectedProjectId);
  if (!p) return;

  $('selectedProjectTitle').textContent = firstLine(p.userInput) || '未命名项目';
  const statusEl = $('selectedProjectStatus');
  statusEl.textContent = statusLabel(p.status);
  statusEl.dataset.status = p.status || 'idle';
  $('iterationDisplay').textContent = `第 ${p.iteration || 1} / ${p.maxIterations || 3} 轮`;
  $('selectedProjectSkill').textContent = p.selectedSkill || '—';
  $('projWorkDirInput').value = p.workDir || '';

  // 进度条
  const prog = Math.min(100, Math.max(0, p.progress || 0));
  $('projectProgressBar').style.width = prog + '%';
  $('projectProgressText').textContent = prog + '%';

  // 双脑状态卡
  updateBrainStatus(p.status);

  // Agent 模式选择器（项目栏）：同步当前值；运行/待批准中禁用切换
  const amSel = $('projAgentModeSelect');
  if (amSel) {
    amSel.value = p.agentMode || 'act';
    const locked = ['planning', 'executing', 'waiting_answer', 'queued', 'awaiting_approval'].includes(p.status);
    amSel.disabled = locked;
    amSel.title = locked ? 'Agent 运行中/待批准，不可切换' : 'Plan：只规划不执行（批准后落地）；Act：规划后直接执行';
  }

  // Plan/Act：批准按钮（awaiting_approval 时显示）
  $('approveBtn').style.display = p.status === 'awaiting_approval' ? 'inline-block' : 'none';

  // 中止/重试按钮
  $('stopBtn').style.display = ['planning', 'executing', 'waiting_answer'].includes(p.status) ? 'inline-block' : 'none';
  $('retryBtn').style.display = ['stopped', 'error'].includes(p.status) ? 'inline-block' : 'none';

  // 消息
  renderMessages(p.messages || []);
  renderThoughts(Array.from({ length: 0 })); // 思考流由 WS 实时追加
  renderFiles();
  renderToolCalls();
}

function updateBrainStatus(status) {
  const planner = $('plannerStatus');
  const executor = $('executorStatus');
  if (!planner || !executor) return;

  switch (status) {
    case 'planning':
      planner.textContent = '🟢 规划中';
      executor.textContent = '⏳ 待命';
      break;
    case 'executing':
      planner.textContent = '⏳ 待命';
      executor.textContent = '🟢 执行中';
      break;
    case 'awaiting_approval':
      planner.textContent = '📋 规划完成';
      executor.textContent = '⏸ 等待批准';
      break;
    case 'waiting_answer':
      planner.textContent = '⏳ 回答中';
      executor.textContent = '❓ 询问中';
      break;
    case 'completed':
      planner.textContent = '✅ 已终审';
      executor.textContent = '✅ 已完成';
      break;
    case 'stopped':
      planner.textContent = '⏹ 已中止';
      executor.textContent = '⏹ 已中止';
      break;
    case 'error':
      planner.textContent = '⚠️ 异常';
      executor.textContent = '⚠️ 异常';
      break;
    default:
      planner.textContent = '待命';
      executor.textContent = '待命';
  }
}

function updateProjectStatus(projectId) {
  if (selectedProjectId === projectId) {
    const p = projects.get(projectId);
    if (p) renderSelectedProject();
  }
}

/* ── 消息渲染 ─────────────────────────────────────────────── */
let thoughtsElCache = null;

function renderMessages(messages) {
  const box = $('messagesContainer');
  if (!box) return;
  box.innerHTML = messages.map((m) => `
    <div class="msg ${esc(m.role || 'system')}">
      ${renderMarkdown(m.content)}
      <div style="font-size:10px;color:var(--text-2);margin-top:6px">${new Date(m.timestamp).toLocaleTimeString()}</div>
    </div>
  `).join('');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(msg) {
  const box = $('messagesContainer');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `msg ${esc(msg.role || 'system')}`;
  el.innerHTML = renderMarkdown(msg.content) +
    `<div style="font-size:10px;color:var(--text-2);margin-top:6px">${new Date(msg.timestamp).toLocaleTimeString()}</div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function renderMarkdown(text) {
  if (!text) return '';
  let t = esc(text);
  // 简单 markdown：粗体 / 行内代码 / 代码块
  t = t.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\n/g, '<br/>');
  return t;
}

/* ── 思考流 ───────────────────────────────────────────────── */
function toggleThoughts() {
  const body = $('thoughtsBody');
  const icon = $('thoughtsToggleIcon');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'flex';
  icon.textContent = isOpen ? '›' : '⌄';
}

function renderThoughts() {
  const body = $('thoughtsBody');
  if (!body) return;
  body.innerHTML = '<div class="proc-empty" id="thoughtPlaceholder">等待双脑输出推理过程…</div>';
}

function appendThought(role, token) {
  const body = $('thoughtsBody');
  const placeholder = $('thoughtPlaceholder');
  if (!body) return;
  if (placeholder) placeholder.remove();
  if (body.style.display === 'none') body.style.display = 'flex';

  let last = body.lastElementChild;
  if (last && last.classList.contains('thought-line') && last.dataset.role === role) {
    last.textContent += token;
  } else {
    const el = document.createElement('div');
    el.className = `thought-line ${esc(role)}`;
    el.dataset.role = role;
    el.textContent = token;
    body.appendChild(el);
  }
  body.scrollTop = body.scrollHeight;
}

/* ── 流式输出 ─────────────────────────────────────────────── */
function appendStreamToken(token) {
  const box = $('streamOutput');
  if (!box) return;
  box.textContent += token;
  box.scrollTop = box.scrollHeight;
}

/* ── 文件树 ───────────────────────────────────────────────── */
async function toggleFilesPanel() {
  const panel = $('filesPanel');
  if (!panel) return;
  const hidden = panel.style.display === 'none';
  panel.style.display = hidden ? 'block' : 'none';
  if (hidden && selectedProjectId) {
    try {
      const r = await fetch(`/api/projects/${selectedProjectId}/files`);
      const data = await r.json();
      const files = data.files || [];
      const list = $('filesList');
      if (!files.length) {
        list.innerHTML = '<div class="empty-state">暂无文件</div>';
        return;
      }
      list.innerHTML = files.map((f) => `
        <div class="file-item">
          <span class="f-ico">📄</span>
          <span class="f-name">${esc(f.path)}</span>
          <span class="f-size">${(f.content || '').length} 字符</span>
        </div>
      `).join('');
    } catch {}
  }
}

function renderFiles() {
  const list = $('filesList');
  if (!list || list.parentElement.style.display === 'none') return;
  const p = projects.get(selectedProjectId);
  const actions = p?.fileActions || [];
  if (!actions.length) {
    list.innerHTML = '<div class="empty-state">暂无文件，Agent 实时写入后将出现在这里。</div>';
    return;
  }
  list.innerHTML = actions.slice(-30).reverse().map((a) => `
    <div class="file-item">
      <span class="f-ico">📄</span>
      <span class="f-name">${esc(a.path)}</span>
      <span class="f-size">${a.size || 0} B</span>
    </div>
  `).join('');
}

/* ── 工具调用记录 ─────────────────────────────────────────── */
function toggleToolsPanel() {
  const panel = $('toolsPanel');
  if (!panel) return;
  const hidden = panel.style.display === 'none';
  panel.style.display = hidden ? 'block' : 'none';
  if (hidden) renderToolCalls();
}

function renderToolCalls() {
  const list = $('toolsList');
  const badge = $('toolCountBadge');
  if (!list) return;
  const p = projects.get(selectedProjectId);
  const calls = p?.toolCalls || [];
  if (badge) badge.textContent = calls.length;

  if (!calls.length) {
    list.innerHTML = '<div class="empty-state">暂无工具调用，双脑调用本地工具时将实时展示。</div>';
    return;
  }

  list.innerHTML = calls.slice(-40).reverse().map((c) => `
    <div class="tool-item">
      <div class="t-head">
        <span class="tool-brain ${esc(c.brain === 'planner' ? 'planner' : 'executor')}">${c.brain === 'planner' ? '策略脑' : '执行脑'}</span>
        <span class="tool-name">${esc(c.tool)}</span>
      </div>
      <div class="tool-args">${esc(JSON.stringify(c.args || {}).slice(0, 120))}</div>
    </div>
  `).join('');
}

/* ── 介入逻辑 ─────────────────────────────────────────────── */
let atMenuOpen = false;

function triggerFileInput() { $('interveneFileInput').click(); }

function handleFileSelect(event) {
  const files = Array.from(event.target.files || []);
  const preview = $('attachmentPreview');
  files.forEach((f) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingFiles.push({
        name: f.name,
        size: f.size,
        content: String(e.target.result).slice(0, 10 * 1024 * 1024) // 10MB 上限
      });
      const chip = document.createElement('span');
      chip.className = 'attach-item';
      chip.textContent = `📎 ${f.name}`;
      preview.appendChild(chip);
    };
    reader.readAsText(f);
  });
}

function handleInterveneInput(event) {
  const val = event.target.value;
  const menu = $('atMenu');
  if (val.endsWith('@') && !atMenuOpen) {
    menu.style.display = 'block';
    atMenuOpen = true;
  } else if (!val.endsWith('@')) {
    menu.style.display = 'none';
    atMenuOpen = false;
  }
}

function handleInterveneKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendIntervention();
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.at-menu') && !e.target.closest('#interveneInput')) {
    const menu = $('atMenu');
    if (menu) { menu.style.display = 'none'; atMenuOpen = false; }
  }
});

document.querySelectorAll('.at-item').forEach((item) => {
  item.addEventListener('click', () => {
    const input = $('interveneInput');
    if (input) {
      input.value = input.value.replace(/@$/, '') + item.dataset.value;
      const menu = $('atMenu');
      if (menu) { menu.style.display = 'none'; atMenuOpen = false; }
      input.focus();
    }
  });
});

async function sendIntervention() {
  if (!selectedProjectId) { toast('请先选择项目', 'error'); return; }
  const input = $('interveneInput');
  const text = input.value.trim();
  if (!text && !pendingFiles.length) { toast('请输入介入要求或选择文件', 'error'); return; }

  try {
    const r = await fetch(`/api/projects/${selectedProjectId}/intervene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userInstruction: text, files: pendingFiles })
    });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.error || '介入失败');
    }
    toast('介入指令已发送');
    input.value = '';
    pendingFiles = [];
    $('attachmentPreview').innerHTML = '';
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ── 中止 / 重试 ──────────────────────────────────────────── */
async function stopGeneration() {
  if (!selectedProjectId) return;
  try {
    await fetch(`/api/projects/${selectedProjectId}/stop`, { method: 'POST' });
    toast('已发送中止指令');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function retryProject() {
  if (!selectedProjectId) return;
  try {
    await fetch(`/api/projects/${selectedProjectId}/retry`, { method: 'POST' });
    toast('已发送重试指令');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ── Plan/Act：批准规划并开始执行 ─────────────────────────── */
async function approveProject() {
  if (!selectedProjectId) return;
  try {
    const r = await fetch(`/api/projects/${selectedProjectId}/approve`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '批准失败');
    toast('✅ 规划已批准，开始执行');
    $('approveBtn').style.display = 'none';
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ── Plan/Act：切换项目 Agent 模式 ────────────────────────── */
async function changeProjectAgentMode(mode) {
  if (!selectedProjectId) return;
  const p = projects.get(selectedProjectId);
  if (p && ['planning', 'executing', 'waiting_answer', 'queued', 'awaiting_approval'].includes(p.status)) {
    toast('Agent 运行中不可切换模式', 'error');
    if ($('projAgentModeSelect')) $('projAgentModeSelect').value = p.agentMode || 'act';
    return;
  }
  try {
    const r = await fetch(`/api/projects/${selectedProjectId}/agentmode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentMode: mode })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '切换失败');
    const proj = projects.get(selectedProjectId);
    if (proj) proj.agentMode = mode;
    toast(mode === 'plan' ? '📋 已切换为 Plan 模式（下次启动前生效）' : '⚡ 已切换为 Act 模式');
  } catch (e) {
    toast(e.message, 'error');
    if ($('projAgentModeSelect')) $('projAgentModeSelect').value = p?.agentMode || 'act';
  }
}

/* ── 工作目录 ─────────────────────────────────────────────── */
async function setProjectWorkDir() {
  if (!selectedProjectId) return;
  const workDir = $('projWorkDirInput').value.trim();
  try {
    await fetch(`/api/projects/${selectedProjectId}/workdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir })
    });
    toast('工作目录已设置');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ── 审查台 ───────────────────────────────────────────────── */
let reviewTab = 'result';

function openReview(projectId) {
  const panel = $('reviewPanel');
  if (!projectId) return;
  selectedProjectId = projectId;
  panel.classList.add('open');
  switchTab('result');
}

function closeReview() {
  $('reviewPanel').classList.remove('open');
}

function switchTab(tab) {
  reviewTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

  const p = projects.get(selectedProjectId);
  if (!p) return;
  const content = $('reviewContent');
  if (tab === 'result') {
    content.innerHTML = `<pre>${esc(p.result || '暂无成果')}</pre>`;
  } else if (tab === 'plan') {
    content.innerHTML = `
      <h3>${esc(p.plan?.title || '项目计划')}</h3>
      <p>${esc(p.plan?.summary || '')}</p>
      ${(p.tasks || []).map((t, i) => `
        <div style="margin:12px 0;padding:12px;background:rgba(0,0,0,.2);border-radius:10px;border:1px solid var(--glass-border)">
          <strong>任务 ${t.id}: ${esc(t.title)}</strong>
          <div style="color:var(--text-1);font-size:12px;margin-top:6px">${esc(t.description || '')}</div>
        </div>
      `).join('')}
    `;
  } else if (tab === 'log') {
    content.innerHTML = (p.messages || []).map((m) => `
      <div style="margin:6px 0;color:${m.role === 'planner' ? 'var(--accent-blue)' : m.role === 'executor' ? 'var(--accent-green)' : 'var(--text-1)'}">
        <b>[${m.role}]</b> ${esc(m.content).slice(0, 300)}
      </div>
    `).join('');
  }
}

function copyToClipboard() {
  const p = projects.get(selectedProjectId);
  if (!p || !p.result) return;
  navigator.clipboard.writeText(p.result).then(() => toast('已复制到剪贴板'));
}

function previewInNewWindow() {
  const p = projects.get(selectedProjectId);
  if (!p) return;
  const html = p.result || '';
  if (!html) { toast('暂无成果可预览', 'error'); return; }
  const win = window.open('', '_blank');
  if (!win) { toast('浏览器阻止了弹窗，请允许', 'error'); return; }
  win.document.write(html);
  win.document.close();
}

function exportResult() {
  const p = projects.get(selectedProjectId);
  if (!p || !p.result) { toast('暂无成果可导出', 'error'); return; }
  const blob = new Blob([p.result], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${firstLine(p.userInput) || 'project'}-result.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出成果文件');
}

/* ── 技能工坊 ─────────────────────────────────────────────── */
function toggleAlchemyPanel() {
  const body = $('alchemyBody');
  const arrow = $('alchemyArrow');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? 'flex' : 'none';
  arrow.textContent = hidden ? '⌃' : '⌄';
}

async function runSkillAlchemy() {
  const urls = $('alchemyUrls').value.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) { toast('请输入至少一个信源 URL', 'error'); return; }

  const box = $('alchemyStatusBox');
  const stream = $('alchemyStreamOutput');
  box.style.display = 'block';
  stream.textContent = '';

  $('alchemyStageIndicator').innerHTML = '<span class="spinner"></span> 正在抓取信源并提炼…';

  try {
    const resp = await fetch('/api/skill-alchemy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls,
        customPrompt: $('alchemyInstruction').value.trim(),
        plannerConfig: readPlannerConfig()
      })
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const ev of events) {
        const line = ev.replace(/^data: /, '').trim();
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === 'token') {
            stream.textContent += data.token;
            stream.scrollTop = stream.scrollHeight;
          } else if (data.type === 'progress') {
            $('alchemyStageIndicator').innerHTML = `<span class="spinner"></span> ${esc(data.message || '处理中…')}`;
          } else if (data.type === 'complete') {
            $('alchemyStageIndicator').innerHTML = '✅ 技能已生成！';
            localStorage.setItem('skillAlchemyResult', JSON.stringify(data.skill));
            toast('技能已成功炼化');
          } else if (data.type === 'error') {
            $('alchemyStageIndicator').innerHTML = `❌ ${esc(data.message || '错误')}`;
            toast(data.message || '炼化失败', 'error');
          }
        } catch {}
      }
    }
  } catch (e) {
    $('alchemyStageIndicator').innerHTML = `❌ ${esc(e.message)}`;
  }
}

/* ── 活动流 ───────────────────────────────────────────────── */
function addActivity(text) {
  const feed = $('activityFeed');
  if (!feed) return;
  const empty = feed.querySelector('.empty-state');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'file-item';
  el.style.margin = '4px 0';
  el.textContent = `· ${text} — ${new Date().toLocaleTimeString()}`;
  feed.prepend(el);
  if (feed.children.length > 30) feed.lastElementChild.remove();
}

/* ── Electron 窗口控制 ────────────────────────────────────── */
function initWinControls() {
  const winControls = $('winControls');
  if (winControls && window.electronAPI) {
    winControls.style.display = 'flex';
    $('winMin')?.addEventListener('click', () => window.electronAPI.minimize());
    $('winMax')?.addEventListener('click', () => window.electronAPI.toggleMaximize());
    $('winClose')?.addEventListener('click', () => window.electronAPI.close());
  }
}

/* ── 渲染全部 ─────────────────────────────────────────────── */
function renderAll() {
  renderProjectList();
  renderSkillSelector();
  renderStats();
  if (selectedProjectId) renderSelectedProject();
}

/* ── 初始化 ───────────────────────────────────────────────── */
function init() {
  connectWS();
  loadHealth();
  loadToolDefinitions();
  initWinControls();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('reviewPanel').classList.remove('open');
    }
  });

  // 设置默认值（从环境变量示例填充占位提示）
  $('plannerBaseUrl').placeholder = '接口地址 Base URL（如 https://api.openai.com/v1）';
  $('executorBaseUrl').placeholder = '接口地址 Base URL（如 https://api.openai.com/v1）';
  $('plannerCustomModel').placeholder = '模型名（请填写你的模型 ID）';
  $('executorCustomModel').placeholder = '模型名（请填写你的模型 ID）';
}

// 启动
init();

// 暴露全局（供 inline onclick 使用）
window.switchView = switchView;
window.createProject = createProject;
window.selectProject = selectProject;
window.openReview = openReview;
window.closeReview = closeReview;
window.switchTab = switchTab;
window.copyToClipboard = copyToClipboard;
window.previewInNewWindow = previewInNewWindow;
window.exportResult = exportResult;
window.toggleThoughts = toggleThoughts;
window.toggleFilesPanel = toggleFilesPanel;
window.toggleToolsPanel = toggleToolsPanel;
window.triggerFileInput = triggerFileInput;
window.handleFileSelect = handleFileSelect;
window.handleInterveneInput = handleInterveneInput;
window.handleInterveneKey = handleInterveneKey;
window.sendIntervention = sendIntervention;
window.stopGeneration = stopGeneration;
window.retryProject = retryProject;
window.approveProject = approveProject;
window.changeProjectAgentMode = changeProjectAgentMode;
window.setProjectWorkDir = setProjectWorkDir;
window.toggleAlchemyPanel = toggleAlchemyPanel;
window.runSkillAlchemy = runSkillAlchemy;
window.selectSkill = selectSkill;
window.saveSettings = saveSettings;