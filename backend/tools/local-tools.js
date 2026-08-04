// backend/tools/local-tools.js
// 本地资源能力工具集：供策略脑 / 执行脑通过 tool-calling 实时调用本地能力
// 安全设计：所有路径操作限制在"项目工作区/workspace"根目录内（防越权读取任意文件）
// run_local_command 仅允许白名单命令

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 允许的命令前缀白名单（安全边界：避免任意命令执行）
const SAFE_COMMAND_ALLOWLIST = [
  'node --version', 'node -v',
  'npm --version', 'npm -v',
  'git --version', 'git -v',
  'python --version', 'python -V',
  'python3 --version', 'python3 -V',
  'dir', 'ls', 'pwd', 'whoami',
  'echo',
  'npm list',
];

/**
 * 工具定义（OpenAI function calling schema）
 */
export const LOCAL_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_local_file',
      description: '读取本地文件内容（UTF-8 文本，上限 100KB）。用于查看项目工作区中的已有代码/配置文件。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '相对于项目工作区的文件路径，如 "src/app.js"；或绝对路径（仅限工作区内部）' },
          maxChars: { type: 'number', description: '最多返回字符数，默认 30000', default: 30000 }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_local_file',
      description: '写入/创建本地文件（UTF-8 文本）。用于将代码直接落盘到项目工作区，自动创建父目录。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '相对于项目工作区的文件路径，如 "src/app.js"；或绝对路径（仅限工作区内部）' },
          content: { type: 'string', description: '完整的文件内容' }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_local_directory',
      description: '列出本地目录中的文件和子目录（一层）。用于了解项目工作区结构。',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '相对于项目工作区的目录路径，如 "src"；不传则列出根目录' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_local_command',
      description: '在本地系统执行受安全白名单限制的命令（如 node --version、npm --version、git --version、python --version、列出目录等）。不能执行任意系统命令。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令（必须是白名单内命令）' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '真实联网搜索（DuckDuckGo / Bing），获取最新的网络资讯、技术文档与行业最佳实践。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（中文或英文）' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_image_assets',
      description: '检索高精免费图片资源（Wikimedia Commons 真实检索，失败回退内置素材库），返回可直接用于 <img>/CSS 的图片 URL 列表。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '图片主题关键词，如"游戏背景"、"萌宠立绘"' }
        },
        required: ['query']
      }
    }
  }
];

/**
 * 计算工作区绝对路径根（由 orchestrator 注入当前运行目录）
 * @type {function(string): string}
 */
let resolveWorkspaceRoot = (relOrAbs) => {
  // 默认安全根：D 盘 ai-orchestrator/workspace
  return path.join(__dirname, '..', '..', 'workspace');
};

/**
 * 注入工作区根目录解析函数（由 orchestrator 调用，绑定项目 workDir）
 */
export function setWorkspaceResolver(fn) {
  if (typeof fn === 'function') resolveWorkspaceRoot = fn;
}

/**
 * 将工具入参中的路径安全解析为绝对路径（限制在工作区根内）
 */
function safeResolvePath(workspaceRoot, inputPath) {
  if (!inputPath) return workspaceRoot;
  let abs;
  if (path.isAbsolute(inputPath)) {
    abs = path.resolve(inputPath);
  } else {
    abs = path.resolve(workspaceRoot, inputPath);
  }
  // 越权保护：绝对路径必须位于 workspaceRoot 之内
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!abs.startsWith(normalizedRoot + path.sep) && abs !== normalizedRoot) {
    throw new Error(`⛔ 路径越权拒绝: ${inputPath} 超出工作区安全边界 (${normalizedRoot})`);
  }
  return abs;
}

/**
 * 执行本地工具调用
 * @param {string} name 工具名
 * @param {object} args 工具参数
 * @param {object} ctx { workspaceRoot, onToolEvent }
 * @returns {Promise<string>} 工具执行结果文本（会回传给模型）
 */
