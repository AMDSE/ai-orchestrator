// backend/server.js
// Express + WebSocket 服务器

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { Orchestrator } from './orchestrator.js';
import { skillRegistry } from './skill-registry.js';
import { scrapeSourceUrls, alchemizeSkill } from './skill-alchemist.js';
import { getAvailableLocalTools } from './tools/local-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const orchestrator = new Orchestrator();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// 显式根路由：强制 text/html，防止浏览器缓存问题
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── WebSocket 管理 ──────────────────────────────────────────────────────────
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  // 发送当前所有项目状态 + 技能列表
  const projects = orchestrator.getProjects();
  ws.send(JSON.stringify({ type: 'init', projects, skills: skillRegistry.getAllForClient() }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// 编排器事件 → WebSocket 广播
orchestrator.on('update', (update) => {
  broadcast({ type: 'orchestrator_update', ...update });
});

// SkillRegistry 技能更新 → WebSocket 广播（热加载新技能）
skillRegistry._emitter = { emit: (event, data) => {
  if (event === 'skills_updated') {
    broadcast({ type: 'skills_updated', skills: data.skills });
  }
}};

// ── REST API ─────────────────────────────────────────────────────────────────

// 创建新项目
app.post('/api/projects', async (req, res) => {
  const { userInput, mode = 'standard', agentMode = 'act', plannerConfig = null, executorConfig = null, maxIterations = 3, selectedSkill = 'bili_toy', workDir = '' } = req.body;
  if (!userInput?.trim()) {
    return res.status(400).json({ error: '请输入项目想法' });
  }
  const projectId = uuidv4();
  res.json({ projectId, status: 'created' });
  orchestrator.createProject(projectId, userInput.trim(), mode, agentMode, plannerConfig, executorConfig, maxIterations, selectedSkill, workDir).catch(console.error);
});

// 获取所有项目
app.get('/api/projects', (req, res) => {
  res.json(orchestrator.getProjects());
});

// 获取单个项目
app.get('/api/projects/:id', (req, res) => {
  const project = orchestrator.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// 用户实时介入
app.post('/api/projects/:id/intervene', async (req, res) => {
  const { userInstruction = '', files = [] } = req.body;
  if (!userInstruction?.trim() && (!files || files.length === 0)) {
    return res.status(400).json({ error: '请输入介入指导要求或选择上传文件' });
  }
  try {
    await orchestrator.intervene(req.params.id, userInstruction.trim(), files);
    const updatedProject = orchestrator.getProject(req.params.id);
    res.json({ success: true, message: '实时介入指令与附件已发送', project: updatedProject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 动态更新模型配置
app.post('/api/projects/:id/config', (req, res) => {
  const { plannerConfig, executorConfig, maxIterations } = req.body;
  try {
    orchestrator.changeConfig(req.params.id, { plannerConfig, executorConfig, maxIterations });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除项目
app.delete('/api/projects/:id', (req, res) => {
  orchestrator.deleteProject(req.params.id);
  res.json({ success: true });
});

// 中止项目
app.post('/api/projects/:id/stop', (req, res) => {
  try {
    orchestrator.stopProject(req.params.id);
    res.json({ success: true, message: '项目生成已中止' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 用户恢复/重试生成
app.post('/api/projects/:id/retry', async (req, res) => {
  try {
    await orchestrator.resumeProject(req.params.id);
    res.json({ success: true, message: '已恢复项目执行' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Plan/Act 模式：批准策略脑规划（Plan 模式下的用户确认点） ─────────────
app.post('/api/projects/:id/approve', async (req, res) => {
  try {
    await orchestrator.approveProject(req.params.id);
    res.json({ success: true, message: '规划已批准，开始执行' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Plan/Act 模式：切换项目 Agent 模式（仅未运行/未运行的待建项目） ─────
app.post('/api/projects/:id/agentmode', (req, res) => {
  try {
    const { agentMode } = req.body;
    if (!['plan', 'act'].includes(agentMode)) {
      return res.status(400).json({ error: 'agentMode 必须是 plan 或 act' });
    }
    const result = orchestrator.changeAgentMode(req.params.id, agentMode);
    res.json({ success: true, agentMode: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent 工作目录 API ─────────────────────────────────────────────────────

// 设置项目工作目录（Agent 目标文件夹）
app.post('/api/projects/:id/workdir', async (req, res) => {
  try {
    const { workDir = '' } = req.body;
    const result = orchestrator.setWorkDir(req.params.id, workDir);
    res.json({ success: true, workDir: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 列出项目工作目录文件（Agent 文件面板）
app.get('/api/projects/:id/files', async (req, res) => {
  try {
    const files = await orchestrator.listWorkDirFiles(req.params.id);
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 技能管理 API ────────────────────────────────────────────────────────────

// 获取所有技能
app.get('/api/skills', (req, res) => {
  res.json(skillRegistry.getAllForClient());
});

// 删除用户炼化的技能（内置技能不可删除）
app.delete('/api/skills/:id', (req, res) => {
  try {
    skillRegistry.deleteSkill(req.params.id);
    broadcast({ type: 'skills_updated', skills: skillRegistry.getAllForClient() });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 技能炼化 API ────────────────────────────────────────────────────────────

// 单纯爬取信源（预览用，不炼化）
app.post('/api/skill-alchemy/scrape', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: '请提供至少一个信源 URL' });
  }
  try {
    const results = await scrapeSourceUrls(urls);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 炼化技能（流式 SSE 推进度）
app.post('/api/skill-alchemy/run', async (req, res) => {
  const { urls, customPrompt, plannerConfig } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: '请提供至少一个信源 URL' });
  }

  // 使用 SSE 流式推送进度
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    let resultSkill = null;

    resultSkill = await alchemizeSkill({
      urls,
      customPrompt,
      plannerConfig,
      onProgress: (stage, content) => {
        if (stage === 'token') {
          send('token', { token: content });
        } else {
          send('progress', { stage, message: content });
        }
      }
    });

    // 炼化完成，广播技能列表更新
    broadcast({ type: 'skills_updated', skills: skillRegistry.getAllForClient() });

    send('complete', { skill: resultSkill });
    res.end();
  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    strategyModel: process.env.STRATEGY_MODEL || '未配置',
    executorModel: process.env.EXECUTOR_MODEL || '未配置',
    activeProjects: orchestrator.activeCount,
    totalProjects: orchestrator.projects.size,
    skills: skillRegistry.skills.size,
    localTools: getAvailableLocalTools().length
  });
});

// ── 本地资源工具能力 API（Dashboard 展示双脑可调用的本地能力） ──────────────

// 获取策略脑/执行脑可用的本地资源工具列表
app.get('/api/tools', (req, res) => {
  res.json({ success: true, tools: getAvailableLocalTools() });
});

// 获取项目内双脑实时工具调用历史
app.get('/api/projects/:id/toolcalls', (req, res) => {
  const project = orchestrator.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ success: true, toolCalls: project.toolCalls || [] });
});

// ── 启动服务器 ────────────────────────────────────────────────────────────────
export async function startServer(port = process.env.PORT || 3000) {
  await skillRegistry.init();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      console.log(`
╔════════════════════════════════════════════╗
║     🤖 AI 双脑编排系统 已启动               ║
║     策略脑: 高性能模型 (外接 API)           ║
║     执行脑: 较低性能模型 (外接 API)         ║
║     技能库: ${skillRegistry.skills.size} 个技能已加载             ║
║     地址: http://localhost:${port}           ║
╚════════════════════════════════════════════╝
      `);
      resolve({ server, app, port, orchestrator });
    });
  });
}

// 直接以 node backend/server.js 运行时自动启动（Electron 桌面版通过 startServer 启动）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer().catch((err) => {
    console.error('服务器启动失败:', err);
    process.exit(1);
  });
}
