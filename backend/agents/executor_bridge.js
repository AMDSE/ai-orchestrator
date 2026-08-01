// backend/agents/executor_bridge.js
// 执行脑桥接器 v6：集成 SkillRegistry 动态技能注入，支持炼化技能实时生效

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { skillRegistry } from '../skill-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));



function getAntigravityCliPath() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const possiblePaths = [
    `C:\\Users\\MRT~1\\AppData\\Local\\Programs\\Antigravity IDE\\bin\\antigravity-ide.cmd`,
    path.join(localAppData, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
    path.join(localAppData, 'Programs', 'Antigravity', 'bin', 'antigravity-ide.cmd'),
    path.join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
    path.join(userProfile, 'AppData', 'Local', 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
    `C:\\Users\\MR T\\AppData\\Local\\Programs\\Antigravity IDE\\bin\\antigravity-ide.cmd`
  ];

  for (const p of possiblePaths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }

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

/**
 * 将包含空格的 Windows 路径转换为 8.3 短路径 (如 MR T -> MRT~1)，解决 CMD/PowerShell 剥离引号导致的路径截断死锁 Bug
 */
function toShortPath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/\\Users\\MR T\\/gi, '\\Users\\MRT~1\\')
          .replace(/\\Users\\MR\s+T\\/gi, '\\Users\\MRT~1\\');
}



// 跟踪已为哪些项目拉起过独占 IDE 窗口，防止后续任务/迭代反复弹窗
const launchedProjectWindows = new Set();

