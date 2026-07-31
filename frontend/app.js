// frontend/app.js
// WebSocket 客户端 + 界面交互逻辑（包含实时数据双向同步、动态 Skill 炼化与注册、内联思考过程、自动拉起 Antigravity Agent）

const WS_URL  = `ws://${location.host}`;
const API_URL = `http://${location.host}`;

let ws = null;
let projects = new Map();
let loadedSkills = []; // 动态存储从后端加载的所有 Skill
let selectedProjectId = null;
let currentMode = 'standard';
let currentReviewProject = null;
let currentTab = 'result';
let thoughtsMap = new Map(); // projectId -> text
let thoughtsExpanded = true;

// 模型与外接 API 全局配置状态
let plannerProvider = 'built-in';
let executorProvider = 'antigravity';
let globalConfigExpanded = false;
let attachedFiles = [];

// 🎯 项目技能全局配置状态
let selectedSkill = 'bili_toy';
let skillMenuExpanded = false;
let alchemyPanelExpanded = false;

// ── 🔮 技能炼化面板控制 ────────────────────────────────────────────────────────
function toggleAlchemyPanel() {
  alchemyPanelExpanded = !alchemyPanelExpanded;
  const body = document.getElementById('alchemyBody');
  const arrow = document.getElementById('alchemyArrow');
  if (body) body.style.display = alchemyPanelExpanded ? 'flex' : 'none';
  if (arrow) arrow.classList.toggle('open', alchemyPanelExpanded);
}

function addAlchemyPreset(url) {
  const textarea = document.getElementById('alchemyUrls');
  if (!textarea) return;
  const current = textarea.value.trim();
  if (current.includes(url)) return;
  textarea.value = current ? `${current}\n${url}` : url;
}

// 运行技能炼化 (SSE 流式接收进度与生成 Token)
async function runSkillAlchemy() {
  const urlsText = document.getElementById('alchemyUrls')?.value || '';
  const customPrompt = document.getElementById('alchemyInstruction')?.value || '';
  const urls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);

  if (urls.length === 0) {
    showToast('⚠️ 请至少输入一个信源 URL', 'error');
    return;
  }

  const runBtn = document.getElementById('alchemyRunBtn');
  const statusBox = document.getElementById('alchemyStatusBox');
  const stageIndicator = document.getElementById('alchemyStageIndicator');
  const streamOutput = document.getElementById('alchemyStreamOutput');

  if (runBtn) runBtn.disabled = true;
  if (statusBox) statusBox.style.display = 'block';
  if (streamOutput) streamOutput.textContent = '';

  const plannerConfig = getPlannerConfig();

  try {
    const response = await fetch(`${API_URL}/api/skill-alchemy/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, customPrompt, plannerConfig })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || '炼化请求失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(cleanLine.slice(6));
          if (event.type === 'progress') {
            if (stageIndicator) {
              stageIndicator.innerHTML = `<span class="spinner-small"></span> ${event.message}`;
            }
          } else if (event.type === 'token') {
            if (streamOutput) {
              streamOutput.textContent += event.token;
              streamOutput.scrollTop = streamOutput.scrollHeight;
            }
          } else if (event.type === 'complete') {
            const newSkill = event.skill;
            showToast(`✨ 技能炼化成功！已保存：${newSkill.name}`, 'success');
            selectSkill(newSkill.id, newSkill.name);
            if (stageIndicator) {
              stageIndicator.innerHTML = `✅ 炼化完成！新技能 <strong>${newSkill.name}</strong> 已自动加载到技能栏`;
            }
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        } catch (e) {
          console.warn('[Alchemy SSE Parse Warning]', e.message);
        }
      }
    }
  } catch (err) {
    showToast(`❌ 炼化失败: ${err.message}`, 'error');
    if (stageIndicator) {
      stageIndicator.innerHTML = `❌ 炼化出错: ${err.message}`;
    }
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

// ── 🎯 技能列表渲染与选择控制 ────────────────────────────────────────────────
function renderSkillsList(skills) {
  loadedSkills = skills;
  const dropdown = document.getElementById('skillDropdown');
  if (!dropdown) return;

  dropdown.innerHTML = skills.map(s => {
    const isActive = s.id === selectedSkill;
    const icon = s.icon || '🔧';
    const isBuiltIn = s.builtIn;

    return `
      <div class="skill-option ${isActive ? 'active' : ''}" data-skill="${s.id}" onclick="selectSkill('${s.id}', '${s.name.replace(/'/g, "\\'")}')">
        <div class="skill-option-header">
          <span class="skill-name">${icon} ${s.name}</span>
          <div style="display:flex; align-items:center; gap:4px;">
            ${isActive ? '<span class="skill-tag-active">已启用</span>' : ''}
            ${!isBuiltIn ? `<button class="btn-delete-skill" onclick="deleteSkill(event, '${s.id}')" title="删除此炼化技能">✕</button>` : ''}
          </div>
        </div>
        <div class="skill-desc">${s.description || '无描述'}</div>
      </div>
    `;
  }).join('');

  // 同步已选技能显示名称
  const cur = skills.find(s => s.id === selectedSkill);
  if (cur) {
    const nameEl = document.getElementById('selectedSkillName');
    if (nameEl) nameEl.textContent = cur.name;
  }
}

async function deleteSkill(event, skillId) {
  event.stopPropagation();
  if (!confirm('确定删除该炼化技能吗？')) return;

  try {
    const res = await fetch(`${API_URL}/api/skills/${skillId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    showToast('🗑️ 技能已删除', 'info');
    if (selectedSkill === skillId) {
      selectSkill('bili_toy', '🎮 B站 Toy 互动规范');
    }
  } catch (e) {
    showToast(`删除技能失败: ${e.message}`, 'error');
  }
}

