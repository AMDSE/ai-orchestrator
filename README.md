# 🤖 AI 多智能体双脑协同编排系统 (AI Orchestrator)

> **策略脑 (Strategy Brain)** × **执行脑 (Executor Brain)** 双脑协同演进架构  
> 支持项目技能 (Project Skills) 插件化接入、多项目独占 Session 隔离、多轮自动迭代质量审查、生成流实时打断与全量 HTML5 网页预览。

---

## 📌 项目简介

**AI Orchestrator** 是一个基于 **Node.js + Express + WebSocket + Web 玻璃态控制台** 的 AI 多智能体 (Multi-Agent) 协同编排与可视化系统。系统专为拥有谷歌 **Antigravity IDE** 的开发者及创作人群设计，通过对 Antigravity 官方 CLI/Agent 接口进行深层封装与编排，实现了**低成本、全自动、高品质**的项目协同演进与代码构建。

系统核心采用 **双脑分离、动态项目技能 (Project Skills) 驱动与多轮迭代闭环架构**：
- 🔵 **策略脑 (Planner / Strategy Brain)**：作为顶层架构师，负责需求分析、方案拆解、答疑与每轮构建后的质量终审。
- 🟢 **执行脑 (Executor Brain)**：基于本地 Antigravity Agent（独占 IDE 窗口与 Agent 会话）或外接模型，负责全量实体代码构建与文件落盘。
- 🎯 **项目技能 (Project Skills Engine)**：在策略脑与执行脑中注入平台级规范与定制化技术栈规则（如 B站 Toy 互动游戏规范），确保生成产物 100% 契合目标平台的部署要求。

---

## ✨ 核心功能特性

### 1. 🎯 模块化项目技能系统 (Project Skills System)
- **启动按钮上方悬浮配置**：在 `🚀 启动项目` 按钮正上方内置【项目技能】配置下拉卡片，支持项目创建前快捷切换。
- **🎮 内置【bilibili Toy 互动游戏与 H5 发布规范】技能**：
  - **静态资源相对路径约束**：强制要求所有图片、CSS 与 JS 资源引用采用相对路径（如 `./assets/chara.png`），彻底解决 B站 Webview 托管环境下的 404 丢图与白屏问题。
  - **Data URL / Inline SVG 保底保障**：要求生成代码内置 SVG 或 Base64 备用资源，离开在线 CDN 也能流畅运行。
  - **无阻断体验**：严格禁止在代码中引入任何身份验证、登录门禁或阻断逻辑，确保应用启动直接可玩。
  - **合规打包结构**：产物结构自动遵循 B站 Toy 平台根目录 `index.html` + `assets/` 静态包目录规范。
- **🌐 扩展技能**：内置【通用 Web 全栈技能】与【自由编码模式】。

### 2. ⏹ 生成流实时打断与中止 (Stop Generation Flow)
- **底层 AbortController 机制**：每个项目运行独立绑定中断控制器，用户可在模型思考或生成代码的任意阶段主动触发打断。
- **动态呼吸呼吸灯指示**：项目正在生成时，介入栏自动弹出闪烁的 `⏹ 中止` 按钮，点击即可中断模型生成流并同步切换状态为 `⏹ 已中止`。

### 3. 💬 @ 智能体定向介入与路由 (Agent Targeting & Routing)
- **快捷键触发菜单**：在介入输入框中输入 `@` 符号，自动弹出可交互的候选选择菜单。
- **三大路由选项**：
  - 🔵 `@策略脑`：介入要求仅定向投递给策略脑（做架构调整、规划重构）。
  - 🟢 `@执行脑`：介入要求仅定向投递给执行脑（做局部代码修正、样式微调）。
  - ⚡ `@全体`：同时唤醒双脑协同调整。

### 4. 🔄 多轮自动迭代与质量审查闭环 (Iterative Review Loop)
- **自定义迭代轮数上限**：支持 1-10 轮自由调控（默认 3 轮）。策略脑在每轮构建完成后开展终审，若瑕疵未达标自动唤醒执行脑重跑修正。
- **硬性防“假完成”保障**：策略脑强效审查判定，若产物缺少实体代码或为纯文本概述，一律判定为【严重质量瑕疵】并强制重构。

### 5. 🪟 多窗口独占 Session 隔离 (Session & Workspace Isolation)
- **数据空间隔离**：按 Antigravity CLI 规范，每个项目拥有独立物理工作区 (`workspace/<projectId>/`) 与数据目录 (`userdata/<projectId>/`)。
- **多项目并发**：支持最多 3-6 个独立项目同时运行，并发窗口互相独立、数据 100% 隔离。

### 6. 🌐 审查台 HTML5 网页实时交互预览视窗
- **内置原生 Iframe 视窗**：在项目成果审查台中直接运行生成的 HTML5 应用，支持响应式调试、代码查看与多格式一键导出。

---

## 🛠️ 项目技能 (Project Skills) 开发与扩展教程

系统支持开发者自定义与扩展【项目技能 (Project Skills)】。下面详细说明项目技能的架构以及如何新建/扩充一项新的项目技能。

### 1. 项目技能的工作架构