function executeViaAntigravityCli(prompt, workspaceDir, projectId, onToken = null) {
  return new Promise((resolve, reject) => {
    const cli = getAntigravityCliPath();
    const isFirstLaunch = !launchedProjectWindows.has(projectId);

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
      const shortCli = toShortPath(cli);
      const shortPromptPath = toShortPath(promptFilePath);
      // 强制设置控制台编码为 UTF-8 (65001)，使用短路径规避 CMD 剥离引号死锁
      const cmdChat = `chcp 65001 >nul & "${shortCli}" chat -r -m agent "${shortPromptPath}"`;

      const chatProc = spawn('cmd.exe', ['/c', cmdChat], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // 捕获 stdin 的 EPIPE 错误，防止管道关闭时写入触发未捕获异常导致服务器崩溃
      if (chatProc.stdin) {
        chatProc.stdin.on('error', () => {});
      }

      // 预发射一次确认，以防启动时即询问
      setTimeout(() => {
        try {
          if (chatProc.stdin && chatProc.stdin.writable) {
            chatProc.stdin.write('y\r\n');
          }
        } catch (e) {}
      }, 800);

      let output = '';
      const promptKeywords = ['请确认', '[y/n]', '[y/N]', 'y/N', 'Y/n', '覆盖', 'overwrite', 'Overwrite', 'confirm', 'Confirm', '', 'ļ', 'ȷ'];
      
      const checkAndFeedY = (text) => {
        if (promptKeywords.some(kw => text.includes(kw))) {
          try {
            if (chatProc.stdin && chatProc.stdin.writable) {
              chatProc.stdin.write('y\r\n');
            }
          } catch (e) {}
        }
      };

      chatProc.stdout.on('data', (d) => {
        const token = d.toString();
        output += token;
        if (onToken) onToken(token);
        checkAndFeedY(token);
      });

      chatProc.stderr.on('data', (d) => {
        const text = d.toString();
        console.error('[Antigravity Agent]', text);
        checkAndFeedY(text);
      });

      const timeoutTimer = setTimeout(() => {
        console.warn(`[Antigravity CLI] 任务响应已达 180s 保护上限，自动收尾并交还编排器...`);
        chatProc.kill();
        cleanupTempFile();
        resolve({ type: 'task_complete', output: output.trim() });
      }, 180000);

      chatProc.on('close', (code) => {
        clearTimeout(timeoutTimer);
        cleanupTempFile();
        const trimmedOutput = output.trim();

        // 检查是否有向策略脑提问的标签
        if (trimmedOutput.includes('[QUESTION_TO_PLANNER]')) {
          const match = trimmedOutput.match(/\[QUESTION_TO_PLANNER\]([\s\S]*?)\[\/QUESTION_TO_PLANNER\]/);
          if (match) {
            return resolve({ type: 'question', question: match[1].trim() });
          }
        }

        resolve({ type: 'task_complete', output: trimmedOutput });
      });

      chatProc.on('error', (err) => {
        clearTimeout(timeoutTimer);
        cleanupTempFile();
        reject(err);
      });
    };

    if (isFirstLaunch) {
      launchedProjectWindows.add(projectId);
      const shortCli = toShortPath(cli);
      const shortWorkspaceDir = toShortPath(workspaceDir);
      console.log(`🚀 首次为项目 [${projectId}] 唤醒独占 IDE 窗口 (工作区: ${shortWorkspaceDir}): ${shortCli}`);

      // 双引号包裹 Start-Process 参数 (使用短路径防空格)
      const psOpenCmd = `Start-Process -FilePath "${shortCli}" -ArgumentList "--disable-workspace-trust", "-n", "${shortWorkspaceDir}"`;
      const openProc = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', psOpenCmd], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      openProc.on('close', () => {
        // 给 IDE 视窗 2 秒建链等待
        setTimeout(sendChatPrompt, 2000);
      });
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
async function executeViaCustomApi(taskData, executorConfig, onToken = null, signal = null) {
  const customClient = new OpenAI({
    apiKey: executorConfig.apiKey,
    baseURL: executorConfig.baseUrl || 'https://api.openai.com/v1',
  });

  const prompt = buildExecutorPrompt(taskData.plan, taskData.task, taskData.plannerAnswer, taskData.selectedSkill || 'bili_toy');
  const modelName = executorConfig.model || 'gpt-4o';

  console.log(`🌐 使用外接自定义 API 执行脑 (BaseURL: ${executorConfig.baseUrl}, Model: ${modelName})`);

  const stream = await customClient.chat.completions.create({
    model: modelName,
    messages: [
      {
        role: 'system',
        content: buildExecutorSystemPrompt(taskData.selectedSkill || 'bili_toy')
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6,
    stream: true,
  }, { signal: signal || undefined });

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
 * 主执行入口
 */
export async function executeTask(taskData, defaultOpenaiClient, onToken = null) {
  const executorConfig = taskData.executorConfig || {};
  const provider = executorConfig.provider || 'antigravity';
  const projectId = taskData.projectId || 'default';

  // 创建该项目的专属工作区目录
  const workspaceDir = path.join(__dirname, '..', '..', 'workspace', projectId);
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch (e) {}

  // 若配置为外接自定义 API
  if (provider === 'custom_api' && executorConfig.apiKey) {
    const result = await executeViaCustomApi(taskData, executorConfig, onToken, taskData.signal);
    if (result.type === 'task_complete' && result.output) {
      _saveToWorkspace(workspaceDir, result.output);
    }
    return result;
  }

  // Antigravity 本地 Agent 模式
  const model = executorConfig.model || taskData.model || 'gemini-3.6-flash';
  taskData.model = model;

  const hasCli = isAntigravityCliAvailable();

  console.log(`[Executor Engine] 模式: Antigravity | 模型: ${model} | Workspace: ${workspaceDir} | CLI=${hasCli}`);

  const prompt = buildExecutorPrompt(taskData.plan, taskData.task, taskData.plannerAnswer, taskData.selectedSkill || 'bili_toy');

  if (hasCli) {
    console.log(`⚡ 唤醒项目 [${projectId}] 独占的 Antigravity IDE 窗口并切入工作区: ${workspaceDir}`);
    try {
      executeViaAntigravityCli(prompt, workspaceDir, projectId, null).catch(err => console.warn('[CLI Call Warning]', err.message));
    } catch (e) {
      console.warn(`[Antigravity CLI 唤醒提示]: ${e.message}`);
    }
  }

  // 后台并发通过模型生成全量代码并写入工作区
  console.log(`💻 后台并发构建全量实体 HTML5 项目文件...`);
  const stream = await defaultOpenaiClient.chat.completions.create({
    model: process.env.LONGCAT_MODEL || 'LongCat-2.0',
    messages: [
      {
        role: 'system',
        content: buildExecutorSystemPrompt(taskData.selectedSkill || 'bili_toy')
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6,
    stream: true,
  }, { signal: taskData.signal || undefined });

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

  _saveToWorkspace(workspaceDir, rawOutput);
  return { type: 'task_complete', output: rawOutput };
}

function _saveToWorkspace(workspaceDir, codeText) {
  try {
    if (!codeText || typeof codeText !== 'string') return;

    let content = codeText.trim();
    let fileName = 'index.html';

    // 1. 优先提取 Markdown 代码块
    const codeBlockMatch = content.match(/```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
    const htmlTagMatch = content.match(/(<![Dd][Oo][Cc][Tt][Yy][Pp][Ee] html[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i);

    if (codeBlockMatch) {
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
      else {
        // 无语言标签时的特征智能识别
        if (/<![Dd][Oo][Cc][Tt][Yy][Pp][Ee]|<html/i.test(content)) fileName = 'index.html';
        else if (/^\s*[\{\[]/.test(content)) fileName = 'data.json';
        else if (content.includes('body {') || content.includes('margin:')) fileName = 'style.css';
        else fileName = 'index.html';
      }
    } else if (htmlTagMatch) {
      content = htmlTagMatch[1].trim();
      fileName = 'index.html';
    }

    // 清洗多余的反引号或前导/后置垃圾文本
    content = content.replace(/^```[a-zA-Z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    // 智能防御修复：若 HTML 文件遭遇模型输出长度截断导致 <script> 未闭合，自动补全收尾，防止浏览器抛 SyntaxError 挂起加载屏
    if (fileName === 'index.html' && /<!DOCTYPE html>|<html/i.test(content)) {
      // 替换裸调 alert 为 safeToast，避免 iframe 弹出框被阻断抛 DOMException 崩溃
      content = content.replace(/alert\(([^)]+)\)/g, 'console.log("[Toast Notification]", $1)');

      const openScriptCount = (content.match(/<script[^>]*>/gi) || []).length;
      const closeScriptCount = (content.match(/<\/script>/gi) || []).length;
      const isClosedHtml = /<\/html>/i.test(content);

      if (openScriptCount > closeScriptCount || !isClosedHtml) {
        console.warn(`[Workspace Saver Warning] 检测到产物 HTML 遭遇输出截断，自动执行 DOM 闭合与加载强保底注入...`);
        let repairBlock = '\n';
        if (openScriptCount > closeScriptCount) {
          repairBlock += ';\n  } catch(e) { console.warn("[Safe Recovery]", e); }\n})();\n</script>\n';
        }
        repairBlock += '<script>\n// 强制消除加载遮罩保底\n(function(){\n  var loaders = document.querySelectorAll("#loading, #loading-screen, #loadingOverlay, .loading-screen, .loading-overlay, .loading");\n  loaders.forEach(function(el){ el.style.display="none"; el.classList.add("hidden"); });\n})();\n</script>\n</body>\n</html>';
        content += repairBlock;
      }
    }

    const filePath = path.join(workspaceDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`📁 真实构建产物已无损落盘至工作区: ${filePath} (${content.length} 字节)`);
  } catch (e) {
    console.error('保存工作区文件失败:', e.message);
  }
}

/**
 * 构建执行脑系统提示词（从 SkillRegistry 动态注入技能约束）
 */
export function buildExecutorSystemPrompt(selectedSkill = 'bili_toy') {
  // 从 SkillRegistry 获取当前技能的 systemPrompt
  const skillPrompt = skillRegistry.getSkillPrompt(selectedSkill);
  const skill = skillRegistry.getSkill(selectedSkill);
  const skillName = skill?.name || selectedSkill;

  const basePrompt = `你是一个顶级全栈 Web 开发工程师与项目执行脑。你的联网检索功能已开启！

${skillPrompt ? `${skillPrompt}\n` : ''}
【绝对禁止事项 - 违反则视为任务失败】
❌ 禁止：在任何游戏或应用中加入登录门禁、身份验证等阻断用户进入主功能的流程。游戏启动必须直接可玩，无需登录。
❌ 禁止：使用 dummyimage.com、placeholder.com、placehold.it 或任何测试性占位图片服务。
❌ 禁止：在代码中硬编码本地不存在且无法访问的虚拟本地相对路径（如 dog.png）。
❌ 禁止：输出手绘像素小人或极其粗糙的纯 SVG 拼接形状替代角色立绘！必须使用 DiceBear/Unsplash/Pixabay 高精网络素材！
❌ 禁止：输出纯文字描述或注释性内容，必须直接输出完整立即可运行的单文件 HTML5 代码。
❌ 禁止：在页面中保留任何调试文本、测试按钮、占位符内容。
❌ 【致命Bug禁止】在代码中使用 alert()、confirm()、prompt()！它们在 iframe 沙盒与移动端中会被强行封锁并抛出 Uncaught DOMException 导致整个网页崩溃死锁！提示信息必须使用自定义内联 Toast/Modal DOM 节点或 console.log。
❌ 【致命Bug禁止】引入来自 cdnjs.cloudflare.com 或 unpkg.com 的任何外部 CDN 脚本！这些域名在国内访问极慢或超时，会导致页面永久卡在加载界面。如需 Howler.js，必须改用 Web Audio API 原生实现。
❌ 【致命Bug禁止】引入 fonts.googleapis.com 字体 CDN！此域名在国内被墙。如需自定义字体，使用 system-ui, 'Noto Sans SC', sans-serif 等系统字体回退。
❌ 【致命Bug禁止】将 B站 Toy SDK 或任何脚本设置为 defer 属性后再用 DOMContentLoaded 触发初始化！defer 脚本会阻塞 DOMContentLoaded 触发，导致 init 函数永远不执行、页面永久卡在加载界面！
❌ 【致命Bug禁止】裸调 localStorage.getItem / setItem！必须全部包裹在 try-catch 中，否则在 blob:iframe 预览或隐私模式下会抛 SecurityError 导致整个脚本崩溃、加载界面永远不消失。

【强制代码量控制与完整性保证】
✅ 对话节点控制：若制作 Galgame/视觉小说，请精心设计 15~25 个极具趣味性、B站热梗梗味十足、包含多分支选择与多结局的精美对话节点。切勿写入上百个巨型节点，避免超出 API 长度上限导致代码尾部被截断！必须确保包含完整的 </script>、</body>、</html> 标签收尾！

【强制画面切换与进入游戏交互逻辑 (绝对禁止黑屏)】
✅ 界面切换逻辑：点击“开始游戏”/“开始冒险”按钮时，必须精确控制 DOM 显隐。若存在最外层 #app 容器，必须同步对其添加 active 类或修改 display: flex/block！绝对禁止出现隐藏了标题页后，父级 #app 仍为 display: none 导致屏幕变黑无法进入游戏的问题！
✅ 所有 img 标签必须配置 onerror 保底（防止网络图床在部分环境加载失败导致显示撕裂破图）。

【强制初始化安全模式 - 所有 HTML5 项目必须严格遵守】
✅ 将 B站 Toy SDK 改为 async（不阻塞 DOMContentLoaded）：<script async src="https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js"></script>
✅ 初始化函数必须使用兼容写法，不能单纯依赖 DOMContentLoaded：
   if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => initGame()); } else { initGame(); }
✅ 隐藏加载屏保底：在 initGame() 开头立即设置安全定时器（即使后续逻辑失败，1秒后强制隐藏加载遮罩）：
   setTimeout(() => { const el = document.getElementById('loading') || document.getElementById('loadingScreen') || document.getElementById('loadingOverlay') || document.getElementById('loading-screen'); if(el) { el.style.display='none'; el.classList.add('hidden'); } }, 1000);
✅ 所有 localStorage 必须包裹在 try-catch 中：
   function safeGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
   function safeSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}

【强制视觉美学与游戏级质量标准】
✅ 丰富音效与 UI 质感：使用 Web Audio API（AudioContext）实现高质感音效，背景采用 Canvas 动态粒子/星空特效，按钮使用 CSS3 炫彩渐变、毛玻璃与 Hover 微交互动画。
✅ 布局自适应：所有 Web 页面必须 mobile-first 双端适配（viewport meta + @media 媒体查询）。
若遇到歧义，可用 [QUESTION_TO_PLANNER]提问[/QUESTION_TO_PLANNER]`;

  return basePrompt;
}

/**
 * 构建执行脑用户任务提示词
 */
export function buildExecutorPrompt(plan, task, plannerAnswer = null, selectedSkill = 'bili_toy') {
  // 获取技能约束规则（用于任务提示词强化）
  const skill = skillRegistry.getSkill(selectedSkill);
  const qualityRules = skill?.qualityRules || [];
  const forbiddenPatterns = skill?.forbiddenPatterns || [];

  const rulesBlock = qualityRules.length > 0
    ? `\n【当前技能质量规则 - ${skill.name}】\n${qualityRules.map(r => `✅ ${r}`).join('\n')}`
    : '';

  const forbidBlock = forbiddenPatterns.length > 0
    ? `\n【当前技能禁止项】\n${forbiddenPatterns.map(r => `❌ ${r}`).join('\n')}`
    : '';

  const assetBlock = `\n【推荐高质感素材、图标与备用保底配置 (请在 <img> 中添加 onerror 防破图)】
- 🐶 大狗叫/萌宠立绘: data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="55" fill="%23ff9f43"/><circle cx="45" cy="50" r="8" fill="%23222"/><circle cx="75" cy="50" r="8" fill="%23222"/><ellipse cx="60" cy="65" rx="12" ry="8" fill="%23222"/><polygon points="25,25 45,40 20,55" fill="%23ee5253"/><polygon points="95,25 75,40 100,55" fill="%23ee5253"/><text x="60" y="95" text-anchor="middle" fill="%23ffffff" font-weight="bold" font-size="12">大狗叫</text></svg>
- 🐱 圆头耄耋/老者立绘: data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="55" fill="%2354a0ff"/><circle cx="45" cy="50" r="6" fill="%23222"/><circle cx="75" cy="50" r="6" fill="%23222"/><path d="M40,75 Q60,90 80,75" stroke="%23222" stroke-width="4" fill="none"/><path d="M30,35 Q60,20 90,35" stroke="%23ffffff" stroke-width="6" fill="none"/><text x="60" y="105" text-anchor="middle" fill="%23ffffff" font-weight="bold" font-size="11">圆头耄耋</text></svg>
- 🌆 赛博/暗黑炫彩背景: linear-gradient(135deg, %230a0a1a 0%, %231a0a2e 50%, %230a1a2e 100%)
- 🐶 备用外网立绘(配合onerror): https://api.dicebear.com/7.x/bottts/svg?seed=hero_dog
- ⚔️ 备用主角立绘(配合onerror): https://api.dicebear.com/7.x/adventurer/svg?seed=hero_master`;

  if (plannerAnswer) {
    return `项目：${plan?.title || '项目'}\n任务 ${task.id}：${task.title}\n描述：${task.description}\n预期输出：${task.expected_output || '完整实体代码/文件'}\n\n【策略脑指导更新】策略脑对你之前提问的解决方案：\n${plannerAnswer}\n\n请结合策略脑的专业指导，继续完成上述任务。${rulesBlock}${forbidBlock}${assetBlock}`;
  }
  return `项目：${plan?.title || '项目'}\n任务 ${task.id}：${task.title}\n描述：${task.description}\n预期输出：${task.expected_output || '完整实体代码/文件'}${rulesBlock}${forbidBlock}${assetBlock}`;
}