function toggleSkillMenu() {
  skillMenuExpanded = !skillMenuExpanded;
  const dropdown = document.getElementById('skillDropdown');
  const arrow = document.getElementById('skillArrow');
  if (dropdown) dropdown.style.display = skillMenuExpanded ? 'flex' : 'none';
  if (arrow) arrow.classList.toggle('open', skillMenuExpanded);
}

function selectSkill(skillId, skillName) {
  selectedSkill = skillId;
  const nameEl = document.getElementById('selectedSkillName');
  if (nameEl) nameEl.textContent = skillName;

  document.querySelectorAll('.skill-option').forEach(opt => {
    const isActive = opt.dataset.skill === skillId;
    opt.classList.toggle('active', isActive);
  });

  if (skillMenuExpanded) toggleSkillMenu();
  showToast(`🎯 已切换项目技能为：${skillName}`, 'info');
}


let reconnectTimer = null;

function connectWS() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    updateHealth(true);
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('[WS] Parse error', e);
    }
  };

  ws.onclose = () => {
    updateHealth(false);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWS();
      }, 3000);
    }
  };

  ws.onerror = () => ws.close();
}

function handleServerMessage(msg) {
  if (msg.type === 'init') {
    projects.clear();
    for (const project of msg.projects) {
      projects.set(project.id, project);
    }
    if (msg.skills) {
      renderSkillsList(msg.skills);
    }
    renderAll();

    if (!selectedProjectId && projects.size > 0) {
      const latestProject = [...projects.values()].reverse()[0];
      if (latestProject) selectProject(latestProject.id);
    } else if (selectedProjectId && projects.has(selectedProjectId)) {
      selectProject(selectedProjectId);
    }
    return;
  }

  if (msg.type === 'skills_updated') {
    if (msg.skills) {
      renderSkillsList(msg.skills);
    }
    return;
  }

  if (msg.type === 'orchestrator_update') {
    const { projectId, type, data } = msg;

    let p = projects.get(projectId);
    if (!p) {
      if (data.project) {
        p = data.project;
        projects.set(projectId, p);
      } else {
        p = { id: projectId, messages: [], status: 'planning', progress: 0, iteration: 1, maxIterations: 3 };
        projects.set(projectId, p);
      }
    }

    let skipFullRender = false;

    switch (type) {
      case 'project_created':
        if (data.project) projects.set(projectId, data.project);
        break;

      case 'status_change':
        if (p) {
          p.status = data.status;
          if (data.currentTaskIndex !== undefined) p.currentTaskIndex = data.currentTaskIndex;
          if (data.progress !== undefined) p.progress = data.progress;
        }
        break;

      case 'task_start':
        if (p) {
          p.status = 'executing';
          p.currentTaskIndex = data.taskIndex;
          p.progress = data.progress || p.progress;
          clearProjectStreamOutput(projectId);
        }
        break;

      case 'iteration_update':
        if (p) {
          p.iteration = data.iteration;
          p.maxIterations = data.maxIterations;
        }
        break;

      case 'config_change':
      case 'model_change':
        if (p) {
          if (data.executorConfig) p.executorConfig = data.executorConfig;
          if (data.plannerConfig) p.plannerConfig = data.plannerConfig;
          if (data.maxIterations) p.maxIterations = data.maxIterations;
          if (data.iteration) p.iteration = data.iteration;
          if (data.model && p.executorConfig) p.executorConfig.model = data.model;

          if (projectId === selectedProjectId) {
            const selectEl = document.getElementById('executorModelSelect');
            if (selectEl && p.executorConfig?.model) {
              selectEl.value = p.executorConfig.model;
            }
          }
        }
        break;

      case 'plan_ready':
        if (p) {
          p.plan = data.plan;
          p.tasks = data.plan.tasks || [];
          p.progress = 10;
          if (data.iteration) p.iteration = data.iteration;
        }
        break;

      case 'message':
        if (p) {
          if (!p.messages) p.messages = [];
          p.messages.push(data.message);
          if (projectId === selectedProjectId) {
            appendMessage(data.message);
          }
        }
        break;

      case 'thought':
        appendThought(projectId, data.role, data.token);
        skipFullRender = true;
        break;

      case 'planner_token':
        appendProjectStreamToken(projectId, 'planner', data.token);
        skipFullRender = true;
        break;

      case 'token':
        appendProjectStreamToken(projectId, 'executor', data.token);
        skipFullRender = true;
        break;

      case 'task_complete':
        if (p) {
          p.progress = data.progress || p.progress;
          clearProjectStreamOutput(projectId);
          const task = p.tasks?.find(t => t.id === data.taskId);
          if (task) task.output = data.output;
        }
        break;

      case 'project_complete':
        if (p) {
          p.status      = 'completed';
          p.completedAt = data.completedAt;
          p.result      = data.result;
          p.progress    = 100;
          clearProjectStreamOutput(projectId);
          showToast(`✅ 项目完成！`, 'success');
        }
        break;

      case 'project_queued':
        if (p) p.status = 'queued';
        break;
    }

    // 无论是否跳过全量 DOM 销毁重绘，始终精准微调左侧列表项的进度与指示灯 UI
    updateProjectListItemUI(projectId);

    // 高频 token/thought 传输时跳过 renderAll 全量 DOM 销毁重绘，提升流畅度
    if (!skipFullRender) {
      renderAll();
    }
  }
}

