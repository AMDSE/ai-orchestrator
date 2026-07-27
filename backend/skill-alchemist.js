// backend/skill-alchemist.js
// 技能炼化器：爬取信源 → 策略脑 LLM 提炼 → 生成 Skill JSON → 注册到 SkillRegistry
// 爬虫首选 Jina Reader API（零安装）+ 可选 Crawlee 批量抓取

import OpenAI from 'openai';
import { skillRegistry } from './skill-registry.js';

// Jina Reader：零配置，将任意 URL 转换为 LLM-ready Markdown
async function scrapeViaJinaReader(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/plain, text/markdown',
      'X-Return-Format': 'markdown',
      'X-Timeout': '15'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Jina Reader 请求失败: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();
  return {
    url,
    content: content.slice(0, 12000), // 限制 token 数量
    source: 'jina_reader'
  };
}

// GitHub README 直接拉取（raw 格式，速度快）
async function scrapeGitHubReadme(repoUrl) {
  // 将 github.com/user/repo 转换为 raw.githubusercontent.com
  const rawUrl = repoUrl
    .replace('github.com', 'raw.githubusercontent.com')
    .replace('/tree/main', '')
    .replace('/tree/master', '')
    .replace(/\/$/, '') + '/refs/heads/main/README.md';

  try {
    const response = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const content = await response.text();
      return { url: repoUrl, content: content.slice(0, 10000), source: 'github_raw' };
    }
  } catch {}

  // 回退到 Jina Reader
  return scrapeViaJinaReader(repoUrl);
}

/**
 * 爬取多个信源 URL，返回聚合内容
 */
export async function scrapeSourceUrls(urls) {
  const results = [];
  for (const url of urls) {
    try {
      let result;
      if (url.includes('github.com') && !url.includes('/blob/')) {
        result = await scrapeGitHubReadme(url);
      } else {
        result = await scrapeViaJinaReader(url);
      }
      results.push(result);
    } catch (e) {
      console.warn(`[Alchemist] 抓取 ${url} 失败: ${e.message}`);
      results.push({ url, content: `[抓取失败: ${e.message}]`, source: 'error' });
    }
  }
  return results;
}

/**
 * 核心炼化函数：将爬取内容 → LLM 提炼 → Skill JSON
 */
export async function alchemizeSkill({ urls, customPrompt, plannerConfig, onProgress }) {
  const openaiClient = new OpenAI({
    apiKey: process.env.LONGCAT_API_KEY,
    baseURL: process.env.LONGCAT_BASE_URL,
  });

  // Stage 1: 爬取所有信源
  onProgress?.('scraping', '正在抓取信源内容...');
  const scrapedDocs = await scrapeSourceUrls(urls);
  const totalContent = scrapedDocs
    .map(d => `### 来源: ${d.url}\n${d.content}`)
    .join('\n\n---\n\n');

  // Stage 2: LLM 炼化 Prompt
  onProgress?.('alchemizing', '策略脑正在分析与提炼技能...');

  const alchemySystemPrompt = `你是一个 AI 项目技能（Project Skill）设计专家。
你的任务是：根据用户提供的官方文档/技术规范内容，提炼出一套精准的、可注入到 AI 代码生成系统中的"项目技能 (Project Skill)"定义。

项目技能的作用是：在 AI 生成代码时，强制约束 AI 遵守特定平台、框架或技术栈的规范，避免生成不合规的代码。

你必须严格输出以下 JSON 格式，不要包含任何 Markdown 包裹或额外解释：
{
  "id": "short_snake_case_id（英文小写下划线，唯一，例如 wechat_miniapp）",
  "name": "技能展示名称（含 emoji 图标，如 📱 微信小程序规范）",
  "icon": "单个 emoji",
  "description": "简短描述（30字以内，说明技能涵盖的核心规约）",
  "version": "1.0.0",
  "targetPlatform": "目标平台名称",
  "builtIn": false,
  "systemPrompt": "详细的平台规范指令（此文本将直接注入 AI 代码生成器的 System Prompt。必须精准、可操作、包含具体技术规范）",
  "qualityRules": ["规则1", "规则2", "规则3（3-8条可操作性规则）"],
  "forbiddenPatterns": ["禁止项1", "禁止项2（明确禁止的具体做法）"],
  "sourceDocs": ["来源URL1", "来源URL2"]
}`;

  const userMessage = `请根据以下从官方信源爬取的技术文档，提炼出一套精准的项目技能定义。

${customPrompt ? `用户的特别说明：${customPrompt}\n\n` : ''}官方文档内容：
${totalContent}

请直接输出 JSON，不要包含任何其他内容。`;

  const model = plannerConfig?.model || process.env.LONGCAT_MODEL || 'LongCat-2.0';
  const stream = await openaiClient.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: alchemySystemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: 0.4,
    stream: true,
  });

  let rawOutput = '';
  const chunks = [];
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    if (token) {
      chunks.push(token);
      onProgress?.('token', token);
    }
  }
  rawOutput = chunks.join('');

  // Stage 3: 解析 JSON 输出
  onProgress?.('parsing', '正在解析技能结构...');
  let skillData;

  try {
    // 去除可能的 Markdown 包裹
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM 未输出有效 JSON');
    skillData = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`技能 JSON 解析失败: ${e.message}\n原始输出:\n${rawOutput.slice(0, 500)}`);
  }

  // Stage 4: 补全元数据并校验
  skillData.id = skillData.id || `custom_${Date.now()}`;
  skillData.builtIn = false;
  skillData.createdAt = new Date().toISOString();
  skillData.sourceDocs = urls;

  if (!skillData.name || !skillData.systemPrompt) {
    throw new Error('炼化结果不完整：缺少 name 或 systemPrompt 字段');
  }

  // Stage 5: 注册到 SkillRegistry
  onProgress?.('saving', '正在注册技能至技能库...');
  skillRegistry.saveSkill(skillData);

  return skillData;
}