```
用户在 UI 选择技能 (如 bili_toy)
   │
   ├─► 前端：传入 API POST /api/projects { selectedSkill: 'bili_toy' }
   │
   ├─► 编排器 (Orchestrator)：在 Project 实体中保存 selectedSkill
   │
   └─► 执行脑桥接器 (Executor Bridge)：
        buildExecutorPrompt(plan, task, plannerAnswer, selectedSkill)
        └─► 自动注入【bilibili Toy 平台交互规范技能 Prompt】
```

### 2. 教程：如何新建一项自定义项目技能

假设你想新建一个 **`📱 微信小程序 Web 适配技能`** 或 **`⚛️ React SPA 组件构建技能`**，只需完成以下 3 个简易步骤：

#### 第一步：在前端 `index.html` 添加技能下拉选项
打开 `frontend/index.html`，在 `skillDropdown` 内新增一个 `.skill-option` 块：

```html
<div class="skill-option" data-skill="wechat_mini" onclick="selectSkill('wechat_mini', '📱 微信小程序 H5 适配')">
  <div class="skill-option-header">
    <span class="skill-name">📱 微信小程序 H5 适配</span>
  </div>
  <div class="skill-desc">包含：WeUI 风格组件库规范、微信 JS-SDK 离线 Mock、Touch 事件适配。</div>
</div>
```

#### 第二步：在后端 `backend/agents/executor_bridge.js` 中注入技能 Prompt 模板
打开 `backend/agents/executor_bridge.js`，在 `buildExecutorPrompt` 函数中增加对应的技能提示词分支：

```js
export function buildExecutorPrompt(plan, task, plannerAnswer = null, selectedSkill = 'bili_toy') {
  // 1. 根据 selectedSkill 构建技能专属提示词
  let skillPrompt = '';
  
  if (selectedSkill === 'bili_toy') {
    skillPrompt = `
【🎮 bilibili Toy 平台交互规范技能（已启用）】
1. 所有静态资源必须采用相对路径引用（如 ./assets/chara.png）。
2. 保底防白屏机制：页面内必须包含内联 SVG 或 Data URL 备用资源。
3. 遵循 B端 Toy 打包与发布规范，可在最外层通过 index.html 打开。`;
  } else if (selectedSkill === 'wechat_mini') {
    skillPrompt = `
【📱 微信小程序 H5 适配技能（已启用）】
1. 使用 WeUI 视觉语言体系与 CSS 变量。
2. JS 中对 wx.ready() 及微信 JS-SDK 进行防报错降级封装。
3. 界面触控适配 touchstart / touchend 事件。`;
  }

  const dynamicInstruction = `${skillPrompt}

【绝对禁止 - 违反则任务失败】
❌ 禁止加入任何登录门禁或身份验证阻断流程。
❌ 禁止使用 dummyimage.com 等占位图服务。

【强制交付质量标准】
✅ 100% 完整输出实体代码，包裹在 Markdown 代码块中。`;

  return `项目：${plan?.title || '项目'}\n任务 ${task.id}：${task.title}\n描述：${task.description}${dynamicInstruction}`;
}
```

#### 第三步：(可选) 在后端逻辑中添加产物后处理或打包扩展
如果新技能需要生成专属格式的压缩包（如 `.zip` 包或特定的文件目录结构），可在 `executor_bridge.js` 的 `_saveToWorkspace(workspaceDir, codeText)` 方法中扩展存储与打包逻辑：

```js
// 例如根据 selectedSkill 自动创建 extra 静态子目录或写入技能说明文件
```

---

## 🚀 安装与启动教程

### 1. 克隆仓库与安装依赖
```bash
git clone <repository_url>
cd ai-orchestrator
npm install
```

### 2. 配置环境变量
复制配置文件模板 `.env.example` 为 `.env`：
```bash
cp .env.example .env
```
编辑 `.env` 填入你的配置：
```env
LONGCAT_API_KEY=your_actual_api_key_here
LONGCAT_BASE_URL=https://api.longcat.chat/openai
LONGCAT_MODEL=LongCat-2.0
PORT=3000
```
> ⚠️ **安全提示**：切勿将包含真实 API Key 的 `.env` 文件提交至公开仓库！

### 3. 启动项目服务器
```bash
npm start
```
控制台成功启动后显示：
```
╔════════════════════════════════════════════╗
║     🤖 AI 多智能体编排系统 已启动           ║
║     策略脑: LongCat-2.0                    ║
║     执行脑: Antigravity (本地)              ║
║     地址: http://localhost:3000           ║
╚════════════════════════════════════════════╝
```

### 4. 访问网页控制台
在浏览器中打开：[http://localhost:3000](http://localhost:3000) 即可使用。

---

## 📖 使用指南

1. **项目技能配置**：在创建项目卡片中，点击 `🚀 启动项目` 正上方的 `🎯 项目技能` 按钮，选择目标规范（默认：**🎮 B站 Toy 互动规范**）。
2. **模式与双脑配置**：选择标准或创意模式，在展开菜单中配置策略脑与执行脑的模型（自带或外接 API）以及联网检索开关。
3. **启动与监视**：输入项目想法并点击 `🚀 启动项目`，在实时面板中观察 Reasoning 推理思考流。
4. **实时打断**：若想停止生成，点击介入栏右侧的 `⏹ 中止` 按钮。
5. **定向介入**：在介入框中输入 `@` 可选择发送给策略脑或执行脑。
6. **审查与导出**：在成果审查台中体验应用，点击导出按钮进行代码及产物打包保存。

---

## 📄 开源许可

[MIT License](LICENSE)