// ── 界面全量实时渲染 ────────────────────────────────────────────────────────
function renderAll() {
  renderProjectsGrid();
  renderProjectList();
  updateActiveCount();
  updateSelectedProjectHeader();
  updateHealth(ws && ws.readyState === WebSocket.OPEN);
}

function updateActiveCount() {
  let active = 0;
  for (const p of projects.values()) {
    if (['planning','executing','waiting_answer'].includes(p.status)) active++;
  }
  document.getElementById('activeCount').textContent = active;
  document.getElementById('projectCount').textContent = projects.size;
}

function renderProjectList() {
  const list = document.getElementById('projectList');
  if (projects.size === 0) {
    list.innerHTML = `<div class="empty-state"><span>还没有项目</span><small>输入想法后点击启动</small></div>`;
    return;
  }
  list.innerHTML = [...projects.values()].reverse().map(p => {
    const progress = Math.round(p.progress || 0);
    return `
    <div class="project-list-item ${selectedProjectId === p.id ? 'active' : ''}"
         data-id="${p.id}"
         onclick="selectProject('${p.id}')">
      <div class="pli-content">
        <div class="pli-title" id="pli-title-${p.id}">${p.plan?.title || p.userInput?.substring(0, 26) || '新项目'}${p.userInput?.length > 26 && !p.plan?.title ? '…' : ''}</div>
        <div class="pli-meta">
          <span class="pli-status-text" id="pli-status-${p.id}">${statusLabel(p.status)} · ${progress}% · 🔄 ${p.iteration || 1}/${p.maxIterations || 3}轮</span>
        </div>
        <div class="pli-progress-bar">
          <div class="pli-progress-fill fill-${p.status}" id="pli-bar-${p.id}" style="width:${progress}%"></div>
        </div>
      </div>
      <div class="pli-dot-right" id="pli-dot-${p.id}">
        ${statusIndicatorDotPure(p.status)}
      </div>
      <div class="pli-delete-wrapper">
        <span class="pli-delete-btn" onclick="deleteProject('${p.id}', event)" title="删除项目">🗑️</span>
      </div>
    </div>
  `}).join('');
}

function updateProjectListItemUI(projectId) {
  const p = projects.get(projectId);
  if (!p) return;

  const progress = Math.round(p.progress || 0);
  const statusEl = document.getElementById(`pli-status-${projectId}`);
  const barEl = document.getElementById(`pli-bar-${projectId}`);
  const dotEl = document.getElementById(`pli-dot-${projectId}`);
  const titleEl = document.getElementById(`pli-title-${projectId}`);

  if (titleEl) {
    const isLong = p.userInput?.length > 26 && !p.plan?.title;
    titleEl.textContent = `${p.plan?.title || p.userInput?.substring(0, 26) || '新项目'}${isLong ? '…' : ''}`;
  }
  if (statusEl) {
    statusEl.textContent = `${statusLabel(p.status)} · ${progress}% · 🔄 ${p.iteration || 1}/${p.maxIterations || 3}轮`;
  }
  if (barEl) {
    barEl.style.width = `${progress}%`;
    barEl.className = `pli-progress-fill fill-${p.status}`;
  }
  if (dotEl) {
    dotEl.innerHTML = statusIndicatorDotPure(p.status);
  }
}

