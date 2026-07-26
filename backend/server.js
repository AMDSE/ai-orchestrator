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

  // 发送当前所有项目状态
  const projects = orchestrator.getProjects();
  ws.send(JSON.stringify({ type: 'init', projects }));

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

// ── REST API ─────────────────────────────────────────────────────────────────

// 创建新项目（支持全局与个性化模型/外接API设置、迭代轮数以及项目技能选择）
app.post('/api/projects', async (req, res) => {
  const { userInput, mode = 'standard', plannerConfig = null, executorConfig = null, maxIterations = 3, selectedSkill = 'bili_toy' } = req.body;
  if (!userInput?.trim()) {
    return res.status(400).json({ error: '请输入项目想法' });
  }

  const projectId = uuidv4();
  res.json({ projectId, status: 'created' });

  // 异步启动，不阻塞响应
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

// 用户实时介入接口（支持文本与文件上传）
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

// 动态更新项目双脑模型配置与迭代轮数接口
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

// 中止项目（停止当前模型生成）
app.post('/api/projects/:id/stop', (req, res) => {
  try {
    orchestrator.stopProject(req.params.id);
    res.json({ success: true, message: '项目生成已中止' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: process.env.LONGCAT_MODEL,
    activeProjects: orchestrator.activeCount,
    totalProjects: orchestrator.projects.size
  });
});

// ── 启动服务器 ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║     🤖 AI 多智能体编排系统 已启动           ║
║     策略脑: LongCat-2.0                    ║
║     执行脑: Antigravity (本地)              ║
║     地址: http://localhost:${PORT}           ║
╚════════════════════════════════════════════╝
  `);
});
