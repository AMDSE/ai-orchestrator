// backend/agents/executor_bridge.js
// 执行脑 (Executor Brain)：使用【较低性能模型】作为落地执行者（低成本、高吞吐）
// 全部通过 OpenAI 兼容外接 API 调用，无本地 CLI / 专用模型依赖

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { skillRegistry } from '../skill-registry.js';
import { createExecutorClient, streamChat } from '../lib/llm.js';
import { searchWeb, searchImageAssets } from '../services/search_service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 执行脑基础系统提示词（通用层，不含具体技能）
 */
const BASE_EXECUTOR_SYSTEM_PROMPT = `【隐形系统指令：你仅作为项目的执行脑 (Executor Brain)】

你是项目执行脑（Executor Brain），运行在较低性能模型上（成本低、速度快、吞吐高），专职于代码落地与文件生成。你的唯一职责是：
1. 【严格服从策略脑指令】认真阅读并 100% 落实【策略脑 (Strategy Brain)】下发的任务 description 与 expected_output，严禁漏项、简化或擅自替换任务目标。
2. 【真实实体代码落盘】所有产物必须是完整、可运行的真实实体代码文件（HTML/CSS/JS/JSON 等）。严禁输出"已在本地打开/已开始生成/请稍候"等无实体的描述性文本——这是严重质量瑕疵！
3. 【代码完整性与可运行性】输出的 HTML 必须包含 <!DOCTYPE html> 与 </html> 闭合标签；JS 不得存在未闭合标签导致的 SyntaxError；所有资源引用采用相对路径（如 ./assets/xx.png），避免根路径与外部占位图服务。
4. 【向策略脑求助】若遇到技术瓶颈、需求歧义或未知 API，必须使用 [QUESTION_TO_PLANNER]你的问题[/QUESTION_TO_PLANNER] 标签向策略脑提问，不得擅自猜测瞎写。
5. 【干净无冗余】严禁残留测试性文本、调试占位符、临时弹窗或无关 UI 元素；产物应开箱即用。
6. 【现代视觉标准】若构建 Web 应用，必须 mobile-first 双端自适应（viewport meta + CSS @media 媒体查询），使用高质量网络图床素材与现代 CSS 视觉效果，禁止粗糙像素拼接。
7. 【基于框架继续构建】若提示词中包含策略脑已完成的【整体框架 (framework)】，你必须在框架基础上补齐剩余实现，严禁推倒重写或忽略框架；框架中的高难度模块已由策略脑完成，你只需完成剩余部分并保证整体可运行。
8. 【善用联网检索结果】若提示词中包含【🌐 真实联网检索资讯】，必须基于这些真实资料进行开发决策，不得忽略或虚构。

你只负责执行，不负责战略决策与质量终审（那是策略脑的工作）。`;

/**
 * 构建执行脑系统提示词：通用基础层 + 动态注入当前选中技能 (Skill) 的
 * systemPrompt / qualityRules / forbiddenPatterns 硬约束
 * @param {string} selectedSkill skillId
 */
export function buildExecutorSystemPrompt(selectedSkill = 'bili_toy') {
  const skill = skillRegistry.getSkill(selectedSkill);

  const skillPrompt = skill?.systemPrompt?.trim();
  const qualityRules = skill?.qualityRules || [];
  const forbiddenPatterns = skill?.forbiddenPatterns || [];

  const sections = [BASE_EXECUTOR_SYSTEM_PROMPT];

  if (skillPrompt) {
    sections.push(`\n\n【当前项目技能系统提示词 (${skill.name})】\n${skillPrompt}`);
  }

  if (qualityRules.length > 0) {
    sections.push(`\n\n【当前技能质量规则 (必须逐条满足)】\n${qualityRules.map(r => `✅ ${r}`).join('\n')}`);
  }

  if (forbiddenPatterns.length > 0) {
    sections.push(`\n\n【当前技能绝对禁止项 (出现即视为违规)】\n${forbiddenPatterns.map(r => `❌ ${r}`).join('\n')}`);
  }

  return sections.join('');
}

/**
 * 构建执行脑用户任务提示词（含策略脑指导、技能规则强化与素材建议）
 */