function renderProjectsGrid() {
  const grid = document.getElementById('projectsGrid');
  if (selectedProjectId) {
    grid.style.display = 'none';
    return;
  }
  grid.style.display = 'grid';

  if (projects.size === 0) {
    grid.innerHTML = `
      <div class="grid-placeholder" id="gridPlaceholder">
        <div class="placeholder-icon">🤖</div>
        <h3>选择或新建项目</h3>
        <p>在左侧设定策略脑与执行脑模型（支持内置模型与外接 API），启动后可实时查看推理思考流并介入指导。</p>
        <div class="flow-diagram">
          <div class="flow-item blue">🔵 策略脑<br/><small>内置 / 外接 API</small></div>
          <div class="flow-arrow">↔</div>
          <div class="flow-item green">🟢 执行脑<br/><small>内置 / 外接 API</small></div>
          <div class="flow-arrow">↔</div>
          <div class="flow-item yellow">👤 实时介入<br/><small>打断·指导·调整</small></div>
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = [...projects.values()].map(p => renderProjectCard(p)).join('');
}

function renderProjectCard(p) {
  const title = p.plan?.title || p.userInput?.substring(0, 40) || '新项目';
  const progress = Math.round(p.progress || 0);
  const tasks = p.tasks || [];

  const taskList = tasks.slice(0, 3).map((t, i) => {
    const isDone   = i < (p.currentTaskIndex || 0);
    const isActive = i === (p.currentTaskIndex || 0) && p.status === 'executing';
    return `<div class="pc-task ${isDone ? 'task-done' : isActive ? 'task-active' : ''}">
      <span class="task-icon">${isDone ? '✅' : isActive ? '⚡' : '○'}</span>
      <span>${t.title}</span>
    </div>`;
  }).join('');

  return `
    <div class="project-card status-${p.status} ${selectedProjectId === p.id ? 'selected' : ''}"
         onclick="selectProject('${p.id}')">
      <div class="pc-header">
        <div class="pc-title">${title}</div>
        <span class="pc-status-badge badge-${p.status}">${statusIndicatorDot(p.status)} ${statusLabel(p.status)}</span>
      </div>
      <div class="progress-wrap">
        <div class="progress-info">
          <span>${progressLabel(p.status)} (🔄 第 ${p.iteration || 1}/${p.maxIterations || 3} 轮)</span>
          <span>${progress}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill fill-${p.status}" style="width:${progress}%"></div>
        </div>
      </div>
      ${tasks.length ? `<div class="pc-tasks">${taskList}</div>` : ''}
      <div class="pc-footer">
        <span>${p.mode === 'creative' ? '💡 创意' : '📋 标准'} · 🔄 ${p.iteration || 1}/${p.maxIterations || 3} 轮 · ${timeAgo(p.createdAt)}</span>
        <button class="btn-review" onclick="openReview('${p.id}',event)">查看详情 →</button>
      </div>
    </div>`;
}

// ── 🔴🟡🟢 三色状态指示灯系统 ────────────────────────────────────────────────
function statusIndicatorDotPure(status) {
  if (status === 'error') return `<span class="dot dot-red"></span>`;
  if (['planning', 'executing', 'waiting_answer'].includes(status)) return `<span class="dot dot-yellow"></span>`;
  if (status === 'completed') return `<span class="dot dot-green"></span>`;
  if (status === 'stopped') return `<span class="dot" style="background:#ff6b6b"></span>`;
  return `<span class="dot" style="background:var(--text-muted)"></span>`;
}

function statusIndicatorDot(status) {
  if (status === 'error') return `<span class="dot dot-red" title="🔴 错误"></span>`;
  if (['planning', 'executing', 'waiting_answer'].includes(status)) return `<span class="dot dot-yellow" title="🟡 思考中"></span>`;
  if (status === 'completed') return `<span class="dot dot-green" title="🟢 已完成"></span>`;
  if (status === 'stopped') return `<span class="dot" style="background:#ff6b6b" title="⏹ 已中止"></span>`;
  return `<span class="dot" style="background:var(--text-muted)"></span>`;
}

// 判断项目当前是否正在生成（用于控制中止按钮显隐）
function isProjectGenerating(status) {
  return ['planning', 'executing', 'waiting_answer'].includes(status);
}

// ── ⏹ 中止当前项目生成 ────────────────────────────────────────────────────────
async function stopGeneration() {
  if (!selectedProjectId) return;
  try {
    await fetch(`${API_URL}/api/projects/${selectedProjectId}/stop`, { method: 'POST' });
    showToast('⏹ 中止信号已发送，模型生成将停止', 'info');
  } catch (e) {
    showToast('中止失败：' + e.message, 'error');
  }
}

// ── @ 指令提示菜单 ────────────────────────────────────────────────────────────
function handleInterveneInput(e) {
  const val = e.target.value;
  const atMenu = document.getElementById('atMenu');
  // 检测到末尾是 @ 符号时弹出菜单
  if (val.endsWith('@')) {
    atMenu.style.display = 'block';
    // 给每个选项绑定点击
    document.querySelectorAll('.at-item').forEach(item => {
      item.onclick = () => {
        const inp = document.getElementById('interveneInput');
        inp.value = val.slice(0, -1) + item.dataset.value;
        atMenu.style.display = 'none';
        inp.focus();
      };
    });
  } else {
    atMenu.style.display = 'none';
  }
}

// 点击其他区域关闭 @ 菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('.intervention-container')) {
    const m = document.getElementById('atMenu');
    if (m) m.style.display = 'none';
  }
});

function statusLabel(status) {
  return {
    idle: '空闲',
    queued: '排队中',
    planning: '策略思考规画中',
    executing: '执行脑生成中',
    waiting_answer: '协同研判中',
    completed: '已完成',
    stopped: '⏹ 已中止',
    error: '错误 / 等待授权'
  }[status] || status;
}

function progressLabel(status) {
  return {
    idle: '等待', queued: '排队', planning: '策略脑思考规画中',
    executing: '执行脑生成中', waiting_answer: '策略脑回答中',
    completed: '完成', stopped: '已中止', error: '出错 / 等待授权'
  }[status] || '';
}

function timeAgo(isoString) {
  if (!isoString) return '刚刚';
  const diff = (Date.now() - new Date(isoString)) / 1000;
  if (diff < 60) return `${Math.round(diff)}秒前`;
  if (diff < 3600) return `${Math.round(diff / 60)}分钟前`;
  return `${Math.round(diff / 3600)}小时前`;
}

// ── 项目选择与对话界面 ──────────────────────────────────────────────────────
function selectProject(projectId) {
  selectedProjectId = projectId;
  const project = projects.get(projectId);
  if (!project) return;

  const msgArea = document.getElementById('messageArea');
  msgArea.style.display = 'flex';

  updateSelectedProjectHeader();

  const container = document.getElementById('messagesContainer');
  container.innerHTML = '';
  clearStreamOutput();

  (project.messages || []).forEach(msg => appendMessage(msg, false));
  container.scrollTop = container.scrollHeight;

  renderThoughts(projectId);

  const selectEl = document.getElementById('executorModelSelect');
  if (selectEl && project.executorConfig?.model) {
    selectEl.value = project.executorConfig.model;
  }

  renderAll();
}

async function adjustMaxIterations(delta) {
  if (!selectedProjectId) return;
  const p = projects.get(selectedProjectId);
  if (!p) return;

  const newMax = Math.max(1, (p.maxIterations || 3) + delta);
  if (newMax === p.maxIterations) return;

  p.maxIterations = newMax;
  updateSelectedProjectHeader();
  renderAll();

  try {
    const resp = await fetch(`${API_URL}/api/projects/${selectedProjectId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxIterations: newMax })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    showToast(`⚙️ 已更新迭代上限为: ${newMax} 轮`, 'success');
  } catch (e) {
    showToast(`❌ 更新失败: ${e.message}`, 'error');
  }
}

