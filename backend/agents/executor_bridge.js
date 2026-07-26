// backend/agents/executor_bridge.js
// 执行脑桥接器 v5：支持真实拉起 Antigravity Agent/CLI、Python SDK 和 外接自定义 API (OpenAI 兼容)

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getPythonExecutable() {
  const customPath = `C:\\Users\\MRT~1\\AppData\\Local\\Programs\\Python\\Python314\\python.exe`;
  try {
    if (fs.existsSync(customPath)) return customPath;
    execSync('python --version', { stdio: 'ignore' });
    return 'python';
  } catch {
    return null;
  }
}

function isPythonSdkAvailable() {
  const py = getPythonExecutable();
  if (!py) return false;
  try {
    execSync(`"${py}" -c "import google.antigravity"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getAntigravityCliPath() {
  const shortPath = `C:\\Users\\MRT~1\\AppData\\Local\\Programs\\Antigravity IDE\\bin\\antigravity-ide.cmd`;
  const customPath = `C:\\Users\\MR T\\AppData\\Local\\Programs\\Antigravity IDE\\bin\\antigravity-ide.cmd`;
  try {
    if (fs.existsSync(shortPath)) return shortPath;
    if (fs.existsSync(customPath)) return customPath;
  } catch {}
  return 'antigravity-ide';
}

function isAntigravityCliAvailable() {
  const cli = getAntigravityCliPath();
  try {
    if (fs.existsSync(cli)) return true;
    execSync(`cmd /c "${cli}" --version`, { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function executeViaPythonSdk(taskData, onToken) {
  return new Promise((resolve, reject) => {
    const py = getPythonExecutable();
    const pyScript = path.join(__dirname, 'executor_bridge.py');

    const proc = spawn(py, [pyScript], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdin.write(JSON.stringify(taskData));
    proc.stdin.end();

    let buffer = '';
    let lastResult = null;

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'token') {
            if (onToken) onToken(msg.token);
          } else {
            lastResult = msg;
          }
        } catch (e) {
          // ignore
        }
      }
    });

    proc.stderr.on('data', (data) => {
      console.error('[Python SDK Executor]', data.toString());
    });

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try { lastResult = JSON.parse(buffer.trim()); } catch (e) {}
      }
      if (lastResult) {
        resolve(lastResult);
      } else if (code === 0) {
        resolve({ type: 'task_complete', output: '任务在本地 Antigravity Agent 中执行完成' });
      } else {
        reject(new Error(`Python Executor 退出, code=${code}`));
      }
    });

    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('Python Executor 超时')); }, 600000);
  });
}

// 跟踪已为哪些项目拉起过独占 IDE 窗口，防止后续任务/迭代反复弹窗
const launchedProjectWindows = new Set();

/**
 * 遵守 Google Antigravity CLI 官方规范：使用临时 UTF-8 文件无损传输多行 Prompt，全异步非阻塞开辟独占窗口与 Agent 会话
 */
function executeViaAntigravityCli(prompt, workspaceDir, projectId, onToken = null) {
  return new Promise((resolve, reject) => {
    const cli = getAntigravityCliPath();
    const isFirstLaunch = !launchedProjectWindows.has(projectId);

    // 1. 将完整的任务 Prompt 写入工作区临时文件，彻底避免 PowerShell 命令行转义截断与语法报错
    const promptFilePath = path.join(workspaceDir, `.temp_prompt_${Date.now()}.txt`);
    try {
      fs.writeFileSync(promptFilePath, prompt, 'utf-8');
    } catch (e) {
      console.warn(`[Prompt File Write Warning]`, e.message);
    }

    const cleanupTempFile = () => {
      try { if (fs.existsSync(promptFilePath)) fs.unlinkSync(promptFilePath); } catch (e) {}
    };

    const sendChatPrompt = () => {
      // 2. PowerShell 使用 Get-Content -Raw -Encoding UTF8 无损读取 Prompt 文件
      const psChatCmd = `$p = Get-Content -Path '${promptFilePath.replace(/'/g, "''")}' -Raw -Encoding UTF8; & '${cli}' chat -r -m agent $p`;
      const chatProc = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', psChatCmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      chatProc.stdout.on('data', (d) => {
        const token = d.toString();
        output += token;
        if (onToken) onToken(token);
      });

      chatProc.stderr.on('data', (d) => {
        console.error('[Antigravity Agent]', d.toString());
      });

      chatProc.on('close', (code) => {
        cleanupTempFile();
        resolve({
          type: 'task_complete',
          output: output.trim()
        });
      });

      chatProc.on('error', (err) => {
        cleanupTempFile();
        reject(err);
      });

      setTimeout(() => {
        chatProc.kill();
        cleanupTempFile();
        resolve({ type: 'task_complete', output: output.trim() });
      }, 15000);
    };

    if (isFirstLaunch) {
      launchedProjectWindows.add(projectId);
      console.log(`🚀 首次为项目 [${projectId}] 唤醒独占 IDE 窗口 (工作区: ${workspaceDir}): ${cli}`);

      // 阶段一：首次唤醒项目独占视窗 (--disable-workspace-trust -n workspaceDir)
      const psOpenCmd = `& '${cli}' --disable-workspace-trust -n '${workspaceDir}'`;
      const openProc = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', psOpenCmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      openProc.on('close', sendChatPrompt);
      openProc.on('error', (err) => {
        console.warn(`[IDE Window Spawn Warning]`, err.message);
        sendChatPrompt();
      });
    } else {
      console.log(`⚡ 项目 [${projectId}] 视窗已存在，直接通过文本中转文件无损投递后续任务 Prompt`);
      sendChatPrompt();
    }
  });
}

