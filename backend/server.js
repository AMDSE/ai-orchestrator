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
  const { userInput, mode = 'standard', plannerConfig = null, executorConfig = null, maxIterations = 3, selectedSkill = 'bili_toy' } = req.body;
  if (!userInput?.trim()) {
    return res.status(400).json({ error: '请输入项目想法' });
  }
  const projectId = uuidv4();
  res.json({ projectId, status: 'created' });
  orchestrator.createProject(projectId, userInput.trim(), mode, plannerConfig, executorConfig, maxIterations, selectedSkill).catch(console.error);
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
    model: process.env.LONGCAT_MODEL,
    activeProjects: orchestrator.activeCount,
    totalProjects: orchestrator.projects.size,
    skills: skillRegistry.skills.size
  });
});

// ── 启动服务器 ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// 先初始化 SkillRegistry，再启动监听
skillRegistry.init().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║     🤖 AI 多智能体编排系统 已启动           ║
║     策略脑: LongCat-2.0                    ║
║     执行脑: Antigravity (本地)              ║
║     技能库: ${skillRegistry.skills.size} 个技能已加载             ║
║     地址: http://localhost:${PORT}           ║
╚════════════════════════════════════════════╝
    `);
  });
}).catch(console.error);
