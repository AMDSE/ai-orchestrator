// backend/agents/planner.js
// 策略脑 (Strategy Brain)：使用【高性能模型】作为顶层架构师
// 全部通过 OpenAI 兼容外接 API 调用，无内置/专属模型依赖

import 'dotenv/config';
import { searchWeb, searchImageAssets } from '../services/search_service.js';
import { createStrategyClient, streamChat, parseJsonResponse } from '../lib/llm.js';

const PLANNER_SYSTEM_PROMPT = `【隐形系统指令：你仅作为项目的顶级策略 brain / 策略脑】

你是一个顶尖的 AI 项目策略脑（Strategic Planner Brain），运行在高性能模型之上。你的唯一职责是：
1. 【架构规划与无损需求继承】接收用户想法，深度分析需求。用户在原始想法中提出的所有具体硬性要求（如"双端适配 / 移动端与桌面端自适应"、"特定主题/热梗/核心玩法"、"彻底去除页面非必要/测试性冗余元素"、"指定导出文件格式"等），策略脑在拆解 tasks 任务清单时，必须 100% 完整继承并显式写进每个 task 的 description 和 expected_output 中，严禁在归纳时丢弃或擅自替换主题！
2. 【现代 Web 美学与游戏级视觉标准】你规划的 Web 应用与小游戏产物必须具备顶级视觉质感！在拆解任务时，必须明确要求执行脑使用高品质网络图床/CDN素材（如 Unsplash、Pixabay、DiceBear高清矢量人像）、现代 CSS3 炫彩/暗黑 UI、毛玻璃视差（Glassmorphism）、微交互动画与 Web Audio/Howler.js 真实音效！严禁允许执行脑使用手绘像素小人或粗糙的 HTML 几何拼凑！
3. 【严格分工】你绝对不是执行代码的底层机器！你绝不要尝试自己编写全部具体代码或替代执行脑工作！你的职责是给【执行脑 (Executor Brain)】下发任务指令、解答其执行瓶颈，并在执行脑完成后进行质量审查。
4. 【质量审查与迭代】当执行脑完成某一轮代码构建后，你需要对照用户原始需求及美学标准对产物进行严苛审查：
   - 核查是否实现了双端适配（CSS @media 移动端自适应布局）；
   - 核查视觉与素材质量：是否调用了高清网络素材/图床/规范人像，是否存在粗糙像素拼接或画风丑陋的问题（若存在，必须要求引入高质感网络素材并重构 UI）；
   - 核查产物中是否清理干净了所有多余/测试性/临时占位符与无关 UI 元素；
   - 若存在未实现功能或瑕疵，提出具体优化任务并启动下一轮迭代；如果产物完美或已达上限，给出终审总结。
5. 【动态输出格式与联网搜索】你的联网检索功能已始终开启！针对用户需求的类型（如 Web 应用、数据模型、Python 自动化脚本、矢量图设计、配置文件等），通过联网搜索确定该技术领域最佳的导出文件格式（如 .html, .json, .py, .svg, .csv, .xml, .js 等），并在 expected_output 中明确告知执行脑输出对应格式的代码文件。

在规划与审查前，请先给出简短的【思考分析过程】，然后再输出 JSON 结构。

输出格式要求（任务规划阶段）：
{
  "type": "plan",
  "title": "项目标题",
  "summary": "项目简述",
  "tasks": [
    {
      "id": 1,
      "title": "任务名称",
      "description": "详细描述",
      "expected_output": "预期输出"
    }
  ]
}

当进行代码审查与迭代评估阶段时，输出格式：
{
  "type": "review",
  "decision": "optimize" | "complete",
  "analysis": "对当前执行成果的详细质量审查分析",
  "new_tasks": [
    {
      "id": 2,
      "title": "优化/补充任务名称",
      "description": "具体优化执行要求",
      "expected_output": "优化预期效果"
    }
  ],
  "summary": "迭代总结或终审判定"
}

当回答执行脑或用户介入的问题时，输出格式：
{
  "type": "answer",
  "answer": "具体解答内容",
  "suggestion": "建议执行脑的下一步行动"
}

始终用中文回复，保持专业、严谨、策略化。`;


export class PlannerAgent {
  constructor() {
    this.conversationHistory = new Map();
  }

