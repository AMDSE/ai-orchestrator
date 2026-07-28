# 🤖 AI 多智能体双脑协同编排系统 (AI Orchestrator)

> **策略脑 (Strategy Brain)** × **执行脑 (Executor Brain)** 双脑协同演进架构  
> 支持项目技能 (Project Skills) 动态炼化与接入、多项目独占 Session 隔离、多轮自动迭代质量审查、生成流实时打断与全量 HTML5 网页预览。

---

## 📂 项目文件架构全览

```text
ai-orchestrator/
├── 📄 start.bat               # Windows 一键启动脚本 (自动释放端口/启动Node/打开浏览器)
├── 📄 start.sh                # Linux/macOS 一键启动脚本
├── 📄 package.json            # 项目依赖与启动命令配置
├── 📄 package-lock.json       # 依赖锁文件
├── 📄 .env                    # 环境变量配置文件 (包含 API Key、Model、端口)
├── 📄 .env.example            # 环境变量配置模板
├── 📄 .gitignore              # Git 忽略配置
├── 📄 README.md               # 项目架构与全量开发指南文档
│
├── 📁 backend/                # 后端核心服务 (Node.js + Express + WebSocket)
│   ├── 📄 server.js           # HTTP/WebSocket 服务器入口、路由注册、SSE 炼化 API
│   ├── 📄 orchestrator.js     # 智能体编排器核心 (并发控制、生命周期管理、双脑状态机)
│   ├── 📄 skill-registry.js   # 技能注册中心 (动态读取 JSON 技能文件、热更新广播)
│   ├── 📄 skill-alchemist.js  # 技能炼化引擎 (Jina Reader 信源抓取 + 策略脑 LLM 提炼)
│   │
│   ├── 📁 agents/             # 双脑智能体桥接与驱动模块
│   │   ├── 📄 planner.js      # 策略脑驱动器 (需求拆解、任务规划、答疑、迭代终审)
│   │   ├── 📄 executor_bridge.js # 执行脑 Bridge (Antigravity Agent/CLI/外接 API 唤醒)
│   │   └── 📄 executor_bridge.py # Antigravity Python SDK 兼容执行桥接脚本
│   │
│   └── 📁 skills/             # 动态技能定义 JSON 存储目录
│       ├── 📄 bili_toy.skill.json     # 🎮 B站 Toy 互动规范技能
│       ├── 📄 standard_web.skill.json # 🌐 通用 Web 全栈技能
│       └── 📄 none.skill.json         # ⚪ 无特定技能框架模式
│
├── 📁 frontend/               # 前端 Web 玻璃态控制台
│   ├── 📄 index.html          # 主界面 HTML 结构 (包含双脑配置、技能炼化、项目列表与审查台)
│   ├── 📄 style.css           # 玻璃态 UI 样式表 (包含动画、暗黑主题、思考流面板、技能卡片)
│   └── 📄 app.js              # 前端交互逻辑 (WebSocket 实时同步、SSE 炼化通信、@ 指令路由)
│
├── 📁 scripts/                # 环境探针与自动化诊断脚本库
│   ├── 📄 check_status.ps1    # 检查进程与网络绑定状态
│   ├── 📄 find_ports.ps1      # 探针 3000 端口占用情况
│   ├── 📄 find_procs.ps1      # 过滤与定位 Node/Antigravity 进程 PID
│   ├── 📄 get_cmdline.ps1     # 提取后台进程完整启动命令行
│   ├── 📄 probe_api.ps1       # 测试后端 REST API 健康状态
│   ├── 📄 probe_https.ps1     # 测试模型接口 HTTPS 连通性
│   └── 📄 test_project.ps1    # 自动化模拟发送项目测试用例
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
| **`backend/orchestrator.js`** | **多智能体编排器** | 系统调度中枢。维护所有项目的生命周期状态机；控制最大并发项目数；绑定 `AbortController` 机制支持中断生成；调度【策略脑】与【执行脑】的多轮交互循环。 |
| **`backend/skill-registry.js`** | **技能注册中心** | 扫描与读取 `backend/skills/*.skill.json`；支持运行时热新增与删除技能；配合 `fs.watch` 在技能更新时自动通过 WebSocket 推送最新技能列表至前端。 |
| **`backend/skill-alchemist.js`** | **技能炼化引擎** | 整合 **Jina Reader API** (`r.jina.ai`) 抓取目标 URL/Markdown；调用策略脑提炼 `systemPrompt`、`qualityRules` 与 `forbiddenPatterns`；将新 Skill JSON 保存回技能库。 |

---

### 2. 🧠 双脑驱动引擎 (`backend/agents/`)

| 文件路径 | 模块职责 | 核心作用与逻辑说明 |
| :--- | :--- | :--- |
| **`backend/agents/planner.js`** | **策略脑 (Planner)** | 负责将用户的原始想法拆解为多步骤 `tasks`；在执行脑遇到技术瓶颈时提供答疑；每轮代码生成后对产物进行严格质量评估，决定是否开启下一轮迭代。 |
| **`backend/agents/executor_bridge.js`** | **执行脑 (Executor Bridge)** | 跨环境唤醒桥接器。支持拉起本地谷歌 **Antigravity CLI/Agent** 独占窗口与 Session，或使用 OpenAI 兼容外接 API；动态注入当前选中 Skill 的硬约束指令，将实体代码落盘至 `workspace/<projectId>/`。 |
| **`backend/agents/executor_bridge.py`** | **Python SDK 兼容桥** | 当环境使用 `google.antigravity` Python SDK 时，作为子进程提供 Python 级别的控制与返回值解析。 |

---

### 3. 🎯 技能定义库 (`backend/skills/`)

| 文件路径 | 技能名称 | 核心规范与作用 |
| :--- | :--- | :--- |
| **`bili_toy.skill.json`** | **🎮 B站 Toy 互动规范** | 强制要求相对路径 `./assets/`、Inline SVG / Base64 保底防白屏、无登录/无阻断直玩、根目录 `index.html` 标准发布格式。 |
| **`standard_web.skill.json`** | **🌐 通用 Web 全栈技能** | 强制 Mobile-first 双端自适应、Flexbox/Grid 现代布局、语义化 HTML5 标签。 |
| **`none.skill.json`** | **⚪ 无特定技能框架** | 自由编码模式，不注入任何平台硬性规则约束。 |

---

### 4. 💻 前端控制台 (`frontend/`)

| 文件路径 | 模块职责 | 核心作用与逻辑说明 |
| :--- | :--- | :--- |
| **`frontend/index.html`** | **控制台 DOM 结构** | 包含顶部健康灯、双脑模型配置折叠框、**🔮 技能炼化面板**、**🎯 项目技能选择器**、**⏹ 实时打断/介入栏**以及右侧成果预览审查台。 |
| **`frontend/style.css`** | **玻璃态视觉样式** | 使用 HSL 现代调色盘、CSS 变量、暗黑玻璃拟态；实现实时思考流折叠框、技能卡片高亮、中止按钮脉冲闪烁等动画。 |
| **`frontend/app.js`** | **全端交互逻辑** | WebSocket 实时数据绑定与 UI 局部渲染；响应 SSE 流式技能炼化过程；解析 `@策略脑` / `@执行脑` 定向指令路由；控制审查台 Iframe 预览。 |

---

### 5. 🛠️ 启动与探针工具 (`start.bat`, `start.sh`, `scripts/`)

| 文件路径 | 作用说明 |
| :--- | :--- |
| **`start.bat`** | Windows 一键启动脚本。自动清理 3000 端口占用，静默启动 Node 后端并自动拉起默认浏览器。 |
| **`start.sh`** | Linux/macOS 一键启动 Shell 脚本。 |
| **`scripts/*.ps1`** | 环境诊断探针。提供端口排查、进程 PID 追踪、API 连通性测试及自动化模拟用例。 |

---

## ⚡ 快速启动指南

### 方式一：Windows 双击一键启动 (推荐)
直接双击根目录下的 **`start.bat`** 即可：
1. 自动检测并清理 `3000` 端口旧进程。
2. 在后台静默拉起 Node.js 服务器。
3. 自动在默认浏览器中打开 `http://localhost:3000`。

---

### 方式二：命令行启动

```bash
# 1. 安装依赖
npm install

# 2. 复制并配置环境变量
cp .env.example .env

# 3. 启动项目
node backend/server.js
```
访问地址：[http://localhost:3000](http://localhost:3000)

---

## 📄 开源许可

[MIT License](LICENSE)
