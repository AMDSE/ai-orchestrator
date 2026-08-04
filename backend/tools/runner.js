// backend/tools/runner.js
// 工具调用运行器：包装 OpenAI tool-calling 流式对话，在生成过程中
// 自动解析模型的 function_call，执行本地工具，将结果回传模型继续生成。
// 兼容 AbortSignal 中断、思考流/内容流回调。

import { streamChat } from '../lib/llm.js';
import { executeLocalTool } from './local-tools.js';

/**
 * 运行一次带本地工具能力的流式对话（OpenAI tool-calling）
 * @param {object} options
 * @param {import('openai').OpenAI} options.client
 * @param {string} options.model
 * @param {Array} options.messages 模型消息数组（会 push 工具调用相关消息）
 * @param {object} options.tools 工具定义数组（LOCAL_TOOL_DEFINITIONS）
 * @param {object} options.toolContext { workspaceRoot, onToolEvent } 传给工具执行器
 * @param {number} [options.temperature]
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.onChunk] (type:'thought'|'content', token)=>void
 * @param {function} [options.onToolCall] (toolName, args)=>{}
 * @param {number} [options.maxToolCalls=8] 单轮对话最大工具调用次数防止死循环
 * @returns {Promise<{content:string, toolCalls:Array}>} 最终拼接内容与工具调用记录
 */
export async function runWithTools({
  client,
  model,
  messages,
  tools,
  toolContext = {},
  temperature = 0.6,
  signal = null,
  onChunk = null,
  onToolCall = null,
  maxToolCalls = 8
}) {
  const toolCalls = [];
  let totalContent = '';
  let toolCallCount = 0;

  // 上一轮是否产生了 tool_calls（决定下一轮是否继续允许调用工具）
  let hadToolCalls = false;

  do {
    hadToolCalls = false;

    // 若已达工具调用上限，强制要求模型直接答复（不加 tools 参数）
    const useTools = tools && toolCallCount < maxToolCalls ? tools : undefined;

    const content = await streamChat({
      client,
      model,
      messages,
      temperature,
      signal,
      tools: useTools,
      pushAssistantOnToolCalls: true, // 若模型发出 tool_calls，将完整 assistant 消息回写 messages
      onChunk
    });

    totalContent += content;

    // 从 messages 中读取上轮 push 的 assistant tool_calls
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const pendingCalls = lastAssistant?.tool_calls?.filter((tc) => tc.type === 'function') || [];

    if (pendingCalls.length === 0) break;
    hadToolCalls = true;

    // 执行本轮所有工具调用
    for (const call of pendingCalls) {
      const fnName = call.function?.name || '';
      let fnArgs = {};
      try { fnArgs = JSON.parse(call.function?.arguments || '{}'); } catch { fnArgs = {}; }

      toolCallCount++;
      if (onToolCall) onToolCall(fnName, fnArgs);

      let resultText;
      try {
        resultText = await executeLocalTool(fnName, fnArgs, toolContext);
      } catch (err) {
        resultText = `❌ 工具执行异常: ${err.message}`;
      }

      toolCalls.push({ name: fnName, args: fnArgs, result: resultText });

      // 将工具结果作为 function 角色消息回传模型（继续下一轮生成）
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: resultText
      });
    }
  } while (hadToolCalls && toolCallCount < maxToolCalls && !signal?.aborted);

  return { content: totalContent, toolCalls };
}