# 🤖 AI 双脑协同编排系统 (AI Orchestrator)

> **策略脑 (Strategy Brain) × 执行脑 (Executor Brain)** 双脑协同演进架构
>
> 🔵 **高性能模型担任策略脑**：顶层架构师，负责需求分析、方案拆解、答疑与质量终审。
> 🟢 **较低性能模型担任执行脑**：落地执行者，负责全量实体代码构建与文件落盘（低成本、高吞吐）。
>
> 双脑全部通过 **OpenAI 兼容外接 API** 驱动，支持项目技能 (Project Skills) 动态炼化与接入、多项目独占 Session 隔离、多轮自动迭代质量审查、生成流实时打断与全量 HTML5 网页预览。

---

## 📌 项目简介

**AI Orchestrator** 是一个基于 **Node.js + Express + WebSocket + Web 玻璃态控制台** 的 AI 多智能体 (Multi-Agent) 协同编排与可视化系统。系统采用 **双脑分离** 架构，将"思考规划"与"代码执行"拆分为两个独立智能体，并通过不同的模型配置实现**成本与质量的最优平衡**：

- 🔵 **策略脑 (Strategy Brain) — 高性能模型**：作为顶层架构师，承担高推理负载的规划、答疑与终审任务，保证方案的深度与质量。
- 🟢 **执行脑 (Executor Brain) — 较低性能模型**：作为落地执行者，承担高 token 消耗的代码生成任务。使用较低性能模型可显著降低成本、提高吞吐，同时配合策略脑的多轮质量审查闭环，保证最终产物质量不降级。

系统核心采用 **双脑分离、动态项目技能 (Project Skills) 驱动与多轮迭代闭环架构**：
- 🔵 **策略脑 (Planner / Strategy Brain)**：顶层架构师，负责需求分析、方案拆解、答疑与每轮构建后的质量终审。
- 🟢 **执行脑 (Executor Brain)**：基于外接 API 模型，负责全量实体代码构建与文件落盘。
- 🎯 **项目技能 (Project Skills Engine)**：在策略脑与执行脑中注入平台级规范与定制化技术栈规则（如 B站 Toy 互动游戏规范），确保生成产物 100% 契合目标平台的部署要求。

---

## ✨ 核心功能特性

### 1. 🧠 双脑模型分离配置（高性能 × 低成本）
- **策略脑**：默认推荐 `gpt-4o` 等高性能模型，承担规划、推理、答疑与质量终审。

---

## 📂 项目文件架构全览

```text
ai-orchestrator/
├── 📄 start.bat               # Windows 一键启动脚本 (自动释放端口/启动Node/打开浏览器)
├── 📄 start.sh                # Linux/macOS 一键启动脚本
├── 📄 package.json            # 项目依赖与启动命令配置
├── 📄 .env.example            # 环境变量配置模板 (双脑外接 API 凭据)
├── 📄 .gitignore              # Git 忽略配置
├── 📄 README.md               # 项目架构与全量开发指南文档
│
├── 📁 backend/                # 后端核心服务 (Node.js + Express + WebSocket)
│   ├── 📄 server.js           # HTTP/WebSocket 服务器入口、路由注册、SSE 炼化 API
│   ├── 📄 orchestrator.js     # 智能体编排器核心 (并发控制、生命周期管理、双脑状态机)
│   ├── 📄 skill-registry.js   # 技能注册中心 (动态读取 JSON 技能文件、热更新广播)
│   ├── 📄 skill-alchemist.js  # 技能炼化引擎 (Jina Reader 信源抓取 + 策略脑 LLM 提炼)
│   ├── 📁 lib/
│   │   └── 📄 llm.js          # 统一 LLM 客户端工厂 (双脑外接 API、流式封装、JSON 稳健解析)
│   ├── 📁 agents/             # 双脑智能体桥接与驱动模块
│   │   ├── 📄 planner.js      # 策略脑驱动器 (高性能模型：需求拆解、任务规划、答疑、迭代终审)
│   │   └── 📄 executor_bridge.js # 执行脑驱动器 (较低性能模型：外接 API 代码构建与落盘)
│   └── 📁 skills/             # 动态技能定义 JSON 存储目录
│       ├── 📄 bili_toy.skill.json # 🎮 B站 Toy 互动规范技能
│       ├── 📄 standard_web.skill.json # 🌐 通用 Web 全栈技能
│       └── 📄 none.skill.json # ⚪ 无特定技能框架模式
│
├── 📁 frontend/               # 前端 Web 玻璃态控制台
│   ├── 📄 index.html          # 主界面 HTML 结构 (双脑外接 API 配置、技能炼化、项目列表与审查台)
│   ├── 📄 style.css           # 玻璃态 UI 样式表 (动画、暗黑主题、思考流面板、技能卡片)
│   └── 📄 app.js              # 前端交互逻辑 (WebSocket 实时同步、SSE 炼化通信、@ 指令路由)
│
├── 📁 workspace/              # 项目独立代码构建产物物理输出目录 (自动按 projectId 隔离)
└── 📁 userdata/               # 独立项目运行会话数据目录 (按 projectId 隔离)
```

