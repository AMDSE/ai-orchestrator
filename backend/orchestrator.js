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
const userdataDir = path.join(__dirname, '..', 'userdata');
const projectsFilePath = path.join(userdataDir, 'projects.json');

export const ProjectStatus = {
  IDLE: 'idle',
  PLANNING: 'planning',       // 策略脑规划中
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
            if (['planning', 'executing', 'waiting_answer'].includes(p.status)) {
              p.status = ProjectStatus.STOPPED;
            }
            this.projects.set(p.id, p);
          }
        }
      }

      // 从 workspace 物理目录智能反补恢复缺失的项目记录
      const workspaceBase = path.join(__dirname, '..', 'workspace');
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

  async createProject(projectId, userInput, mode = 'standard', plannerConfig = null, executorConfig = null, maxIterations = 3, selectedSkill = 'bili_toy') {
    const project = {
      id: projectId,
      userInput,
      mode,
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
    };

    this.projects.set(projectId, project);
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
      project.progress = 10;

      this._addMessage(projectId, 'planner',
        `📋 **第 ${project.iteration} 轮策略规划完成**：${planResult.title || '项目'}\n` +
        `📝 ${planResult.summary || ''}\n\n` +
        `📌 **任务列表** (共${project.tasks.length}个)：\n` +
        project.tasks.map(t => `  ${t.id}. ${t.title}`).join('\n') +
        `\n\n【信号通知】策略脑已完成初版规划，发出【PLAN_READY】信号！系统将自动拉起【执行脑 (外接 API)】去完成落地代码构建。`
      );
      this._emit(projectId, 'plan_ready', { plan: planResult, iteration: project.iteration });

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
      selectedSkill: project.selectedSkill || 'bili_toy',
      plannerAnswer: plannerAnswer || task._plannerAnswer || null,
      executorConfig: project.executorConfig || resolveExecutorConfig(),
      signal: this.abortControllers.get(projectId)?.signal
    };

    const res = await executeTask(
      taskData,
      null,
      (token) => this._emit(projectId, 'token', { taskId: task.id, token })
    );

    if (res.type === 'question') {
      return { type: 'question', question: res.question };
    }
    return { type: 'task_complete', output: res.output || res.summary || JSON.stringify(res) };
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
    this.projects.delete(projectId);
    this._saveProjectsToDisk();
  }
}