  _getHistory(projectId, webSearch = true) {
    if (!this.conversationHistory.has(projectId)) {
      const searchPrompt = webSearch !== false
        ? "5. 【联网搜索】联网检索功能已开启！请积极整合最新的在线技术文档、行业最佳实践与实时趋势信息。"
        : "5. 【联网搜索】联网检索功能已关闭。请基于内部知识储备回答，不进行外部网络检索。";

      const systemPrompt = PLANNER_SYSTEM_PROMPT.replace(/5\. 【联网搜索】.*/, searchPrompt);

      this.conversationHistory.set(projectId, [
        { role: 'system', content: systemPrompt }
      ]);
    }
    return this.conversationHistory.get(projectId);
  }

  /**
   * 获取策略脑客户端与模型：仅支持外接 API（OpenAI 兼容）
   */
  _getClientAndModel(plannerConfig) {
    const { client, model, config } = createStrategyClient(plannerConfig);
    if (!config.apiKey) {
      console.warn('[Planner] ⚠️ 策略脑未配置 API Key，请填写外接 API 凭据');
    }
    return { client, model };
  }

  injectIntervention(projectId, userMessage) {
    const history = this._getHistory(projectId);
    history.push({
      role: 'user',
      content: `【用户实时介入】用户提出了调整意见/补充要求：\n${userMessage}\n\n请根据用户的新要求重新规划或调整建议。`
    });
  }


  async _streamCompletion(projectId, prompt, plannerConfig = null, onChunk = null, signal = null) {
    const webSearch = plannerConfig?.webSearch !== false;
    const history = this._getHistory(projectId, webSearch);

    if (prompt) {
      let realSearchContext = '';
      if (webSearch) {
        try {
          console.log(`[Planner Engine] 正在拉起真实联网检索与高精图片资源库 (Asset Registry)...`);
          const [webData, assetData] = await Promise.all([
            searchWeb(prompt),
            searchImageAssets(prompt)
          ]);
          realSearchContext = `\n\n[🌐 真实联网最新检索资讯 (实测数据)]:\n${webData}\n\n${assetData}`;
        } catch (e) {
          console.warn('[Planner Engine] 真实检索异常，降级处理:', e.message);
        }
      }

      history.push({ role: 'user', content: prompt + realSearchContext });
    }

    const { client, model } = this._getClientAndModel(plannerConfig);
    console.log(`[Planner Engine] 运行策略脑 (高性能模型) - 模型: ${model}`);

    const fullContent = await streamChat({
      client,
      model,
      messages: history,
      temperature: 0.7,
      signal,
      onChunk: (type, token) => {
        if (onChunk) onChunk(type, token);
      },
    });

    history.push({ role: 'assistant', content: fullContent });
    return this._parseResponse(fullContent);
  }

  async generatePlan(projectId, userIdea, plannerConfig = null, onChunk = null, signal = null) {
    const prompt = `请为以下想法制定详细的执行计划：\n\n${userIdea}`;
    return await this._streamCompletion(projectId, prompt, plannerConfig, onChunk, signal);
  }

  async generateIdeas(projectId, hint = '', plannerConfig = null, onChunk = null, signal = null) {
    const prompt = hint
      ? `请围绕"${hint}"生成3个有趣且有价值的项目想法，然后选出最佳方案并制定执行计划。`
      : `请自主生成3个有创意且实用的项目想法（可以是Web应用、工具、游戏等），然后选出最佳方案并制定执行计划。`;
    return await this._streamCompletion(projectId, prompt, plannerConfig, onChunk, signal);
  }


  async answerQuestion(projectId, question, context = '', plannerConfig = null, onChunk = null, signal = null) {
    const prompt = context
      ? `执行脑在执行项目时遇到了问题：\n\n问题：${question}\n\n上下文：${context}\n\n请给出专业的解决方案。`
      : `执行脑遇到了问题：${question}\n\n请给出专业的解决方案。`;
    return await this._streamCompletion(projectId, prompt, plannerConfig, onChunk, signal);
  }

