// backend/orchestrator.js
// 核心编排器：管理项目状态、调度策略脑和执行脑（支持自带与外接 API）、处理双脑思考流与用户实时介入

import { EventEmitter } from 'events';
import { PlannerAgent } from './agents/planner.js';
import { executeTask, buildExecutorPrompt } from './agents/executor_bridge.js';
import { resolveStrategyConfig, resolveExecutorConfig } from './lib/llm.js';
import 'dotenv/config';

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getUserdataDir, getWorkspaceBase } from './lib/paths.js';
const userdataDir = getUserdataDir();
const projectsFilePath = path.join(userdataDir, 'projects.json');

export const ProjectStatus = {
  IDLE: 'idle',
  PLANNING: 'planning',       // 策略脑规划中
  AWAITING_APPROVAL: 'awaiting_approval', // 📋 Plan 模式：策略脑规划完成，等待用户批准
  EXECUTING: 'executing',     // 执行脑执行中
  WAITING_ANSWER: 'waiting_answer', // 等待策略脑回答
  COMPLETED: 'completed',     // 项目完成
  STOPPED: 'stopped',         // 用户主动中止
  ERROR: 'error'
};

export class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.planner = new PlannerAgent();
    // 策略脑工具调用记录回调（Dashboard 展示）
    this.planner.setToolCallback((projectId, toolName, args) => {
      this._recordToolCall(projectId, 'planner', toolName, args);
    });
    // 双脑 LLM 客户端统一由 backend/lib/llm.js 工厂创建（策略脑高性能 / 执行脑低性能）
    this.projects = new Map();
    this.abortControllers = new Map(); // 每个项目的 AbortController，用于中止生成
    this.maxParallel = 3;
    this.activeCount = 0;
    this.queue = [];

    // 初始化时自动加载与无损恢复磁盘项目记录
    this._loadProjectsFromDisk();
  }

  _loadProjectsFromDisk() {
    try {
      if (!fs.existsSync(userdataDir)) {
        fs.mkdirSync(userdataDir, { recursive: true });
      }

      if (fs.existsSync(projectsFilePath)) {
        const raw = fs.readFileSync(projectsFilePath, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const p of list) {
            if (['planning', 'executing', 'waiting_answer', 'awaiting_approval'].includes(p.status)) {
              p.status = ProjectStatus.STOPPED;
            }
            this.projects.set(p.id, p);
          }
        }
      }

      // 从 workspace 物理目录智能反补恢复缺失的项目记录
      const workspaceBase = getWorkspaceBase();
      if (fs.existsSync(workspaceBase)) {
        const dirs = fs.readdirSync(workspaceBase);
        for (const dirName of dirs) {
          if (!this.projects.has(dirName)) {
            const dirPath = path.join(workspaceBase, dirName);
            try {
              if (fs.statSync(dirPath).isDirectory()) {
                const htmlPath = path.join(dirPath, 'index.html');
                let htmlContent = null;
                if (fs.existsSync(htmlPath)) {
                  try { htmlContent = fs.readFileSync(htmlPath, 'utf-8'); } catch(e) {}
                }
                const recoveredProject = {
                  id: dirName,
                  userInput: `工作区历史项目 (${dirName.substring(0, 8)})`,
                  mode: 'standard',
                  selectedSkill: 'bili_toy',
                  status: ProjectStatus.COMPLETED,
                  plan: { title: `构建产物 (${dirName.substring(0, 8)})`, summary: '从工作区恢复的历史成果' },
                  tasks: [{ id: 1, title: '实体代码构建', output: htmlContent || '完整 HTML5 应用' }],
                  messages: [{ role: 'system', content: '🎉 已从工作区目录无损恢复项目记录', timestamp: new Date().toISOString() }],
                  iteration: 1,
                  maxIterations: 3,
                  progress: 100,
                  result: htmlContent || '项目代码已构建',
                  createdAt: new Date().toISOString(),
                  completedAt: new Date().toISOString()
                };
                this.projects.set(dirName, recoveredProject);
              }
            } catch(e) {}
          }
        }
      }

      console.log(`[Orchestrator] ✅ 已无损恢复 ${this.projects.size} 个历史项目记录`);
    } catch (e) {
      console.warn('[Orchestrator] 读取/恢复历史项目记录失败:', e.message);
    }
  }

  _saveProjectsToDisk() {
    try {
      if (!fs.existsSync(userdataDir)) {
        fs.mkdirSync(userdataDir, { recursive: true });
      }
      const list = Array.from(this.projects.values());
      fs.writeFileSync(projectsFilePath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[Orchestrator] 持久化项目记录失败:', e.message);
    }
  }

  _emit(projectId, type, data) {
    this._saveProjectsToDisk();
    this.emit('update', { projectId, type, data, timestamp: new Date().toISOString() });
  }

  getProjects() {
    return Array.from(this.projects.values());
  }

  getProject(projectId) {
    return this.projects.get(projectId);
  }

  async createProject(projectId, userInput, mode = 'standard', agentMode = 'act', plannerConfig = null, executorConfig = null, maxIterations = 3, selectedSkill = 'bili_toy', workDir = '') {
    const project = {
      id: projectId,
      userInput,
      mode,
      agentMode: agentMode === 'plan' ? 'plan' : 'act', // 🔀 Plan/Act 模式（默认 act）
      planStep: 0, // Plan 模式下的步骤推进（0=等待批准规划，1=已批准执行中）
      selectedSkill: selectedSkill || 'bili_toy', // 🎯 选中的项目技能 (如 bili_toy)
      status: ProjectStatus.IDLE,
      plan: null,
      tasks: [],
      currentTaskIndex: 0,
      messages: [],
      thoughts: [],
      iteration: 1,
      maxIterations: Number(maxIterations) || 3,
      plannerConfig: plannerConfig || resolveStrategyConfig(),
      executorConfig: executorConfig || resolveExecutorConfig(),
      createdAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      progress: 0,
      workDir: workDir || '',
      fileActions: [],
      toolCalls: [], // 🛠️ 双脑实时本地工具调用记录
    };

    this.projects.set(projectId, project);

    // 注入项目工作区到策略脑（本地工具安全边界：优先用户 workDir，否则使用内部 workspace/id）
    const resolvedWorkspace = workDir && workDir.trim()
      ? path.resolve(workDir)
      : path.join(getWorkspaceBase(), projectId);
    this.planner.setProjectWorkspace(projectId, resolvedWorkspace);

    // Plan 模式：策略脑仅使用只读工具（类似 Cline 的 Plan 模式约束）
    this.planner.setPlanMode(projectId, project.agentMode === 'plan');

    this._emit(projectId, 'project_created', { project });

    if (this.activeCount < this.maxParallel) {
      await this._startProject(projectId);
    } else {
      project.status = 'queued';
      this.queue.push(projectId);
      this._emit(projectId, 'project_queued', { position: this.queue.length });
    }
  }

  async _startProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    // 为本项目创建 AbortController，用于中止正在进行的生成
    const abortCtrl = new AbortController();
    this.abortControllers.set(projectId, abortCtrl);

    this.activeCount++;

    try {
      // === Phase 1: 策略脑规划 (带流式思考过程) ===
      project.status = ProjectStatus.PLANNING;
      this._emit(projectId, 'status_change', { status: ProjectStatus.PLANNING });

      const plannerModelName = project.plannerConfig?.model || resolveStrategyConfig().model;
      this._addMessage(projectId, 'planner', `🔵 策略脑（模型: ${plannerModelName}）开始分析需求... (当前第 ${project.iteration}/${project.maxIterations} 轮迭代)`);

      const onPlannerChunk = (type, token) => {
        if (type === 'thought') {
          this._addThought(projectId, 'planner', token);
        } else {
          this._emit(projectId, 'planner_token', { token });
        }
      };

      const signal = abortCtrl.signal;
      let planResult;
      if (project.mode === 'creative') {
        this._addMessage(projectId, 'system', '💡 创意模式：策略脑正在头脑风暴生成方案...');
        planResult = await this.planner.generateIdeas(projectId, project.userInput, project.plannerConfig, onPlannerChunk, signal);
        if (planResult.type === 'ideas') {
          this._addMessage(projectId, 'planner',
            `💡 **生成了 ${planResult.ideas.length} 个想法**\n` +
            planResult.ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n') +
            `\n\n✅ **选定方案**：${planResult.selected}\n📝 原因：${planResult.reason}`
          );
          planResult = await this.planner.generatePlan(projectId, planResult.selected, project.plannerConfig, onPlannerChunk, signal);
        }
      } else {
        planResult = await this.planner.generatePlan(projectId, project.userInput, project.plannerConfig, onPlannerChunk, signal);
      }

      project.plan = planResult;
      project.tasks = planResult.tasks || [];
      project.framework = planResult.framework || '';
      project.progress = 10;

      const approvalMsg = (project.agentMode === 'plan')
        ? `\n\n📋 **【Plan 模式】规划已完成，等待你审批！** 请点击「✅ 批准并执行」开始落地，或输入介入意见调整方案。`
        : `\n\n【信号通知】策略脑已完成初版规划，发出【PLAN_READY】信号！系统将自动拉起【执行脑 (外接 API)】去完成剩余任务。`;

      this._addMessage(projectId, 'planner',
        `📋 **第 ${project.iteration} 轮策略规划完成**：${planResult.title || '项目'}\n` +
        `📝 ${planResult.summary || ''}\n\n` +
        `📌 **任务列表** (共${project.tasks.length}个)：\n` +
        project.tasks.map(t => `  ${t.id}. ${t.title}`).join('\n') +
        (project.framework ? `\n\n🏗️ **策略脑已亲自完成整体框架与高难度部分**，执行脑将基于 framework 继续构建剩余任务` : '') +
        approvalMsg
      );
      this._emit(projectId, 'plan_ready', { plan: planResult, iteration: project.iteration, agentMode: project.agentMode });

      // === Plan 模式：规划完成后停靠，等待用户批准 ===
      if (project.agentMode === 'plan') {
        project.status = ProjectStatus.AWAITING_APPROVAL;
        project.planStep = 0;
        this.abortControllers.delete(projectId); // 释放中断控制器（无生成进行中）
        this._emit(projectId, 'status_change', { status: ProjectStatus.AWAITING_APPROVAL, planStep: 0 });
        this._addMessage(projectId, 'system', '⏸️ **Agent 处于 Plan 模式，已暂停在规划阶段。** 批准后可开始执行。');
        return; // 停靠在等待批准，不进入执行阶段
      }

      // === Phase 2: 执行脑逐任务执行 + 多轮迭代循环 ===
      await this._executeTasksAndIterate(projectId, 0);

    } catch (error) {
      if (error.name === 'AbortError' || project.status === ProjectStatus.STOPPED) {
        project.status = ProjectStatus.STOPPED;
        this._addMessage(projectId, 'system', `⏹️ **项目已被用户中止。** 可重新发起介入或查看已有结果。`);
        this._emit(projectId, 'status_change', { status: ProjectStatus.STOPPED });
      } else {
        project.status = ProjectStatus.ERROR;
        project.error = error.message;
        this._addMessage(projectId, 'system', `❌ 错误：${error.message}`);
        this._emit(projectId, 'status_change', { status: ProjectStatus.ERROR, error: error.message });
      }
    } finally {
      this.abortControllers.delete(projectId);
      this.activeCount--;
      this._processQueue();
    }
  }

  /**
   * 用户主动中止项目生成（中断策略脑/执行脑当前生成流）
   */
  stopProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不存在');

    if (this.abortControllers.has(projectId)) {
      this.abortControllers.get(projectId).abort();
      this.abortControllers.delete(projectId);
    }
    project.status = ProjectStatus.STOPPED;
    this._emit(projectId, 'status_change', { status: ProjectStatus.STOPPED });
  }

  /**
   * 用户重试/继续已中止的项目
   */
  async resumeProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不存在');
    if (![ProjectStatus.STOPPED, ProjectStatus.ERROR].includes(project.status)) {
      throw new Error('只有已中止或异常的项目才可以重试');
    }

    if (project.plan && project.tasks && project.tasks.length > 0) {
      project.status = ProjectStatus.EXECUTING;
      this._emit(projectId, 'status_change', { status: ProjectStatus.EXECUTING });
      this._addMessage(projectId, 'system', '🔄 收到重试/恢复指令，正在继续执行未完成的任务...');

      const abortCtrl = new AbortController();
      this.abortControllers.set(projectId, abortCtrl);
      this.activeCount++;

      try {
        await this._executeTasksAndIterate(projectId, project.currentTaskIndex || 0);
      } catch (error) {
        if (error.name === 'AbortError' || project.status === ProjectStatus.STOPPED) {
          project.status = ProjectStatus.STOPPED;
          this._addMessage(projectId, 'system', `⏹️ **项目已被用户中止。** 可重新发起介入或查看已有结果。`);
          this._emit(projectId, 'status_change', { status: ProjectStatus.STOPPED });
        } else {
          project.status = ProjectStatus.ERROR;
          project.error = error.message;
          this._addMessage(projectId, 'system', `❌ 错误：${error.message}`);
          this._emit(projectId, 'status_change', { status: ProjectStatus.ERROR, error: error.message });
        }
      } finally {
        this.abortControllers.delete(projectId);
        this.activeCount--;
        this._processQueue();
      }
    } else {
      await this._startProject(projectId);
    }
  }

  /**
   * 💡 Plan 模式：用户批准策略脑规划后，开始执行
   * 角色类似 Cline 的 Plan→Act 切换：规划已完成并展示给用户，批准后 Agent 进入执行态
   */
  async approveProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不存在');
    if (project.status !== ProjectStatus.AWAITING_APPROVAL) {
      throw new Error('当前项目不在等待批准状态（仅 Plan 模式项目可批准）');
    }
    if (!project.plan || !project.tasks || project.tasks.length === 0) {
      throw new Error('尚无可用规划，无法批准执行');
    }

    // 标记已批准，切换为 Act 执行阶段（解除只读工具限制，Agent 获得全量工具）
    project.status = ProjectStatus.EXECUTING;
    project.planStep = 1;
    this.planner.setPlanMode(projectId, false);
    this._emit(projectId, 'status_change', { status: ProjectStatus.EXECUTING, planStep: 1 });
    this._addMessage(projectId, 'system',
      `✅ **用户已批准规划！** Agent 从 Plan 模式切换到 Act 模式，开始执行 ${project.tasks.length} 个任务...`
    );

    const abortCtrl = new AbortController();
    this.abortControllers.set(projectId, abortCtrl);
    this.activeCount++;

    try {
      await this._executeTasksAndIterate(projectId, project.currentTaskIndex || 0);
    } catch (error) {
      if (error.name === 'AbortError' || project.status === ProjectStatus.STOPPED) {
        project.status = ProjectStatus.STOPPED;
        this._addMessage(projectId, 'system', `⏹️ **项目已被用户中止。** 可重新发起介入或查看已有结果。`);
        this._emit(projectId, 'status_change', { status: ProjectStatus.STOPPED });
      } else {
        project.status = ProjectStatus.ERROR;
        project.error = error.message;
        this._addMessage(projectId, 'system', `❌ 错误：${error.message}`);
        this._emit(projectId, 'status_change', { status: ProjectStatus.ERROR, error: error.message });
      }
    } finally {
      this.abortControllers.delete(projectId);
      this.activeCount--;
      this._processQueue();
    }
  }

  async _executeTasksAndIterate(projectId, startIndex = 0) {
    const project = this.projects.get(projectId);
    if (!project || !project.tasks.length) return;

    for (let i = startIndex; i < project.tasks.length; i++) {
      project.currentTaskIndex = i;
      const task = project.tasks[i];

      const startProgress = Math.round(10 + (i / project.tasks.length) * 80);
      project.progress = startProgress;

      project.status = ProjectStatus.EXECUTING;
      this._emit(projectId, 'status_change', { status: ProjectStatus.EXECUTING, currentTaskIndex: i, progress: project.progress });
      this._emit(projectId, 'task_start', { taskId: task.id, taskTitle: task.title, taskIndex: i, totalTasks: project.tasks.length, progress: project.progress });

      this._addMessage(projectId, 'system',
        `⚡ **开始执行任务 ${task.id}/${project.tasks.length}** (第 ${project.iteration}/${project.maxIterations} 轮迭代)：${task.title}`
      );

      const execModelName = project.executorConfig?.model || resolveExecutorConfig().model;
      this._addMessage(projectId, 'executor', `🟢 执行脑（模型: ${execModelName}）接收任务：${task.description}`);

      // 单任务失败自动重试一次，提升整体执行鲁棒性
      let result;
      try {
        result = await this._callExecutor(projectId, task, null);
      } catch (execErr) {
        console.warn(`[Orchestrator] 任务 ${task.id} 首次执行失败，自动重试: ${execErr.message}`);
        this._addMessage(projectId, 'system', `⚠️ 任务 ${task.id} 首次执行异常，自动重试一次...`);
        result = await this._callExecutor(projectId, task, null);
      }

      if (result.type === 'question') {
        await this._handleQuestion(projectId, task, result.question);
        i--; // 重新执行此任务
        continue;
      }

      task.output = result.output;
      project.progress = Math.round(10 + ((i + 1) / project.tasks.length) * 80);
      this._addMessage(projectId, 'executor',
        `✅ **任务 ${task.id} 完成**\n${result.output?.substring(0, 600)}${result.output?.length > 600 ? '...' : ''}`
      );
      this._emit(projectId, 'task_complete', { taskId: task.id, currentTaskIndex: i, output: result.output, progress: project.progress });
    }

    // === Phase 3: 策略脑检测审查与多轮迭代循环 ===
    if (project.iteration < project.maxIterations) {
      this._addMessage(projectId, 'system',
        `🔄 **【迭代信号触发】执行脑已完成第 ${project.iteration} 轮代码构建！拉起策略脑进行效果审查与优化研判 (当前第 ${project.iteration}/${project.maxIterations} 轮)...**`
      );
      project.status = ProjectStatus.PLANNING;
      this._emit(projectId, 'status_change', { status: ProjectStatus.PLANNING });

      const onPlannerChunk = (type, token) => {
        if (type === 'thought') this._addThought(projectId, 'planner', token);
      };

      const reviewResult = await this.planner.reviewExecution(
        projectId,
        project.iteration,
        project.maxIterations,
        project.tasks,
        project.plannerConfig,
        onPlannerChunk,
        this.abortControllers.get(projectId)?.signal
      );

      if (reviewResult.decision === 'optimize' && reviewResult.new_tasks && reviewResult.new_tasks.length > 0) {
        project.iteration++;
        this._emit(projectId, 'iteration_update', { iteration: project.iteration, maxIterations: project.maxIterations });
        this._addMessage(projectId, 'planner',
          `🔵 **策略脑质量审查结果：发起第 ${project.iteration} 轮迭代优化构建！**\n` +
          `📝 **瑕疵分析：** ${reviewResult.analysis || reviewResult.summary || '根据评估进行优化细节改善'}\n\n` +
          `📌 **第 ${project.iteration} 轮追加优化任务：**\n` +
          reviewResult.new_tasks.map((t, idx) => `  ${project.tasks.length + idx + 1}. ${t.title}`).join('\n') +
          `\n\n【信号通知】策略脑已发回优化策略，再次自动拉起【执行脑】去实施后续任务。`
        );

        const startId = project.tasks.length + 1;
        const formattedNewTasks = reviewResult.new_tasks.map((t, idx) => ({
          id: startId + idx,
          title: t.title,
          description: t.description,
          expected_output: t.expected_output
        }));
        project.tasks.push(...formattedNewTasks);

        // 递归拉起执行脑执行新任务
        await this._executeTasksAndIterate(projectId, startId - 1);
        return;
      } else {
        this._addMessage(projectId, 'planner',
          `🎉 **策略脑终审通过！**\n` +
          `📝 **终审结论：** ${reviewResult.analysis || reviewResult.summary || '作品质量达到预期，无需进一步调整。'}`
        );
      }
    } else {
      this._addMessage(projectId, 'system',
        `🏁 **项目已达到设定的最高迭代上限 (${project.maxIterations} 轮)！策略脑完成终审。**`
      );
    }

    project.status = ProjectStatus.COMPLETED;
    project.completedAt = new Date().toISOString();
    project.progress = 100;
    project.result = project.tasks.map(t => `### 任务 ${t.id}: ${t.title}\n\n${t.output}`).join('\n\n---\n\n');
    this._addMessage(projectId, 'system', '🎉 **项目迭代审查全部完成！点击右上角可进行完整审查与修改。**');
    this._emit(projectId, 'project_complete', {
      result: project.result,
      completedAt: project.completedAt
    });
  }

  async _handleQuestion(projectId, task, question) {
    const project = this.projects.get(projectId);
    project.status = ProjectStatus.WAITING_ANSWER;
    this._emit(projectId, 'status_change', { status: ProjectStatus.WAITING_ANSWER });

    this._addMessage(projectId, 'executor',
      `❓ **执行脑遇到瓶颈，向策略脑寻求协助：**\n${question}`
    );
    this._addMessage(projectId, 'system', '⏳ 策略脑思考与研判中...');

    const answer = await this.planner.answerQuestion(
      projectId,
      question,
      task.description,
      project.plannerConfig,
      (type, token) => {
        if (type === 'thought') this._addThought(projectId, 'planner', token);
      },
      this.abortControllers.get(projectId)?.signal
    );
    const answerText = answer.answer || answer.content || JSON.stringify(answer);

    this._addMessage(projectId, 'planner',
      `💬 **策略脑指导方案：**\n${answerText}\n\n💡 建议：${answer.suggestion || '请继续执行'}`
    );

    project.status = ProjectStatus.EXECUTING;
    task._plannerAnswer = answerText;
  }

  async _callExecutor(projectId, task, plannerAnswer) {
    const project = this.projects.get(projectId);
    const taskData = {
      projectId,
      task,
      plan: project.plan,
      framework: project.framework || '',
      webSearch: project.executorConfig?.webSearch === true,
      selectedSkill: project.selectedSkill || 'bili_toy',
      plannerAnswer: plannerAnswer || task._plannerAnswer || null,
      executorConfig: project.executorConfig || resolveExecutorConfig(),
      workDir: project.workDir || '',
      existingFiles: await this._scanWorkDir(project.workDir),
      signal: this.abortControllers.get(projectId)?.signal
    };

    // 捕获执行脑工具的实时调用并在项目上记录（Dashboard 展示）
    const originalOnFileWritten = (action) => this._onFileWritten(projectId, action);

    const res = await executeTask(
      taskData,
      null,
      (token) => this._emit(projectId, 'token', { taskId: task.id, token }),
      originalOnFileWritten,
      // 执行脑工具调用记录回调
      (toolName, args) => this._recordToolCall(projectId, 'executor', toolName, args)
    );

    if (res.type === 'question') {
      return { type: 'question', question: res.question };
    }
    return { type: 'task_complete', output: res.output || res.summary || JSON.stringify(res) };
  }

  /**
   * 扫描工作目录中的现有文件（Agent 修改上下文）
   */
  async _scanWorkDir(workDir) {
    try {
      if (!workDir || !fs.existsSync(workDir)) return [];
      const results = [];
      const stack = [{ dir: workDir, rel: '' }];
      while (stack.length > 0 && results.length < 60) {
        const { dir, rel } = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          const relPath = rel ? rel + '/' + entry.name : entry.name;
          if (entry.isDirectory()) {
            if (!['node_modules', '.git', '.venv', 'dist', 'build'].includes(entry.name)) stack.push({ dir: abs, rel: relPath });
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(abs);
              const content = stat.size <= 80000 ? fs.readFileSync(abs, 'utf-8').slice(0, 50000) : '[文件过大，已省略内容]';
              results.push({ path: relPath, content });
            } catch {}
          }
          if (results.length >= 60) break;
        }
      }
      return results;
    } catch (e) { return []; }
  }

  /**
   * Agent 文件写入回调：记录到项目并广播到前端
   */
  _onFileWritten(projectId, action) {
    const project = this.projects.get(projectId);
    if (!project) return;
    if (!project.fileActions) project.fileActions = [];
    const record = { ...action, timestamp: new Date().toISOString() };
    project.fileActions.push(record);
    this._addMessage(projectId, 'system', '📄 **Agent 已写入/修改文件：** ' + String.fromCharCode(96) + action.path + String.fromCharCode(96) + ' (' + action.size + ' 字节)');
    this._emit(projectId, 'file_action', { action: record });
    this._saveProjectsToDisk();
  }

  /**
   * 记录双脑实时本地工具调用（供前端 Dashboard 展示）
   */
  _recordToolCall(projectId, brain, toolName, args, resultSummary) {
    const project = this.projects.get(projectId);
    if (!project) return;
    if (!project.toolCalls) project.toolCalls = [];
    const record = {
      brain,
      tool: toolName,
      args: args || {},
      summary: String(resultSummary || '').slice(0, 200),
      timestamp: new Date().toISOString()
    };
    project.toolCalls.push(record);
    this._emit(projectId, 'tool_call', { record });
    this._saveProjectsToDisk();
  }

  /**
   * 设置项目工作目录（Agent 目标文件夹）
   */
  setWorkDir(projectId, workDir) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不存在');
    project.workDir = (workDir || '').trim();
    // 同步更新策略脑本地工具安全边界
    const resolvedWorkspace = project.workDir && project.workDir.trim()
      ? path.resolve(project.workDir)
      : path.join(getWorkspaceBase(), projectId);
    this.planner.setProjectWorkspace(projectId, resolvedWorkspace);
    this._addMessage(projectId, 'system', '📂 **工作目录已设置：** ' + String.fromCharCode(96) + (project.workDir || '(未设置，使用内部 workspace)') + String.fromCharCode(96));
    this._saveProjectsToDisk();
    return project.workDir;
  }

  /**
   * 列出项目工作目录的文件（供前端文件面板展示）
   */
  async listWorkDirFiles(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return this._scanWorkDir(project.workDir);
  }

  /**
   * 实时更新双脑模型配置及迭代轮数
   */
  changeConfig(projectId, { plannerConfig, executorConfig, maxIterations }) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不存在');

    if (maxIterations && Number(maxIterations) > 0) {
      project.maxIterations = Number(maxIterations);
      this._addMessage(projectId, 'system', `⚙️ **最大迭代轮数修改为：** ${project.maxIterations} 轮`);
    }

    if (plannerConfig) {
      project.plannerConfig = { ...project.plannerConfig, ...plannerConfig };
      this._addMessage(projectId, 'system', `🔄 **策略脑模型更新为：** \`${project.plannerConfig.model}\` (模式: ${project.plannerConfig.provider})`);
    }
    if (executorConfig) {
      project.executorConfig = { ...project.executorConfig, ...executorConfig };
      this._addMessage(projectId, 'system', `🔄 **执行脑模型更新为：** \`${project.executorConfig.model}\` (模式: ${project.executorConfig.provider})`);
    }

    this._emit(projectId, 'config_change', {
      plannerConfig: project.plannerConfig,
      executorConfig: project.executorConfig,
      maxIterations: project.maxIterations,
      iteration: project.iteration
    });
  }

  /**
   * 用户实时介入（支持文本与文件上传）
   */
  async intervene(projectId, userInstruction, files = []) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不存在');

    let displayMsg = `👤 **用户实时介入指导：**\n${userInstruction || '(通过文件进行介入指导)'}`;
    if (files && files.length > 0) {
      const fileNames = files.map(f => `📎 \`${f.name}\``).join(' ');
      displayMsg += `\n\n**附带文件：** ${fileNames}`;
    }

    this._addMessage(projectId, 'user', displayMsg);
    this._addMessage(projectId, 'system', '🔄 系统正在将用户的实时要求与附件数据注入策略脑与执行脑...');

    const plannerResponse = await this.planner.handleUserIntervention(
      projectId,
      userInstruction,
      files,
      project.plannerConfig,
      (type, token) => {
        if (type === 'thought') this._addThought(projectId, 'planner', token);
      },
      this.abortControllers.get(projectId)?.signal
    );

    const replyText = plannerResponse.answer || plannerResponse.content || JSON.stringify(plannerResponse);
    this._addMessage(projectId, 'planner', `🔵 **策略脑收到介入指导及文件后响应：**\n${replyText}`);

    if (project.tasks && project.tasks[project.currentTaskIndex]) {
      const currentTask = project.tasks[project.currentTaskIndex];
      let injectedContent = `用户最新介入要求：${userInstruction}\n策略脑调整：${replyText}`;
      if (files && files.length > 0) {
        const fileNames = files.map(f => f.name).join(', ');
        injectedContent += `\n附带介入文件：${fileNames}`;
      }
      currentTask._plannerAnswer = injectedContent;
    }

    this._emit(projectId, 'intervention_processed', { userInstruction, files, reply: replyText });
  }

  _addMessage(projectId, role, content) {
    const project = this.projects.get(projectId);
    if (!project) return;
    const msg = { role, content, timestamp: new Date().toISOString() };
    project.messages.push(msg);
    this._emit(projectId, 'message', { message: msg });
  }

  _addThought(projectId, role, thoughtToken) {
    const project = this.projects.get(projectId);
    if (!project) return;
    this._emit(projectId, 'thought', { role, token: thoughtToken });
  }

  _processQueue() {
    if (this.queue.length > 0 && this.activeCount < this.maxParallel) {
      const nextProjectId = this.queue.shift();
      this._startProject(nextProjectId);
    }
  }

  deleteProject(projectId) {
    // 删除时也中止正在进行的生成
    const ctrl = this.abortControllers.get(projectId);
    if (ctrl) ctrl.abort();
    this.abortControllers.delete(projectId);
    this.planner.clearHistory(projectId);
    this.planner.clearWorkspace(projectId);
    this.projects.delete(projectId);
    this._saveProjectsToDisk();
  }
}