export function buildExecutorPrompt(plan, task, plannerAnswer = null, selectedSkill = 'bili_toy', framework = '') {
  const skill = skillRegistry.getSkill(selectedSkill);
  const qualityRules = skill?.qualityRules || [];
  const forbiddenPatterns = skill?.forbiddenPatterns || [];

  const frameworkBlock = (framework && framework.trim())
    ? `\n\n【🏗️ 策略脑已完成的整体框架与高难度部分 (framework)】\n请基于以下框架继续完成剩余任务，禁止推倒重写：\n${framework}`
    : '';

  const rulesBlock = qualityRules.length > 0
    ? `\n【当前技能质量规则 - ${skill.name}】\n${qualityRules.map(r => `✅ ${r}`).join('\n')}`
    : '';

  const forbidBlock = forbiddenPatterns.length > 0
    ? `\n【当前技能禁止项】\n${forbiddenPatterns.map(r => `❌ ${r}`).join('\n')}`
    : '';

  const assetBlock = `\n【推荐高质感素材与备用保底配置 (请在 <img> 中添加 onerror 防破图)】
- 🐶 萌宠立绘(SVG备用): data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="55" fill="%23ff9f43"/><circle cx="45" cy="50" r="8" fill="%23222"/><circle cx="75" cy="50" r="8" fill="%23222"/><ellipse cx="60" cy="65" rx="12" ry="8" fill="%23222"/><polygon points="25,25 45,40 20,55" fill="%23ee5253"/><polygon points="95,25 75,40 100,55" fill="%23ee5253"/><text x="60" y="95" text-anchor="middle" fill="%23ffffff" font-weight="bold" font-size="12">Hero</text></svg>
- 🌆 赛博/暗黑炫彩背景: linear-gradient(135deg, %230a0a1a 0%, %231a0a2e 50%, %230a1a2e 100%)
- 🧑 备用角色立绘(配合onerror): https://api.dicebear.com/7.x/adventurer/svg?seed=hero_main`;

  if (plannerAnswer) {
    return `项目：${plan?.title || '项目'}\n任务 ${task.id}：${task.title}\n描述：${task.description}\n预期输出：${task.expected_output || '完整实体代码/文件'}\n\n【策略脑指导更新】策略脑对你之前提问的解决方案：\n${plannerAnswer}\n\n请结合策略脑的专业指导，继续完成上述任务。${frameworkBlock}${rulesBlock}${forbidBlock}${assetBlock}`;
  }
  return `项目：${plan?.title || '项目'}\n任务 ${task.id}：${task.title}\n描述：${task.description}\n预期输出：${task.expected_output || '完整实体代码/文件'}${frameworkBlock}${rulesBlock}${forbidBlock}${assetBlock}`;
}


/**
 * 通过外接 API (OpenAI 兼容) 执行任务
 */