async function changeExecutorModel(model) {
  if (!selectedProjectId) return;
  try {
    const executorConfig = { provider: 'antigravity', model };
    const resp = await fetch(`${API_URL}/api/projects/${selectedProjectId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executorConfig })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    showToast(`🟢 执行脑模型已切换为: ${model}`, 'success');
  } catch (e) {
    showToast(`❌ 切换失败: ${e.message}`, 'error');
  }
}

function updateSelectedProjectHeader() {
  if (!selectedProjectId) return;
  const p = projects.get(selectedProjectId);
  if (!p) return;
  document.getElementById('selectedProjectTitle').textContent =
    `📋 ${p.plan?.title || p.userInput?.substring(0, 35) || '项目详情'}`;

  const statusEl = document.getElementById('selectedProjectStatus');
  if (statusEl) {
    statusEl.className = `pc-status-badge badge-${p.status}`;
    statusEl.innerHTML = `${statusIndicatorDot(p.status)} ${statusLabel(p.status)}`;
  }

  const iterDisplay = document.getElementById('iterationDisplay');
  if (iterDisplay) {
    iterDisplay.textContent = `${p.iteration || 1}/${p.maxIterations || 3} 轮`;
  }

  // 动态显隐中止按钮：仅在项目正在生成时显示
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    stopBtn.style.display = isProjectGenerating(p.status) ? 'inline-flex' : 'none';
  }
}

// ── 🧠 实时思考过程流（在折叠面板与聊天框双向跟进展示） ──────────────────────
function appendThought(projectId, role, token) {
  if (!thoughtsMap.has(projectId)) {
    thoughtsMap.set(projectId, '');
  }
  const currentText = thoughtsMap.get(projectId) + token;
  thoughtsMap.set(projectId, currentText);

  // 1. 更新顶部折叠面板
  if (projectId === selectedProjectId) {
    const body = document.getElementById('thoughtsBody');
    const placeholder = document.getElementById('thoughtPlaceholder');
    if (placeholder) placeholder.remove();

    body.textContent = currentText;
    body.scrollTop = body.scrollHeight;

    // 2. 直接在聊天框内跟进展示思考过程 (Reasoning Bubble)
    updateInlineThoughtBubble(role, currentText);
  }
}

function updateInlineThoughtBubble(role, text) {
  const container = document.getElementById('messagesContainer');
  let bubble = document.getElementById('inlineThoughtBubble');

  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'inlineThoughtBubble';
    bubble.className = 'message-bubble system thought-bubble';
    container.appendChild(bubble);
  }

  const roleName = role === 'planner' ? '🔵 策略脑' : '🟢 执行脑';
  bubble.innerHTML = `
    <div class="bubble-content thought-content">
      <div class="thought-bubble-header">
        <span>🧠 <strong>${roleName} 实时思考推理过程 (Reasoning Stream)...</strong></span>
      </div>
      <pre class="thought-text">${escapeHtml(text)}</pre>
    </div>`;

  container.scrollTop = container.scrollHeight;
}

function renderThoughts(projectId) {
  const body = document.getElementById('thoughtsBody');
  const text = thoughtsMap.get(projectId) || '';
  if (!text) {
    body.innerHTML = `<div class="thought-placeholder" id="thoughtPlaceholder">等待策略脑/执行脑生成推理思考...</div>`;
  } else {
    body.textContent = text;
    body.scrollTop = body.scrollHeight;
  }
}

function toggleThoughts() {
  const body = document.getElementById('thoughtsBody');
  const icon = document.getElementById('thoughtsToggleIcon');
  thoughtsExpanded = !thoughtsExpanded;
  if (thoughtsExpanded) {
    body.style.display = 'block';
    icon.textContent = '▼';
  } else {
    body.style.display = 'none';
    icon.textContent = '▲';
  }
}

// ── ⚙️ 主界面模型与外接 API 设置切换 ───────────────────────────────────────
function toggleGlobalConfig() {
  const body = document.getElementById('globalConfigBody');
  const icon = document.getElementById('configToggleIcon');
  globalConfigExpanded = !globalConfigExpanded;
  body.style.display = globalConfigExpanded ? 'flex' : 'none';
  icon.textContent = globalConfigExpanded ? '▲' : '▼';
}

function setPlannerProvider(provider) {
  plannerProvider = provider;
  document.getElementById('plannerBuiltinBtn').classList.toggle('active', provider === 'built-in');
  document.getElementById('plannerCustomBtn').classList.toggle('active', provider === 'custom_api');
  document.getElementById('plannerBuiltinBox').style.display = provider === 'built-in' ? 'block' : 'none';
  document.getElementById('plannerCustomBox').style.display = provider === 'custom_api' ? 'flex' : 'none';
}

function setExecutorProvider(provider) {
  executorProvider = provider;
  document.getElementById('executorBuiltinBtn').classList.toggle('active', provider === 'antigravity');
  document.getElementById('executorCustomBtn').classList.toggle('active', provider === 'custom_api');
  document.getElementById('executorBuiltinBox').style.display = provider === 'antigravity' ? 'block' : 'none';
  document.getElementById('executorCustomBox').style.display = provider === 'custom_api' ? 'flex' : 'none';
}

// ── 消息渲染与流式 Token ────────────────────────────────────────────────────
function appendMessage(msg, scroll = true) {
  if (!selectedProjectId) return;
  const container = document.getElementById('messagesContainer');

  // 若聊天框存在思考流临时 Bubble，移掉以插入正式对话
  const inlineBubble = document.getElementById('inlineThoughtBubble');
  if (inlineBubble && msg.role !== 'thought') {
    inlineBubble.remove();
  }

  const el = document.createElement('div');
  el.className = `message-bubble ${msg.role}`;

  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  if (msg.role === 'system') {
    el.innerHTML = `<div class="bubble-content system">${escapeHtml(msg.content)}</div>`;
  } else {
    let avatar = '🔵';
    let label = '策略脑';

    if (msg.role === 'executor') {
      avatar = '🟢'; label = '执行脑';
    } else if (msg.role === 'user') {
      avatar = '👤'; label = '用户介入';
    }

    el.innerHTML = `
      <div class="bubble-avatar avatar-${msg.role}">${avatar}</div>
      <div>
        <div class="bubble-content ${msg.role}">${formatMessage(msg.content)}</div>
        <div class="bubble-meta">${label} · ${time}</div>
      </div>`;
  }

  container.appendChild(el);
  if (scroll) container.scrollTop = container.scrollHeight;
}

let streamBufferMap = new Map(); // projectId -> text

function appendProjectStreamToken(projectId, role, token) {
  const current = (streamBufferMap.get(projectId) || '') + token;
  streamBufferMap.set(projectId, current);

  if (projectId === selectedProjectId) {
    const streamOutput = document.getElementById('streamOutput');
    if (streamOutput) {
      streamOutput.textContent = current;
      streamOutput.scrollTop = streamOutput.scrollHeight;
    }
    updateInlineStreamBubble(role, current);
  }
}

function clearProjectStreamOutput(projectId) {
  if (projectId) {
    streamBufferMap.delete(projectId);
  } else {
    streamBufferMap.clear();
  }
  if (!selectedProjectId || projectId === selectedProjectId) {
    const streamOutput = document.getElementById('streamOutput');
    if (streamOutput) streamOutput.textContent = '';
    const bubble = document.getElementById('inlineStreamBubble');
    if (bubble) bubble.remove();
  }
}

function clearStreamOutput() {
  clearProjectStreamOutput(selectedProjectId);
}

function updateInlineStreamBubble(role, text) {
  const container = document.getElementById('messagesContainer');
  if (!container) return;

  let bubble = document.getElementById('inlineStreamBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'inlineStreamBubble';
    bubble.className = `message-bubble ${role} streaming-bubble`;
    container.appendChild(bubble);
  }

  const roleName = role === 'planner' ? '🔵 策略脑' : '🟢 执行脑';
  const avatar = role === 'planner' ? '🔵' : '🟢';

  bubble.innerHTML = `
    <div class="bubble-avatar avatar-${role}">${avatar}</div>
    <div>
      <div class="bubble-content ${role}">${formatMessage(text)}<span class="typing-cursor">▌</span></div>
      <div class="bubble-meta">${roleName} 正在实时打字输出中...</div>
    </div>`;

  container.scrollTop = container.scrollHeight;
}

function formatMessage(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── ⚡ 实时介入功能 (支持文本与文件附件) ──────────────────────────────────────
function triggerFileInput() {
  document.getElementById('interveneFileInput').click();
}

function handleFileSelect(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = (e) => {
      attachedFiles.push({
        name: file.name,
        type: file.type || 'text/plain',
        content: e.target.result
      });
      renderAttachments();
    };
    reader.readAsText(file);
  }
  event.target.value = '';
}

function removeAttachment(index) {
  attachedFiles.splice(index, 1);
  renderAttachments();
}

function renderAttachments() {
  const container = document.getElementById('attachmentPreview');
  if (!attachedFiles.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = attachedFiles.map((f, i) => `
    <div class="attachment-chip" title="${escapeHtml(f.name)}">
      <span>📎 ${escapeHtml(f.name)}</span>
      <span class="chip-remove" onclick="removeAttachment(${i})">✕</span>
    </div>
  `).join('');
}

async function sendIntervention() {
  if (!selectedProjectId) {
    showToast('请先选择左侧项目', 'error'); return;
  }
  const inputEl = document.getElementById('interveneInput');
  const btnEl = document.getElementById('interveneBtn');
  let text = inputEl.value.trim();

  if (!text && attachedFiles.length === 0) {
    showToast('请输入介入指导内容或选择上传文件', 'error'); return;
  }

  // 解析 @ 路由前缀
  let targetBrain = 'all'; // 默认同时介入两个脑
  let toastLabel = '策略脑与执行脑';
  if (text.startsWith('@策略脑')) {
    targetBrain = 'planner';
    toastLabel = '策略脑';
    text = text.replace(/^@策略脑\s*/, '');
  } else if (text.startsWith('@执行脑')) {
    targetBrain = 'executor';
    toastLabel = '执行脑';
    text = text.replace(/^@执行脑\s*/, '');
  } else if (text.startsWith('@全体')) {
    targetBrain = 'all';
    toastLabel = '策略脑与执行脑';
    text = text.replace(/^@全体\s*/, '');
  }

  // 关闭 @ 菜单
  const atMenu = document.getElementById('atMenu');
  if (atMenu) atMenu.style.display = 'none';

  btnEl.disabled = true;
  btnEl.textContent = '⏳ 发送中...';

  try {
    const resp = await fetch(`${API_URL}/api/projects/${selectedProjectId}/intervene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userInstruction: text,
        files: attachedFiles,
        targetBrain  // 传递路由目标，后端可扩展使用
      })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    if (data.project) {
      projects.set(selectedProjectId, data.project);
      selectProject(selectedProjectId);
    }

    showToast(`⚡ 介入指令已发送给 ${toastLabel}！`, 'success');
    inputEl.value = '';
    attachedFiles = [];
    renderAttachments();
  } catch (e) {
    showToast(`❌ 介入失败: ${e.message}`, 'error');
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = '⚡ 发送介入';
  }
}