export async function executeLocalTool(name, args, ctx = {}) {
  const workspaceRoot = (ctx && ctx.workspaceRoot) || resolveWorkspaceRoot();
  const workspaceRootAbs = path.resolve(workspaceRoot);

  switch (name) {
    case 'read_local_file': {
      const abs = safeResolvePath(workspaceRootAbs, args.filePath);
      if (!fs.existsSync(abs)) return `❌ 文件不存在: ${args.filePath}`;
      if (fs.statSync(abs).isDirectory()) return `❌ 这是目录，请使用 list_local_directory: ${args.filePath}`;
      const maxChars = Number(args.maxChars) || 30000;
      const content = fs.readFileSync(abs, 'utf-8');
      const truncated = content.length > maxChars
        ? content.substring(0, maxChars) + `\n...[内容过长，已截断，共 ${content.length} 字符]...`
        : content;
      return `📄 文件 ${args.filePath} (${Buffer.byteLength(content, 'utf-8')} 字节):\n\`\`\`\n${truncated}\n\`\`\``;
    }

    case 'write_local_file': {
      const abs = safeResolvePath(workspaceRootAbs, args.filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content, 'utf-8');
      const size = Buffer.byteLength(args.content, 'utf-8');
      if (ctx && typeof ctx.onToolEvent === 'function') {
        ctx.onToolEvent({ type: 'write', path: args.filePath, size });
      }
      return `✅ 已成功写入文件 ${args.filePath} (${size} 字节)`;
    }

    case 'list_local_directory': {
      const abs = safeResolvePath(workspaceRootAbs, args.dirPath || '');
      if (!fs.existsSync(abs)) return `❌ 目录不存在: ${args.dirPath || '.'}`;
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      if (entries.length === 0) return `📂 目录为空: ${args.dirPath || '.'}`;
      const lines = entries.map((e) => {
        if (e.isDirectory()) return `📁 ${e.name}/`;
        try {
          const stat = fs.statSync(path.join(abs, e.name));
          return `📄 ${e.name} (${stat.size} B)`;
        } catch { return `📄 ${e.name}`; }
      });
      return `📂 目录 ${args.dirPath || '.'} 内容 (${entries.length} 项):\n${lines.join('\n')}`;
    }

    case 'run_local_command': {
      const cmd = (args.command || '').trim();
      const allowed = SAFE_COMMAND_ALLOWLIST.some((prefix) => cmd.startsWith(prefix));
      if (!allowed) {
        return `⛔ 命令不在安全白名单内，拒绝执行: ${cmd}\n允许的命令: ${SAFE_COMMAND_ALLOWLIST.join(' | ')}`;
      }
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: workspaceRootAbs,
          timeout: 15000,
          windowsHide: true
        });
        return `▶️ 命令: ${cmd}\n--- stdout ---\n${(stdout || '').slice(0, 4000)}\n--- stderr ---\n${(stderr || '').slice(0, 1000)}`;
      } catch (e) {
        return `❌ 命令执行失败: ${cmd}\n${e.stderr || e.message}`;
      }
    }

    case 'web_search': {
      try {
        const { searchWeb } = await import('../services/search_service.js');
        const result = await searchWeb(args.query || '');
        return result;
      } catch (e) {
        return `❌ 联网搜索失败: ${e.message}`;
      }
    }

    case 'search_image_assets': {
      try {
        const { searchImageAssets } = await import('../services/search_service.js');
        const result = await searchImageAssets(args.query || '');
        return result;
      } catch (e) {
        return `❌ 图片检索失败: ${e.message}`;
      }
    }

    default:
      return `❌ 未知本地工具: ${name}`;
  }
}

/**
 * 供 server.js 使用的 REST 快照：列出当前所有可用工具（前端展示）
 */
export function getAvailableLocalTools() {
  return LOCAL_TOOL_DEFINITIONS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  }));
}