#!/usr/bin/env python3
# backend/agents/executor_bridge.py
# 执行脑桥接器：通过 Antigravity Python SDK 在本地运行执行脑
# 接收来自 Node.js 编排器的任务，通过 stdin/stdout 通信

import asyncio
import json
import sys
import os
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

EXECUTOR_SYSTEM_PROMPT = """你是一个高效的AI项目执行者（执行脑），你的职责是：

1. 按照策略脑制定的任务计划逐步执行
2. 输出具体、完整的成果（代码/文档/分析/设计方案等）
3. 遇到真正无法确定的歧义时，用特定格式提问（不要随便提问，先尽力执行）
4. 完成后给出清晰的完成报告
5. 【联网搜索】你的联网检索与实时数据获取功能已始终开启！遇到最新库版本、API变动、技术方案或在线数据时，请主动检索获取最新真实信息。

当你需要向策略脑提问时，必须使用以下格式：
[QUESTION_TO_PLANNER]
问题：你的具体问题
背景：当前执行的任务和遇到的困难
[/QUESTION_TO_PLANNER]

当你完成一个任务时，使用以下格式：
[TASK_COMPLETE]
任务ID：X
成果：具体输出内容
[/TASK_COMPLETE]

当所有任务完成时，使用：
[PROJECT_COMPLETE]
总结：整个项目的完成情况
[/PROJECT_COMPLETE]

保持专注、高效，用中文回复。"""


async def run_executor(task_data: dict) -> None:
    """运行执行脑处理单个任务"""
    model_name = task_data.get('model', 'gemini-3.6-flash')
    exec_cfg = task_data.get('executorConfig', {})
    web_search = exec_cfg.get('webSearch', True)

    search_instr = "5. 【联网搜索】联网检索与实时数据获取功能已开启！请积极检索获取最新真实信息。" if web_search else "5. 【联网搜索】联网检索已关闭。请基于内置模型知识执行任务，不使用外部检索。"
    sys_prompt = EXECUTOR_SYSTEM_PROMPT.replace("5. 【联网搜索】.*", search_instr)

    try:
        config = LocalAgentConfig(
            system_instructions=sys_prompt,
            capabilities=CapabilitiesConfig(),
            model=model_name
        )
    except TypeError:
        config = LocalAgentConfig(
            system_instructions=sys_prompt,
            capabilities=CapabilitiesConfig(),
        )

    async with Agent(config) as agent:
        project_id = task_data.get('projectId', 'unknown')
        task = task_data.get('task', {})
        planner_answer = task_data.get('plannerAnswer', None)

        # 构建执行提示
        if planner_answer:
            prompt = f"""策略脑回答了你之前的问题：

{planner_answer}

请继续执行之前的任务。"""
        else:
            plan = task_data.get('plan', {})
            task_list = '\n'.join([
                f"  {t['id']}. {t['title']}: {t['description']}"
                for t in plan.get('tasks', [])
            ])
            prompt = f"""项目：{plan.get('title', '未命名项目')}
项目简述：{plan.get('summary', '')}

完整任务列表：
{task_list}

当前需要执行：任务 {task.get('id', 1)} - {task.get('title', '')}
任务描述：{task.get('description', '')}
预期输出：{task.get('expected_output', '')}

请开始执行此任务。如果遇到无法确定的问题，使用 [QUESTION_TO_PLANNER] 格式提问。"""

        # 发送执行请求并流式输出
        response = await agent.chat(prompt)

        full_response = []
        async for token in response:
            full_response.append(token)
            # 实时输出 token 到 stdout
            msg = json.dumps({
                'type': 'token',
                'projectId': project_id,
                'taskId': task.get('id', 1),
                'token': token
            })
            print(msg, flush=True)

        complete_text = ''.join(full_response)

        # 检查是否有提问
        if '[QUESTION_TO_PLANNER]' in complete_text:
            import re
            match = re.search(
                r'\[QUESTION_TO_PLANNER\](.*?)\[/QUESTION_TO_PLANNER\]',
                complete_text,
                re.DOTALL
            )
            if match:
                question_block = match.group(1).strip()
                result = json.dumps({
                    'type': 'question',
                    'projectId': project_id,
                    'taskId': task.get('id', 1),
                    'question': question_block
                })
                print(result, flush=True)
                return

        # 检查任务/项目完成
        if '[PROJECT_COMPLETE]' in complete_text:
            import re
            match = re.search(
                r'\[PROJECT_COMPLETE\](.*?)\[/PROJECT_COMPLETE\]',
                complete_text,
                re.DOTALL
            )
            summary = match.group(1).strip() if match else complete_text
            result = json.dumps({
                'type': 'project_complete',
                'projectId': project_id,
                'summary': summary
            })
            print(result, flush=True)
        elif '[TASK_COMPLETE]' in complete_text:
            import re
            match = re.search(
                r'\[TASK_COMPLETE\](.*?)\[/TASK_COMPLETE\]',
                complete_text,
                re.DOTALL
            )
            output = match.group(1).strip() if match else complete_text
            result = json.dumps({
                'type': 'task_complete',
                'projectId': project_id,
                'taskId': task.get('id', 1),
                'output': output
            })
            print(result, flush=True)
        else:
            # 普通完成
            result = json.dumps({
                'type': 'task_complete',
                'projectId': project_id,
                'taskId': task.get('id', 1),
                'output': complete_text
            })
            print(result, flush=True)


def main():
    # 从 stdin 读取任务数据（Node.js 发送过来的 JSON）
    input_data = sys.stdin.read()
    try:
        task_data = json.loads(input_data)
    except json.JSONDecodeError as e:
        error = json.dumps({'type': 'error', 'message': f'JSON解析失败: {str(e)}'})
        print(error, flush=True)
        sys.exit(1)

    asyncio.run(run_executor(task_data))


if __name__ == '__main__':
    main()