function handleInterveneKey(e) {
  if (e.key === 'Enter') {
    sendIntervention();
  }
  if (e.key === 'Escape') {
    const atMenu = document.getElementById('atMenu');
    if (atMenu) atMenu.style.display = 'none';
  }
}

// ── 创建项目 ────────────────────────────────────────────────────────────────
async function createProject() {
  const input = document.getElementById('projectInput').value.trim();
  const btn = document.getElementById('createProjectBtn');
  const maxIterations = parseInt(document.getElementById('maxIterationsInput')?.value || '3', 10);

  if (projects.size >= 6) {
    showToast('⚠️ 项目数量已达上限', 'error'); return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> 启动中...';

  const plannerConfig = {
    provider: plannerProvider,
    model: plannerProvider === 'built-in' 
      ? document.getElementById('plannerBuiltinSelect').value 
      : (document.getElementById('plannerCustomModel').value.trim() || 'deepseek-chat'),
    apiKey: document.getElementById('plannerApiKey').value.trim(),
    baseUrl: document.getElementById('plannerBaseUrl').value.trim(),
    webSearch: document.getElementById('plannerWebSearchToggle').checked
  };

  const executorConfig = {
    provider: executorProvider,
    model: executorProvider === 'antigravity' 
      ? document.getElementById('executorBuiltinSelect').value 
      : (document.getElementById('executorCustomModel').value.trim() || 'Qwen/Qwen2.5-72B-Instruct'),
    apiKey: document.getElementById('executorApiKey').value.trim(),
    baseUrl: document.getElementById('executorBaseUrl').value.trim(),
    webSearch: document.getElementById('executorWebSearchToggle').checked
  };

  try {
    const resp = await fetch(`${API_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userInput: input || '帮我想一个有趣的项目',
        mode: currentMode,
        plannerConfig,
        executorConfig,
        maxIterations,
        selectedSkill // 🎯 传递当前选中的项目技能 (默认 bili_toy)
      })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    // 立即建立项目实体并实时选中刷新
    const newProject = {
      id: data.projectId,
      userInput: input || '帮我想一个有趣的项目',
      mode: currentMode,
      status: 'planning',
      progress: 0,
      iteration: 1,
      maxIterations: maxIterations,
      plannerConfig,
      executorConfig,
      messages: [],
      createdAt: new Date().toISOString()
    };
    projects.set(data.projectId, newProject);

    showToast('🚀 项目已使用选定模型启动！', 'success');
    document.getElementById('projectInput').value = '';
    selectProject(data.projectId);
    renderAll();
  } catch (e) {
    showToast(`❌ ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🚀</span> 启动项目';
  }
}

async function deleteProject(projectId, event) {
  if (event) event.stopPropagation();
  if (!confirm('确定删除该项目及其构建数据吗？')) return;

  try {
    const res = await fetch(`${API_URL}/api/projects/${projectId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '删除失败');
    }
    projects.delete(projectId);
    thoughtsMap.delete(projectId);
    clearProjectStreamOutput(projectId);

    if (selectedProjectId === projectId) {
      selectedProjectId = null;
      document.getElementById('messageArea').style.display = 'none';
    }

    showToast('🗑️ 项目已删除', 'info');
    renderAll();
  } catch (e) {
    showToast(`删除失败: ${e.message}`, 'error');
  }
}

// ── 模式切换 ────────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
  });
});

// ── 审查台 ──────────────────────────────────────────────────────────────────
function openReview(projectId, event) {
  if (event) event.stopPropagation();
  const pId = projectId || selectedProjectId;
  currentReviewProject = projects.get(pId);
  if (!currentReviewProject) return;
  switchTab('result');
  document.getElementById('reviewPanel').classList.add('open');
}

function closeReview() {
  document.getElementById('reviewPanel').classList.remove('open');
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  const content = document.getElementById('reviewContent');
  const p = currentReviewProject;
  if (!p) return;

  if (tab === 'result') {
    const raw = p.result || '项目尚未完成';
    const htmlMatch = raw.match(/(<!DOCTYPE html>[\s\S]*<\/html>)/i) || raw.match(/```html([\s\S]*?)```/i);
    if (htmlMatch) {
      const code = htmlMatch[1] || htmlMatch[0];
      const blob = new Blob([code], { type: 'text/html; charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      content.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:12px; height:100%;">
          <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(0,212,170,0.08); padding:8px 12px; border-radius:6px; border:1px solid rgba(0,212,170,0.25);">
            <span style="font-weight:600; color:var(--accent-green); font-size:0.85rem;">🌐 HTML5 网页构建产物 - 实时交互预览视窗</span>
            <a href="${blobUrl}" target="_blank" class="btn-review" style="text-decoration:none;">在新标签页独立全屏运行 ↗</a>
          </div>
          <iframe src="${blobUrl}" style="width:100%; height:420px; border:1px solid var(--glass-border); border-radius:8px; background:#ffffff;"></iframe>
          <details style="background:rgba(255,255,255,0.02); padding:10px; border-radius:6px; border:1px solid var(--glass-border);">
            <summary style="cursor:pointer; color:var(--accent-blue); font-size:0.8rem; font-weight:600;">📄 点击展开 / 隐藏 HTML5 源代码</summary>
            <pre style="margin-top:10px; max-height:250px; overflow-y:auto; font-size:0.75rem; color:var(--text-primary);">${escapeHtml(code)}</pre>
          </details>
        </div>`;
    } else {
      content.textContent = raw;
    }
  } else if (tab === 'plan') {
    content.textContent = p.plan ? JSON.stringify(p.plan, null, 2) : '暂无计划';
  } else if (tab === 'log') {
    content.textContent = (p.messages || []).map(m =>
      `[${new Date(m.timestamp).toLocaleTimeString()}] [${m.role.toUpperCase()}]\n${m.content}\n`
    ).join('\n---\n\n');
  }
}

function copyToClipboard() {
  const text = document.getElementById('reviewContent').textContent;
  navigator.clipboard.writeText(text).then(() => showToast('📋 已复制到剪贴板', 'success'));
}

function sendToAntigravity() {
  const p = currentReviewProject;
  if (!p) return;
  const prompt = `请帮我审查并优化以下项目结果：\n\n**项目**：${p.plan?.title || '项目'}\n\n**成果**：\n${p.result || ''}`;
  navigator.clipboard.writeText(prompt).then(() => {
    showToast('⚡ 提示词已复制，请粘贴到 Antigravity 对话框', 'info');
  });
}

function clearMessages() {
  document.getElementById('messagesContainer').innerHTML = '';
  clearStreamOutput();
}

function exportResult() {
  const p = projects.get(selectedProjectId);
  if (!p?.result) { showToast('暂无结果', 'error'); return; }

  const raw = p.result;
  const title = (p.plan?.title || 'project').replace(/[\\/:*?"<>|]/g, '_');

  // 1. 动态匹配代码块语言类型或 HTML 网页
  const htmlMatch = raw.match(/(<!DOCTYPE html>[\s\S]*<\/html>)/i);
  const codeBlockMatch = raw.match(/```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);

  let content = raw;
  let ext = 'md';
  let mimeType = 'text/markdown; charset=utf-8';

  if (htmlMatch) {
    content = htmlMatch[1].trim();
    ext = 'html';
    mimeType = 'text/html; charset=utf-8';
  } else if (codeBlockMatch) {
    const lang = (codeBlockMatch[1] || '').toLowerCase();
    const code = codeBlockMatch[2].trim();

    if (['html', 'htm'].includes(lang)) {
      content = code;
      ext = 'html';
      mimeType = 'text/html; charset=utf-8';
    } else if (['json'].includes(lang)) {
      content = code;
      ext = 'json';
      mimeType = 'application/json; charset=utf-8';
    } else if (['py', 'python'].includes(lang)) {
      content = code;
      ext = 'py';
      mimeType = 'text/x-python; charset=utf-8';
    } else if (['svg'].includes(lang)) {
      content = code;
      ext = 'svg';
      mimeType = 'image/svg+xml; charset=utf-8';
    } else if (['csv'].includes(lang)) {
      content = code;
      ext = 'csv';
      mimeType = 'text/csv; charset=utf-8';
    } else if (['xml'].includes(lang)) {
      content = code;
      ext = 'xml';
      mimeType = 'application/xml; charset=utf-8';
    } else if (['js', 'javascript'].includes(lang)) {
      content = code;
      ext = 'js';
      mimeType = 'application/javascript; charset=utf-8';
    } else if (['css'].includes(lang)) {
      content = code;
      ext = 'css';
      mimeType = 'text/css; charset=utf-8';
    } else if (['sql'].includes(lang)) {
      content = code;
      ext = 'sql';
      mimeType = 'text/plain; charset=utf-8';
    } else if (lang) {
      content = code;
      ext = lang;
      mimeType = 'text/plain; charset=utf-8';
    }
  }

  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}.${ext}`;
  a.click();
  showToast(`📁 已按设计格式导出产物: ${title}.${ext}`, 'success');
}

// ── 健康与状态灯 ─────────────────────────────────────────────────────────────
function updateHealth(online) {
  const el = document.getElementById('healthIndicator');
  let hasProcessing = false;
  let hasError = false;

  for (const p of projects.values()) {
    if (['planning','executing','waiting_answer'].includes(p.status)) hasProcessing = true;
    if (p.status === 'error') hasError = true;
  }

  if (!online || hasError) {
    el.innerHTML = `<span class="dot dot-red"></span><span>${online ? '🔴 异常 / 等待授权' : '🔴 断开连接'}</span>`;
  } else if (hasProcessing) {
    el.innerHTML = `<span class="dot dot-yellow"></span><span>🟡 正在思考与协同中...</span>`;
  } else {
    el.innerHTML = `<span class="dot dot-green"></span><span>🟢 系统就绪</span>`;
  }
}

// ── Toast ───────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
connectWS();