/**
 * 使用外接自定义 API (OpenAI 格式) 执行脑
 */
async function executeViaCustomApi(taskData, executorConfig, onToken = null) {
  const customClient = new OpenAI({
    apiKey: executorConfig.apiKey,
    baseURL: executorConfig.baseUrl || 'https://api.openai.com/v1',
  });

  const prompt = buildExecutorPrompt(taskData.plan, taskData.task, taskData.plannerAnswer, taskData.selectedSkill || 'bili_toy');
  const modelName = executorConfig.model || 'gpt-4o';

  console.log(`🌐 使用外接自定义 API 执行脑 (BaseURL: ${executorConfig.baseUrl}, Model: ${modelName})`);

  const webSearch = executorConfig.webSearch !== false;
  const searchPrompt = webSearch
    ? '你的联网检索功能已开启！遇到最新库版本、API变动或在线资料时请积极联网检索。'
    : '你的联网检索功能已关闭。请基于内置知识模型解答，不使用外部网络检索。';

  const stream = await customClient.chat.completions.create({
    model: modelName,
    messages: [
      {
        role: 'system',
        content: `你是一个高效的AI项目执行者（执行脑）。${searchPrompt}按照策略脑规划完成任务。若遇到歧义，可用 [QUESTION_TO_PLANNER]提问[/QUESTION_TO_PLANNER]`
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6,
    stream: true,
  });

  const chunks = [];
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    if (token) {
      chunks.push(token);
      if (onToken) onToken(token);
    }
  }
  const rawOutput = chunks.join('');

  if (rawOutput.includes('[QUESTION_TO_PLANNER]')) {
    const match = rawOutput.match(/\[QUESTION_TO_PLANNER\]([\s\S]*?)\[\/QUESTION_TO_PLANNER\]/);
    return { type: 'question', question: match ? match[1].trim() : rawOutput };
  }

  return { type: 'task_complete', output: rawOutput };
}

/**
 * 主执行入口 (具备工作区文件真实写入与双轨防假完成保护)
 */
export async function executeTask(taskData, defaultOpenaiClient, onToken = null) {
  const executorConfig = taskData.executorConfig || {};
  const provider = executorConfig.provider || 'antigravity';
  const projectId = taskData.projectId || 'default';

  // 1. 创建该项目的专属工作区目录
  const workspaceDir = path.join(__dirname, '..', '..', 'workspace', projectId);
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch (e) {}

  // 2. 若配置为外接自定义 API
  if (provider === 'custom_api' && executorConfig.apiKey) {
    const result = await executeViaCustomApi(taskData, executorConfig, onToken);
    if (result.type === 'task_complete' && result.output) {
      _saveToWorkspace(workspaceDir, result.output);
    }
    return result;
  }

  // 3. 若配置为 Antigravity 本地 Agent 模式
  const model = executorConfig.model || taskData.model || 'gemini-3.6-flash';
  taskData.model = model;

  const hasCli = isAntigravityCliAvailable();
  const hasSdk = isPythonSdkAvailable();

  console.log(`[Executor Engine] 模式: Antigravity | 模型: ${model} | Workspace: ${workspaceDir} | CLI=${hasCli}, SDK=${hasSdk}`);

  const prompt = buildExecutorPrompt(taskData.plan, taskData.task, taskData.plannerAnswer, taskData.selectedSkill || 'bili_toy');

  if (hasCli) {
    console.log(`⚡ 唤醒项目 [${projectId}] 独占的 Antigravity IDE 窗口并切入工作区: ${workspaceDir}`);
    try {
      // 唤醒 Antigravity 界面并将工作区与 Session 绑定当前独占项目目录
      executeViaAntigravityCli(prompt, workspaceDir, projectId, null).catch(err => console.warn('[CLI Call Warning]', err.message));
    } catch (e) {
      console.warn(`[Antigravity CLI 唤醒提示]: ${e.message}`);
    }
  }

  // 4. 无论是否唤醒 GUI，必须通过模型生成全量实体 HTML5 代码并写入工作区（彻底杜绝“假完成”）
  console.log(`💻 后台并发构建全量实体 HTML5 项目文件...`);
  const stream = await defaultOpenaiClient.chat.completions.create({
    model: process.env.LONGCAT_MODEL || 'LongCat-2.0',
    messages: [
      {
        role: 'system',
        content: `你是一个顶级全栈 Web 开发工程师与项目执行脑。你的联网检索功能已开启！

【绝对禁止事项 - 违反则视为任务失败】
❌ 禁止：在任何游戏或应用中加入登录门禁、身份验证、账号绑定等阻断用户进入主功能的流程。游戏启动必须直接可玩，无需登录。
❌ 禁止：使用 dummyimage.com、placeholder.com、placehold.it 或任何测试性占位图片服务。
❌ 禁止：在代码中引用本地不存在的图片路径（如 dog.png、cat.png），必须用内嵌 SVG 或 DiceBear API 替代。
❌ 禁止：输出纯文字描述或注释性内容，必须直接输出完整立即可运行的单文件 HTML5 代码（包含 <!DOCTYPE html>、<head>、<style>、<body> 与 <script>）。
❌ 禁止：在页面中保留任何调试文本、测试按钮、占位符内容。

【强制质量标准】
✅ 若制作 Galgame/视觉小说：必须包含≥50条对话节点、≥3个分支路线、≥2个不同结局，角色立绘用内嵌 SVG 绘制。
✅ 所有 Web 页面必须 mobile-first 双端适配（viewport meta + @media 媒体查询）。
若遇到歧义，可用 [QUESTION_TO_PLANNER]提问[/QUESTION_TO_PLANNER]`
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6,
    stream: true,
  });

  const chunks = [];
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    if (token) {
      chunks.push(token);
      if (onToken) onToken(token);
    }
  }
  const rawOutput = chunks.join('');

  if (rawOutput.includes('[QUESTION_TO_PLANNER]')) {
    const match = rawOutput.match(/\[QUESTION_TO_PLANNER\]([\s\S]*?)\[\/QUESTION_TO_PLANNER\]/);
    return { type: 'question', question: match ? match[1].trim() : rawOutput };
  }

  // 自动将生成的 HTML 代码保存至工作区 index.html
  _saveToWorkspace(workspaceDir, rawOutput);

  return { type: 'task_complete', output: rawOutput };
}

function _saveToWorkspace(workspaceDir, codeText) {
  try {
    const htmlMatch = codeText.match(/(<!DOCTYPE html>[\s\S]*<\/html>)/i);
    const codeBlockMatch = codeText.match(/```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);

    let content = codeText;
    let fileName = 'index.html';

    if (htmlMatch) {
      content = htmlMatch[1].trim();
      fileName = 'index.html';
    } else if (codeBlockMatch) {
      const lang = (codeBlockMatch[1] || '').toLowerCase();
      content = codeBlockMatch[2].trim();

      if (['html', 'htm'].includes(lang)) fileName = 'index.html';
      else if (['json'].includes(lang)) fileName = 'data.json';
      else if (['py', 'python'].includes(lang)) fileName = 'main.py';
      else if (['svg'].includes(lang)) fileName = 'image.svg';
      else if (['csv'].includes(lang)) fileName = 'data.csv';
      else if (['xml'].includes(lang)) fileName = 'config.xml';
      else if (['js', 'javascript'].includes(lang)) fileName = 'script.js';
      else if (['css'].includes(lang)) fileName = 'style.css';
      else if (['sql'].includes(lang)) fileName = 'query.sql';
      else if (lang) fileName = `output.${lang}`;
    }

    const filePath = path.join(workspaceDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`📁 真实构建产物已保存至工作区: ${filePath}`);
  } catch (e) {
    console.error('保存工作区文件失败:', e.message);
  }
}

export function buildExecutorPrompt(plan, task, plannerAnswer = null, selectedSkill = 'bili_toy') {
  const toySkillPrompt = selectedSkill === 'bili_toy' ? `
【🎮 bilibili Toy 平台交互规范技能（已启用）】
1. 所有图片/样式/静态资源必须采用相对路径引用（如 ./assets/chara.png 或 assets/chara.png），严禁使用绝对路径（如 /assets/）。
2. 保底防白屏机制：页面内必须包含内嵌 SVG 或 Data URL 备用资源，确保离开在线 CDN 也能流畅运行。
3. 代码结构符合 B端 Toy 打包与发布规范，必须可在最外层通过 index.html 打开。` : '';

  const dynamicInstruction = `${toySkillPrompt}

【绝对禁止 - 违反则任务失败】
❌ 禁止加入任何登录门禁、账号绑定、身份验证阻断流程，游戏/应用必须直接可用。
❌ 禁止引用 dummyimage.com / placeholder.com 等测试占位图服务；禁止引用本地不存在的图片路径（如 dog.png）。
   角色立绘强制使用内嵌 SVG 矢量绘图，或通过 https://api.dicebear.com/7.x/anime/svg?seed=角色名 加载。
❌ 禁止在页面中保留调试文字、测试性按钮、临时占位符内容。

【强制交付质量标准】
✅ 若任务涉及 Galgame / 视觉小说 / 互动故事：
   - 必须包含 ≥ 50 条对话节点（storyData 数组条目 ≥ 50）
   - 必须包含 ≥ 3 条不同分支路线（choices 分支节点）
   - 必须包含 ≥ 2 个不同结局场景（ending_a / ending_b 等）
   - 角色立绘必须用内嵌 SVG 绘制，禁止使用外部图片 URL
✅ 100% 完整输出实体代码，必须包裹在规范 Markdown 代码块中
✅ 强制 Web 双端自适应：必须包含 <meta name="viewport" content="width=device-width, initial-scale=1.0">，并使用 CSS @media (max-width: 768px) 媒体查询实现移动端与桌面端双端适配`;

  if (plannerAnswer) {
    return `策略脑回答了你的问题：\n\n${plannerAnswer}\n\n请继续执行任务 ${task.id}：${task.title}${dynamicInstruction}`;
  }
  return `项目：${plan?.title || '项目'}\n任务 ${task.id}：${task.title}\n描述：${task.description}\n预期输出：${task.expected_output || '完整实体代码/文件'}${dynamicInstruction}`;
}
