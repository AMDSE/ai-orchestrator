// backend/lib/llm.js
// 统一 LLM 客户端工厂：策略脑与执行脑全部走 OpenAI 兼容外接 API
// 策略脑默认使用高性能模型，执行脑默认使用较低性能模型（低成本、高吞吐）

import OpenAI from 'openai';
import 'dotenv/config';

/**
 * 解析策略脑配置：优先使用界面传入的配置，否则回退到环境变量
 * @param {object|null} config 前端传入的 { provider, model, apiKey, baseUrl, webSearch }
 */
export function resolveStrategyConfig(config = null) {
  return {
    provider: 'custom_api',
    // 模型名不硬编码：必须由用户配置（界面或 STRATEGY_MODEL 环境变量）
    model: config?.model || process.env.STRATEGY_MODEL || '',
    apiKey: config?.apiKey || process.env.STRATEGY_API_KEY || '',
    baseUrl: config?.baseUrl || process.env.STRATEGY_BASE_URL || '',
    webSearch: config?.webSearch !== undefined ? config.webSearch : true,
  };
}

/**
 * 解析执行脑配置：优先使用界面传入的配置，否则回退到环境变量
 * @param {object|null} config 前端传入的 { provider, model, apiKey, baseUrl, webSearch }
 */
export function resolveExecutorConfig(config = null) {
  return {
    provider: 'custom_api',
    // 模型名不硬编码：必须由用户配置（界面或 EXECUTOR_MODEL 环境变量）
    model: config?.model || process.env.EXECUTOR_MODEL || '',
    apiKey: config?.apiKey || process.env.EXECUTOR_API_KEY || '',
    baseUrl: config?.baseUrl || process.env.EXECUTOR_BASE_URL || '',
    webSearch: config?.webSearch !== undefined ? config.webSearch : false,
  };
}

/**
 * 创建 OpenAI 兼容客户端
 * @param {string} apiKey
 * @param {string} baseUrl
 */
export function createClient(apiKey, baseUrl) {
  if (!apiKey) {
    console.warn('[LLM] ⚠️ 缺少 API Key，请检查 .env 或界面配置！');
  }
  return new OpenAI({
    apiKey: apiKey || 'sk-placeholder',
    baseURL: baseUrl || 'https://api.openai.com/v1',
  });
}

export function createStrategyClient(config = null) {
  const resolved = resolveStrategyConfig(config);
  return { client: createClient(resolved.apiKey, resolved.baseUrl), model: resolved.model, config: resolved };
}

export function createExecutorClient(config = null) {
  const resolved = resolveExecutorConfig(config);
  return { client: createClient(resolved.apiKey, resolved.baseUrl), model: resolved.model, config: resolved };
}

/**
 * 统一的流式对话封装：自动提取 reasoning_content / thought 作为思考流，
 * content 作为正式输出 token。兼容 AbortSignal 中断。
 * @param {object} options
 * @param {OpenAI} options.client
 * @param {string} options.model
 * @param {Array}  options.messages
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.onChunk]  (type: 'thought'|'content', token) => void
 * @returns {Promise<string>} 拼接后的完整 content
 */
export async function streamChat({ client, model, messages, temperature = 0.6, signal = null, onChunk = null, tools = null, toolChoice = null, stream = true, pushAssistantOnToolCalls = false }) {
  const response = await client.chat.completions.create(
    {
      model,
      messages,
      temperature,
      stream,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    },
    { signal: signal || undefined, timeout: 180000 }
  );

  if (!stream) {
    return response.choices?.[0]?.message?.content || '';
  }

  const chunks = [];
  // OpenAI 流式 tool_calls 分片到达，需按 index 累积拼装
  const accumulatedToolCalls = [];

  for await (const chunk of response) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    // 累积流式 tool_calls 分片
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!accumulatedToolCalls[idx]) {
          accumulatedToolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        }
        if (tc.id) accumulatedToolCalls[idx].id = tc.id;
        if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
      }
    }

    const thoughtToken = delta?.reasoning_content || delta?.thought;
    const contentToken = delta?.content || '';

    if (thoughtToken && onChunk) {
      if (typeof onChunk === 'function') onChunk('thought', thoughtToken);
      else if (onChunk.thought) onChunk.thought(thoughtToken);
    }
    if (contentToken) {
      chunks.push(contentToken);
      if (onChunk) {
        if (typeof onChunk === 'function') onChunk('content', contentToken);
        else if (onChunk.content) onChunk.content(contentToken);
      }
    }
  }

  const fullContent = chunks.join('');

  // 若要求回写，则把完整 assistant 消息推入 messages（有 tool_calls 时带上）：
  // - 保证 runWithTools 能通过读取最后一条 assistant 消息判断本轮是否产生工具调用
  // - 无 tool_calls 时也 push 普通 assistant 消息，避免 lastAssistant 解析到旧消息
  if (pushAssistantOnToolCalls) {
    const validCalls = accumulatedToolCalls.filter((tc) => tc && tc.id && tc.function?.name);
    messages.push({
      role: 'assistant',
      content: fullContent,
      ...(validCalls.length > 0 ? { tool_calls: validCalls } : {})
    });
  }

  return fullContent;
}

/**
 * 从模型输出中稳健提取 JSON 对象
 * - 剥离开头/结尾的 ```json 代码围栏
 * - 提取最外层平衡大括号内的内容
 * - 清理尾随逗号与注释后二次兜底解析
 */
export function parseJsonResponse(rawOutput) {
  let cleanText = (rawOutput || '').trim();
  if (!cleanText) throw new Error('模型输出为空');

  // 1. 清除 Markdown 代码块标记 ```json ... ```
  cleanText = cleanText.replace(/^```[a-zA-Z]*\n?/i, '').replace(/\n?```$/i, '').trim();

  // 2. 优先提取最外层平衡的 JSON 对象 {}
  const firstOpen = cleanText.indexOf('{');
  const lastClose = cleanText.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    const candidate = cleanText.substring(firstOpen, lastClose + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // 继续走下面的兜底逻辑
    }
  }

  // 3. 兜底：移除尾随逗号与注释
  const sanitized = cleanText
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*/g, '$1');
  return JSON.parse(sanitized);
}