---

## 🗂️ 核心模块与文件职责详解

### 1. ⚙️ 后端核心 (`backend/`)

| 文件路径 | 模块职责 | 核心作用与逻辑说明 |
| :--- | :--- | :--- |
| **`backend/server.js`** | **服务总入口** | 搭建 Express HTTP 服务与 WebSocket 全双工通道；处理 `/api/projects` 项目 CRUD；提供 `/api/skill-alchemy/run` SSE 流式技能炼化接口；集成 `SkillRegistry` 热更新广播。 |
| **`backend/orchestrator.js`** | **多智能体编排器** | 系统调度中枢。维护所有项目的生命周期状态机；控制最大并发项目数；绑定 `AbortController` 机制支持中断生成；调度【策略脑】与【执行脑】的多轮交互循环；单任务失败自动重试。 |
| **`backend/lib/llm.js`** | **统一 LLM 工厂** | 统一管理双脑的 OpenAI 兼容外接 API 客户端；提供流式对话封装（自动提取思考流/内容流）、稳健 JSON 解析、环境变量默认配置回退。 |
| **`backend/skill-registry.js`** | **技能注册中心** | 扫描与读取 `backend/skills/*.skill.json`；支持运行时热新增与删除技能；配合 `fs.watch` 在技能更新时自动通过 WebSocket 推送最新技能列表至前端。 |
| **`backend/skill-alchemist.js`** | **技能炼化引擎** | 整合 **Jina Reader API** (`r.jina.ai`) 抓取目标 URL/Markdown；调用策略脑提炼 `systemPrompt`、`qualityRules` 与 `forbiddenPatterns`；将新 Skill JSON 保存回技能库。 |

### 2. 🧠 双脑驱动引擎 (`backend/agents/`)

| 文件路径 | 模块职责 | 核心作用与逻辑说明 |
| :--- | :--- | :--- |
| **`backend/agents/planner.js`** | **策略脑 (Planner)** | 使用**高性能模型**。负责将用户的原始想法拆解为多步骤 `tasks`；在执行脑遇到技术瓶颈时提供答疑；每轮代码生成后对产物进行严格质量评估，决定是否开启下一轮迭代。 |
| **`backend/agents/executor_bridge.js`** | **执行脑 (Executor Bridge)** | 使用**较低性能模型**。通过 OpenAI 兼容外接 API 执行任务；动态注入当前选中 Skill 的 `systemPrompt` / `qualityRules` / `forbiddenPatterns` 硬约束指令；支持多代码块自动拆分落盘至 `workspace/<projectId>/`。 |

---

## ⚡ 快速启动指南

### 方式一：Windows 双击一键启动 (推荐)
直接双击根目录下的 **`start.bat`** 即可：
1. 自动检测并清理 `3000` 端口旧进程。
2. 在后台静默拉起 Node.js 服务器。
3. 自动在默认浏览器中打开 `http://localhost:3000`。

### 方式二：命令行启动

```bash
# 1. 安装依赖
npm install

# 2. 复制并配置环境变量（填入双脑外接 API 凭据）
cp .env.example .env

# 3. 启动项目
node backend/server.js
```