  async reviewExecution(projectId, currentIteration, maxIterations, tasks, plannerConfig = null, onChunk = null, signal = null) {
    const outputsText = (tasks || []).map(t => {
      let safeOutput = t.output || '未产生文本';
      // 1. 智能剥离图片 base64 等导致假死的无用超长二进制流
      safeOutput = safeOutput.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[Base64图片数据已折叠]');
      safeOutput = safeOutput.replace(/data:audio\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[Base64音频数据已折叠]');
      // 剥离可能导致审查极度缓慢甚至假死的内联 SVG 和超长图片标签
      safeOutput = safeOutput.replace(/<svg[\s\S]*?<\/svg>/gi, '[SVG矢量图形已折叠以加速审查]');
      safeOutput = safeOutput.replace(/<img[\s\S]*?>/gi, '[IMG图片标签已折叠]');

      // 2. 结构化处理：判断代码闭合完整性，避免暴力切断中段导致 JS 语法破坏从而引起策略脑误判"假完成"
      const isHtml = /<!DOCTYPE html>|<html/i.test(safeOutput);
      const isClosed = /<\/html>/i.test(safeOutput);
      let statusTag = '';
      if (isHtml && !isClosed) {
        statusTag = '\n⚠️ 【系统检测警示】：该 HTML 代码末尾未发现 </html> 闭合标签，已被模型输出长度截断！\n';
      }

      if (safeOutput.length > 25000) {
        safeOutput = safeOutput.substring(0, 14000) +
          `\n\n...[全量实体代码过长(共 ${safeOutput.length} 字节)，已折叠中间部分剧情节点数据，保持首尾结构完整]...\n\n` +
          safeOutput.substring(safeOutput.length - 8000);
      }

      return `### 任务 ${t.id}: ${t.title}\n描述: ${t.description}\n预期输出: ${t.expected_output || ''}\n${statusTag}执行产物:\n${safeOutput}`;
    }).join('\n\n');


    const prompt = `【系统信号：执行脑已完成第 ${currentIteration} 轮代码方案构建】
当前为第 ${currentIteration} 轮迭代 (设定上限为 ${maxIterations} 轮)。
请策略脑对照用户原始需求，对以下执行脑产物进行深度质量审查与瑕疵检验：

${outputsText}

请策略脑严肃审查研判以下三项：
1. 【需求完整性与双端适配核验】：产物是否 100% 实现了用户要求的所有具体指标（若用户要求网页，是否包含 CSS @media (max-width: 768px) 移动端与桌面端双端自适应布局）？若缺失双端适配或功能点，必须判定 decision="optimize"！
2. 【干净无多余元素核验】：产物中是否混入或残留了测试性文本、临时调试数据、放置在不合理位置的测试框/不相关元素？若包含无关冗余元素，必须判定 decision="optimize" 并在 new_tasks 中要求彻底清理！
3. 【防假完成核验】：若执行产物仅仅是描述性文本，或者没有包含实体代码文件，必须判定为【假完成/严重质量瑕疵】！

仅当产物 100% 覆盖用户需求、具备完美双端自适应且干净无任何冗余文本时，方可输出 decision="complete"。`;

    return await this._streamCompletion(projectId, prompt, plannerConfig, onChunk, signal);
  }

  async handleUserIntervention(projectId, userMessage, files = [], plannerConfig = null, onChunk = null, signal = null) {
    let messageContent = userMessage || '';
    if (files && files.length > 0) {
      const filesText = files.map(f => `--- 📎 附件文件: ${f.name} ---\n${f.content}`).join('\n\n');
      messageContent = `${messageContent}\n\n[用户附带上传文件资料如下]:\n${filesText}`;
    }
    this.injectIntervention(projectId, messageContent);
    return await this._streamCompletion(projectId, null, plannerConfig, onChunk, signal);
  }

  _parseResponse(content) {
    try {
      const parsed = parseJsonResponse(content);
      if (parsed && parsed.type) return parsed;
    } catch (e) {
      // ignore, fall through to heuristic fallback
    }

    // 智能兜底逻辑：若未能解析为标准的 Review JSON，且文本包含瑕疵/优化关键字，自动构造 review-optimize 结构
    if (content.includes('瑕疵') || content.includes('优化') || content.includes('假完成') || content.includes('缺陷') || content.includes('补充')) {
      return {
        type: 'review',
        decision: 'optimize',
        analysis: content,
        new_tasks: [
          {
            id: 99,
            title: '根据策略脑审查分析优化补全细节代码',
            description: content.substring(0, 300),
            expected_output: '补全全量实体 HTML5 网页代码'
          }
        ],
        summary: '策略脑检测到细节瑕疵，发起自动优化。'
      };
    }

    return { type: 'text', content };
  }

  clearHistory(projectId) {
    this.conversationHistory.delete(projectId);
  }
}