async function executeViaExternalApi(taskData, executorConfig, onToken = null, signal = null) {
  const { client, model } = createExecutorClient(executorConfig);
  if (!resolveApiKey(executorConfig)) {
    throw new Error('执行脑未配置 API Key，请在 .env 或界面中填写外接 API 凭据');
  }

  let prompt = buildExecutorPrompt(taskData.plan, taskData.task, taskData.plannerAnswer, taskData.selectedSkill || 'bili_toy', taskData.framework || '');

  // 执行脑联网检索：开启后必须真实访问搜索引擎
  if (taskData.webSearch) {
    try {
      console.log('[Executor Engine] 🌐 执行脑联网检索已开启，正在拉取真实网络资讯与素材...');
      const [webData, assetData] = await Promise.all([
        searchWeb(prompt),
        searchImageAssets(prompt)
      ]);
      prompt += `\n\n[🌐 真实联网检索资讯]:\n${webData}\n\n${assetData}`;
    } catch (webErr) {
      console.warn('[Executor Engine] 执行脑联网检索异常，继续基于内部知识执行:', webErr.message);
    }
  }

  console.log(`🌐 执行脑 (较低性能模型) 通过外接 API: BaseURL=${executorConfig.baseUrl || process.env.EXECUTOR_BASE_URL || '(env)'}, Model=${model}`);

  const rawOutput = await streamChat({
    client,
    model,
    messages: [
      { role: 'system', content: buildExecutorSystemPrompt(taskData.selectedSkill || 'bili_toy') },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6,
    signal,
    onChunk: (type, token) => {
      if (type === 'content' && onToken) onToken(token);
    },
  });

  if (rawOutput.includes('[QUESTION_TO_PLANNER]')) {
    const match = rawOutput.match(/\[QUESTION_TO_PLANNER\]([\s\S]*?)\[\/QUESTION_TO_PLANNER\]/);
    return { type: 'question', question: match ? match[1].trim() : rawOutput };
  }

  return { type: 'task_complete', output: rawOutput };
}

function resolveApiKey(config = null) {
  return config?.apiKey || process.env.EXECUTOR_API_KEY || '';
}

/**
 * 主执行入口：仅支持外接 API（OpenAI 兼容）
 * @param {object} taskData { projectId, task, plan, selectedSkill, plannerAnswer, executorConfig, signal }
 */
export async function executeTask(taskData, defaultOpenaiClient = null, onToken = null) {
  const executorConfig = taskData.executorConfig || {};
  const projectId = taskData.projectId || 'default';

  // 创建该项目的专属工作区目录
  const workspaceDir = path.join(__dirname, '..', '..', 'workspace', projectId);
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch (e) {}

  console.log(`[Executor Engine] 模式: 外接 API | Workspace: ${workspaceDir}`);
  const result = await executeViaExternalApi(taskData, executorConfig, onToken, taskData.signal);

  if (result.type === 'task_complete' && result.output) {
    _saveToWorkspace(workspaceDir, result.output);
  }
  return result;
}

// 语言 → 默认文件名的映射表
const LANGUAGE_FILE_MAP = {
  html: 'index.html', htm: 'index.html',
  json: 'data.json', js: 'script.js', javascript: 'script.js',
  css: 'style.css', py: 'main.py', python: 'main.py',
  svg: 'image.svg', csv: 'data.csv', xml: 'config.xml',
  sql: 'query.sql', md: 'README.md', markdown: 'README.md',
  ts: 'script.ts', typescript: 'script.ts', jsx: 'App.jsx',
  tsx: 'App.tsx', vue: 'App.vue', txt: 'output.txt'
};

function detectFileFromContent(lang, content) {
  if (LANGUAGE_FILE_MAP[lang]) return LANGUAGE_FILE_MAP[lang];
  if (lang) return `output.${lang}`;

  // 无语言标签时的特征智能识别
  if (/<!DOCTYPE html>|<html/i.test(content)) return 'index.html';
  if (/^\s*[{\[]/.test(content)) return 'data.json';
  if (content.includes('body {') || content.includes('margin:') || content.includes('display:')) return 'style.css';
  return 'index.html';
}


/**
 * 将模型输出智能解析并落盘到工作区
 * - 支持单个或多个 Markdown 代码块 → 多个实体文件
 * - 无代码块时整段保存为 index.html / 文本文件
 */
function _saveToWorkspace(workspaceDir, codeText) {
  try {
    if (!codeText || typeof codeText !== 'string') return;

    const trimmed = codeText.trim();
    if (!trimmed) return;

    // 1. 提取所有 Markdown 代码块
    const codeBlocks = [...trimmed.matchAll(/```([a-zA-Z0-9_+-]+)?\s*([\s\S]*?)```/g)]
      .map(m => ({ lang: (m[1] || '').toLowerCase(), content: m[2].trim() }))
      .filter(b => b.content);

    // 2. 内联 HTML 直接提取
    const htmlTagMatch = trimmed.match(/(<!DOCTYPE html>[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i);

    let files = [];

    if (codeBlocks.length > 0) {
      if (codeBlocks.length === 1) {
        const block = codeBlocks[0];
        files.push({ fileName: detectFileFromContent(block.lang, block.content), content: block.content });
      } else {
        // 多代码块：依次落盘为独立文件（同名自动去重）
        const usedNames = new Set();
        codeBlocks.forEach((block, idx) => {
          let fileName = detectFileFromContent(block.lang, block.content);
          if (usedNames.has(fileName)) {
            fileName = fileName.replace(/(\.[a-z0-9]+)$/i, `_${idx + 1}$1`);
          }
          usedNames.add(fileName);
          files.push({ fileName, content: block.content });
        });
      }
    } else if (htmlTagMatch) {
      files.push({ fileName: 'index.html', content: htmlTagMatch[1].trim() });
    } else {
      // 纯文本/无代码块 → 按内容特征保存
      const fileName = detectFileFromContent('', trimmed);
      files.push({ fileName, content: trimmed });
    }

    // 3. 防御性 HTML 修复 + 落盘
    for (const f of files) {
      let content = f.content;
      if (f.fileName === 'index.html' && /<!DOCTYPE html>|<html/i.test(content)) {
        content = repairTruncatedHtml(content);
      }
      const filePath = path.join(workspaceDir, f.fileName);
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`📁 构建产物已无损落盘至工作区: ${filePath} (${content.length} 字节)`);
    }
  } catch (e) {
    console.error('保存工作区文件失败:', e.message);
  }
}

/**
 * 防御性修复：处理 HTML 输出截断导致的 <script> 未闭合与加载屏卡死
 */
function repairTruncatedHtml(content) {
  let repaired = content;

  // 替换裸调 alert 为 safeToast，避免 iframe 弹出框被阻断抛 DOMException 崩溃
  repaired = repaired.replace(/alert\(([^)]+)\)/g, 'console.log("[Toast Notification]", $1)');

  const openScriptCount = (repaired.match(/<script[^>]*>/gi) || []).length;
  const closeScriptCount = (repaired.match(/<\/script>/gi) || []).length;
  const isClosedHtml = /<\/html>/i.test(repaired);

  if (openScriptCount > closeScriptCount || !isClosedHtml) {
    console.warn(`[Workspace Saver Warning] 检测到产物 HTML 遭遇输出截断，自动执行 DOM 闭合与加载强保底注入...`);
    let repairBlock = '\n';
    if (openScriptCount > closeScriptCount) {
      repairBlock += ';\n  } catch(e) { console.warn("[Safe Recovery]", e); }\n})();\n</script>\n';
    }
    repairBlock += '<script>\n// 强制消除加载遮罩保底\n(function(){\n  var loaders = document.querySelectorAll("#loading, #loading-screen, #loadingOverlay, .loading-screen, .loading-overlay, .loading");\n  loaders.forEach(function(el){ el.style.display="none"; el.classList.add("hidden"); });\n})();\n</script>\n</body>\n</html>';
    repaired += repairBlock;
  }

  return repaired;
}