访问地址：[http://localhost:3000](http://localhost:3000)

### 环境变量说明

| 变量 | 作用 | 示例 |
| :--- | :--- | :--- |
| `STRATEGY_API_KEY` | 策略脑外接 API Key | `sk-...` |
| `STRATEGY_BASE_URL` | 策略脑服务 Base URL | `https://api.openai.com/v1` |
| `STRATEGY_MODEL` | 策略脑高性能模型 | `gpt-4o` |
| `EXECUTOR_API_KEY` | 执行脑外接 API Key | `sk-...` |
| `EXECUTOR_BASE_URL` | 执行脑服务 Base URL | `https://api.openai.com/v1` |
| `EXECUTOR_MODEL` | 执行脑较低性能模型 | `gpt-4o-mini` |
| `PORT` | 服务端口 | `3000` |

> 💡 也可以在 Web 控制台的【⚙️ 启动模型与外接 API 设置】中为每个项目单独填写双脑的 `Base URL` / `API Key` / `Model`，优先级高于环境变量。

---

## 📖 使用指南

1. **项目技能配置**：在创建项目卡片中，点击 `🚀 启动项目` 正上方的 `🎯 项目技能` 按钮，选择目标规范（默认：**🎮 B站 Toy 互动规范**）。
2. **技能在线炼化**：如需新增技能，展开 `🔮 技能炼化 (Skill Alchemy)` 面板，填入官方文档 URL 后点击 `✨ 提取信源并炼化 Skill`，新技能会自动添加到技能栏。
3. **双脑外接 API 配置**：展开【⚙️ 启动模型与外接 API 设置】，分别填写策略脑（高性能模型）与执行脑（较低性能模型）的 `Base URL`、`API Key` 与 `Model`，并设置迭代轮数上限。
4. **启动与监视**：输入项目想法并点击 `🚀 启动项目`，在实时面板中观察 Reasoning 推理思考流。
5. **实时打断**：若想停止生成，点击介入栏右侧的 `⏹ 中止` 按钮。
6. **定向介入**：在介入框中输入 `@` 可选择发送给策略脑或执行脑。
7. **审查与导出**：在成果审查台中体验应用，点击导出按钮进行代码及产物打包保存，或点击 🌐 在新窗口全屏预览。

---

## 📄 开源许可

[MIT License](LICENSE)


### 3. 🎯 技能定义库 (`backend/skills/`)

| 文件路径 | 技能名称 | 核心规范与作用 |
| :--- | :--- | :--- |
| **`bili_toy.skill.json`** | **🎮 B站 Toy 互动规范** | 强制要求相对路径 `./assets/`、Inline SVG / Base64 保底防白屏、无登录/无阻断直玩、根目录 `index.html` 标准发布格式。 |
| **`standard_web.skill.json`** | **🌐 通用 Web 全栈技能** | 强制 Mobile-first 双端自适应、Flexbox/Grid 现代布局、语义化 HTML5 标签。 |
| **`none.skill.json`** | **⚪ 无特定技能框架** | 自由编码模式，不注入任何平台硬性规则约束。 |

### 4. 💻 前端控制台 (`frontend/`)

| 文件路径 | 模块职责 | 核心作用与逻辑说明 |
| :--- | :--- | :--- |
| **`frontend/index.html`** | **控制台 DOM 结构** | 包含顶部健康灯、双脑外接 API 配置折叠框、**🔮 技能炼化面板**、**🎯 项目技能选择器**、**⏹ 实时打断/介入栏**以及右侧成果预览审查台。 |
| **`frontend/style.css`** | **玻璃态视觉样式** | 使用 HSL 现代调色盘、CSS 变量、暗黑玻璃拟态；实现实时思考流折叠框、技能卡片高亮、中止按钮脉冲闪烁等动画。 |
| **`frontend/app.js`** | **全端交互逻辑** | WebSocket 实时数据绑定与 UI 局部渲染；响应 SSE 流式技能炼化过程；解析 `@策略脑` / `@执行脑` 定向指令路由；控制审查台 Iframe 预览与新窗口全屏运行。 |

### 5. 🛠️ 启动工具 (`start.bat`, `start.sh`)

| 文件路径 | 作用说明 |
| :--- | :--- |
| **`start.bat`** | Windows 一键启动脚本。自动清理 3000 端口占用，静默启动 Node 后端并自动拉起默认浏览器。 |
| **`start.sh`** | Linux/macOS 一键启动 Shell 脚本。 |

- **执行脑**：默认推荐 `gpt-4o-mini` / `deepseek-chat` 等较低性能模型，承担高频代码生成。
- **全部外接 API**：双脑均通过 OpenAI 兼容接口（自定义 `Base URL` + `API Key` + `Model`）接入，兼容 OpenAI / DeepSeek / SiliconFlow / 通义千问 / Kimi 等任意 OpenAI 兼容服务，无任何内置或本地模型依赖。
- 支持在界面中为每个项目单独指定策略脑/执行脑的模型、Base URL 与 API Key。

### 2. 🎯 模块化项目技能系统 (Project Skills System)
- **启动按钮上方悬浮配置**：在 `🚀 启动项目` 按钮正上方内置【项目技能】配置下拉卡片，支持项目创建前快捷切换。
- **🎮 内置【bilibili Toy 互动游戏与 H5 发布规范】技能**：
  - **静态资源相对路径约束**：强制要求所有图片、CSS 与 JS 资源引用采用相对路径（如 `./assets/chara.png`），彻底解决 B站 Webview 托管环境下的 404 丢图与白屏问题。
  - **Data URL / Inline SVG 保底保障**：要求生成代码内置 SVG 或 Base64 备用资源，离开在线 CDN 也能流畅运行。
  - **无阻断体验**：严格禁止在代码中引入任何身份验证、登录门禁或阻断逻辑，确保应用启动直接可玩。
  - **合规打包结构**：产物结构自动遵循 B站 Toy 平台根目录 `index.html` + `assets/` 静态包目录规范。
- **🌐 扩展技能**：内置【通用 Web 全栈技能】与【自由编码模式】。

### 3. 🔮 技能炼化 (Skill Alchemy) 与动态技能库
- **零安装爬虫**：默认内置 `Jina Reader` API (`r.jina.ai`) 抓取任意 URL 转换为 Markdown，支持 GitHub Raw 仓库抓取，可扩展 `Crawlee` (npm)。
- **炼化 Pipeline**：策略脑自动抽取规范中的：
  - 核心 System Prompt（代码生成硬约束）
  - 质量校验规则 (`qualityRules`)
  - 绝对禁止项 (`forbiddenPatterns`)
- **热加载与存储**：炼化产物自动保存为 `backend/skills/{skillId}.skill.json`，无需重启服务，全端 WebSocket 实时刷出新技能项。
- **技能注入优化**：执行脑 System Prompt = 通用执行基线 + 选中技能 `systemPrompt` + `qualityRules` + `forbiddenPatterns` 三重动态注入，技能约束 100% 生效。

### 4. ⏹ 生成流实时打断与中止 (Stop Generation Flow)
- **底层 AbortController 机制**：每个项目运行独立绑定中断控制器，用户可在模型思考或生成代码的任意阶段主动触发打断。
- **动态呼吸灯指示**：项目正在生成时，介入栏自动弹出闪烁的 `⏹ 中止` 按钮，点击即可中断模型生成流并同步切换状态为 `⏹ 已中止`。

### 5. 💬 @ 智能体定向介入与路由 (Agent Targeting & Routing)
- **快捷键触发菜单**：在介入输入框中输入 `@` 符号，自动弹出可交互的候选选择菜单。
- **三大路由选项**：
  - 🔵 `@策略脑`：介入要求仅定向投递给策略脑（做架构调整、规划重构）。
  - 🟢 `@执行脑`：介入要求仅定向投递给执行脑（做局部代码修正、样式微调）。
  - ⚡ `@全体`：同时唤醒双脑协同调整。

### 6. 🔄 多轮自动迭代与质量审查闭环 (Iterative Review Loop)
- **自定义迭代轮数上限**：支持 1-10 轮自由调控（默认 3 轮）。策略脑在每轮构建完成后开展终审，若瑕疵未达标自动唤醒执行脑重跑修正。
- **硬性防"假完成"保障**：策略脑强效审查判定，若产物缺少实体代码或为纯文本概述，一律判定为【严重质量瑕疵】并强制重构。
- **执行鲁棒性优化**：单任务失败自动重试一次；多代码块产物自动拆分为多个实体文件落盘；HTML 输出被截断时自动补全 DOM 闭合与加载保底。

### 7. 🪟 多项目 Session 隔离 (Session & Workspace Isolation)
- **数据空间隔离**：每个项目拥有独立物理工作区 (`workspace/<projectId>/`) 与数据目录 (`userdata/<projectId>/`)。
- **多项目并发**：支持最多 3-6 个独立项目同时运行，并发项目互相独立、数据 100% 隔离。

### 8. 🌐 审查台 HTML5 网页实时交互预览视窗
- **内置原生 Iframe 视窗**：在项目成果审查台中直接运行生成的 HTML5 应用，支持响应式调试、代码查看、多格式一键导出与**新窗口全屏预览**。
