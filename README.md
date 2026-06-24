# AI Daily Dock · Electron 桌面应用

把 Open Design 生成的 **Web Prototype**（桌面悬浮 AI 协作计划面板）改造成 **Windows 桌面悬浮应用**。

---

## 🚀 快速启动

### 1. 启动桌面应用
```bash
npm install
npm start          # 或 npx electron .
```

### 2. 启动 AI 分发规划服务（可选，用于智能分发台）
```bash
cd agent-server
npm install
# 设置 API Key（DeepSeek 或其他 OpenAI 兼容服务）
set PI_API_KEY=你的API密钥
# 或 set DEEPSEEK_API_KEY=你的DeepSeek密钥
npm run dev
```
服务启动后访问 http://localhost:3874/api/health 检查状态。

如果不启动 agent-server，AI 分发台会自动降级为三步法头脑风暴模式。

---

## 📋 项目结构

| 文件/目录 | 说明 |
| --- | --- |
| `dock.html` | 主面板 UI（单文件，HTML+CSS+JS；含 compact/board/expanded/focus 四态切换与白板交互） |
| `main.js` | Electron 主进程（建窗、托盘、IPC、安全加固、CLI named-pipe 服务、全局快捷键） |
| `preload.js` | 安全预加载（contextBridge 白名单 API） |
| `aiService.js` | AI 能力隔离层（任务拆解、多视角头脑风暴、逐步执行、复盘） |
| `agentBridge.js` | Hermes 风格本地 Agent 桥接（检测/调用 Claude Code、Codex 等，支持取消杀进程树） |
| `dataService.js` | 主进程统一数据层（tasks.json 等 JSON 文件管理，原子写 + 防抖 + 缓存） |
| `src/shared/perspectives.js` | 三视角头脑风暴的**唯一真值**（aiService 与 agent-server 共用，避免分叉） |
| `src/renderer/js/state/taskStore.js` | 渲染层纯数据层（CRUD/持久化/归档/拓扑排序/迁移） |
| `src/renderer/js/ai/dispatchClient.js` | AI 分发弹窗 + 调 agent-server + 生成白板卡 |
| `src/renderer/js/ui/renderTasks.js` | 任务列表 UI 渲染层 |
| `settings.html` | 设置页（AI 模型选择、API Key 配置） |
| `agent-server/` | **Pi SDK 智能分发规划服务**（独立 Node.js 服务，OpenAI 兼容） |
| `agent-server/server.js` | Express 服务（POST /api/dispatch-plan） |
| `agent-server/pi-planner.js` | 规划核心（系统提示词、JSON 解析、fallback、多视角分析） |
| `cli/dock-cli.cjs` | 命令行工具（经 named pipe + token 鉴权与主进程通信） |
| `scripts/install-cli.cjs` | 安装 dock CLI 到 PATH（含 PATH 校验与降级提示） |
| `css/dock.css` | 公共样式 |

---

## 🤖 AI 分发台（智能分发规划 Agent）

「AI 分发台」区域接入了独立的 Pi SDK 规划服务，工作流如下：

```
用户输入想法 / 点击已有便利贴 chip
    ↓
前端调用 POST http://localhost:3874/api/dispatch-plan
    ↓
Pi SDK 识别任务类型（产品设计/代码/调研/学习/生活...）
    ↓
拆解为子任务，判断分发对象（自己/AI规划/设计Agent/代码Agent/研究Agent/暂存）
    ↓
生成结构化 DispatchPlan JSON
    ↓
前端渲染分发卡片（含提示词、理由、预期产出）
    ↓
用户确认 → 保存为白板任务卡
```

**Agent 不执行任何任务**，只负责规划、拆解、分发。
如果 agent-server 未启动，自动降级为三步法头脑风暴模式。

### 分发对象说明

| routeTo | 含义 |
| --- | --- |
| `human` | 我自己处理 |
| `planning_agent` | 继续让 AI 深入规划 |
| `design_agent` | 交给设计 Agent |
| `code_agent` | 交给代码 Agent |
| `research_agent` | 交给研究 Agent |
| `later` | 暂存以后做 |

- 入口是 `dock.html` —— **一个真实桌面窗口，只显示一个 AI Daily Dock 面板**，通过状态在三种形态间自由切换（不再三列并排预览）。
- 视觉、颜色、圆角、阴影、橙色强调色、任务卡片与素材 **完全保留**，未做任何重设计。
- 前端仍为 **原生 HTML / CSS / JavaScript**，没有引入任何前端框架。
- 窗口为 **无框 + 透明**，圆角面板带投影浮于桌面（不截图、不绘制桌面壁纸）；顶部「形态切换条」既是三态切换器，也是窗口拖拽区。

### 四种形态（同一个页面，`#app[data-mode]` 驱动，不跳页、不复制页面）

| `data-mode` | 内容 | 窗口尺寸 |
| --- | --- | --- |
| `expanded`（默认） | 今日重点任务列表、正在进行、交给 AI、AI 工作中、时间安排、灵感 Inbox、今日复盘、底部导航 | 460 × 820 |
| `compact` | 时间、今日完成进度、当前任务、快速输入、任务/专注/复盘按钮（隐藏任务列表/AI 区/底部导航） | 430 × 330 |
| `focus` | 当前任务、专注倒计时圆环、任务进度、完成专注/退出（隐藏任务列表与 AI 输入） | 400 × 580 |
| `board` | 多看板白板：拖拽便利贴、连线依赖、侧边栏看板切换、分发规划入口（窗口居中大窗口） | 1200 × 800 |

切换入口：顶部形态切换按钮（紧凑⇄展开）、展开模式「开始专注」→ focus、Alt+B 全局快捷键 → board、分发方案保存为任务卡 → board。选择会写入 `localStorage.dailyDockMode` 并在下次启动恢复。

---

## 一、改了哪些文件 / 新增了哪些文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `package.json` | 新增 | npm 清单：依赖、脚本、electron-builder 打包配置 |
| `main.js` | 新增 | Electron 主进程：建窗、托盘、IPC、安全加固 |
| `preload.js` | 新增 | 安全预加载：通过 `contextBridge` 暴露白名单 `window.dock` API |
| `scripts/make-icon.cjs` | 新增 | 纯 Node 图标生成器（无第三方依赖） |
| `assets/icon.png` | 新增 | 应用图标 256×256（由生成器产出） |
| `assets/tray.png` | 新增 | 托盘图标 32×32（由生成器产出） |
| `dock.html` | 修改 | ① 删除「三列预览」展示外壳（`.canvas/.stage/.caption`），改为单一 `#app.daily-dock[data-mode]` 容器 + 顶部形态切换条；② CSS 用 `#app[data-mode]` 控制三种尺寸与显隐；③ 新增 `setMode()` 状态逻辑（含 `localStorage` 记忆、按钮高亮、`window.dock.setMode` 同步窗口）；④ 置顶/透明度/折叠/设置/紧凑置顶 接入真窗口行为。视觉素材一字未改 |
| `README.md` | 新增 | 本文档 |

> 原 `index.html / settings.html / agent-detail.html / recap-history.html / css/dock.css` **未修改**。

### 接线点（`dock.html`，全部浏览器安全：`window.dock` 不存在时回退到原 toast 行为）

- `#btnPin` / `#cmpPin` → `window.dock.setAlwaysOnTop(bool)`：真窗口「常驻最前」。
- `#btnOpacity` → `window.dock.setOpacity(0~1)`：整窗透明度（桌面悬浮效果）。浏览器里仍走原 `data-opacity` 局部透明。
- `#btnCollapse` → `window.dock.collapseToTray()`：隐藏到系统托盘，托盘左键 / 菜单恢复。
- `#btnSettings` → `window.dock.openPage('settings.html')`：当前窗口内打开设置页。
- 托盘菜单切换置顶时，反向同步两个置顶按钮高亮。

---

## 二、安全设置（硬性要求）

`main.js` 中窗口 `webPreferences`：

```
contextIsolation: true     // ✅ 上下文隔离
nodeIntegration: false     // ✅ 关闭 Node 集成
sandbox: true              // ✅ 预加载沙箱（仅可用 contextBridge / ipcRenderer）
```

额外加固：

- 外部链接（`<a target=_blank>`、`window.open`）一律走系统浏览器，App 内拒绝加载任何远程内容。
- `will-navigate` 仅允许 `file://` 之间的本地跳转（index → dock → settings …）。
- `dock:openPage` 仅接受白名单 5 个页面，杜绝路径穿越。
- 注入严格 CSP：放开 `'unsafe-inline'`（原型用内联样式/脚本），禁止任何远程脚本/样式/连接。

---

## 三、桌面悬浮面板体验

| 特性 | 实现 |
| --- | --- |
| 入口 | `BrowserWindow` 加载 `dock.html`（单面板三态） |
| 窗口形态 | **无框 + 透明**：圆角面板带投影浮于桌面，不截图、不绘制桌面壁纸 |
| 窗口尺寸 | 随 `data-mode` 切换：expanded 430×760 / compact 280×330 / focus 380×520（最小 260×300） |
| 窗口拖拽 | 顶部「形态切换条」空白处可拖拽（`-webkit-app-region:drag`），按钮区为 `no-drag` |
| 窗口控制 | 切换条右侧「最小化 / 关闭」按钮（无框窗口自定义控件） |
| 三态切换 | 顶部「紧凑 / 展开 / 专注」分段按钮；`#app[data-mode]` 控制尺寸与显隐，状态写入 `localStorage` |
| 常驻最前 | `alwaysOnTop` 可配置：展开标题栏 📌 / 紧凑 📌 / 托盘菜单 |
| 透明度 | 展开标题栏 🌓 三档（100% / 85% / 70%）整窗透明 |
| 折叠/恢复 | 展开标题栏 ⌄ 折叠到托盘；托盘左键显隐、右键菜单 |
| 单实例 | 再次启动唤起已运行窗口，不开新进程 |

> 若你的显卡对透明窗口合成有问题（极少见，表现为黑底），把 `main.js` 里 `transparent:true` 改为 `false`、`frame:false` 改为 `true` 即可回退到原生标题栏矩形窗口，三态切换逻辑不受影响。

---

## 四、安装依赖

需要 Node.js ≥ 16（当前环境 Node 24 / npm 11 已可用）。

```bash
npm install
```

> 该命令会安装 `electron`（含平台二进制，体积较大，首次约 230MB）与 `electron-builder`。

**中国大陆网络（重要）：** Electron 的二进制默认从 GitHub 下载，国内极易被中断，且 `npm install` 不会报错、只是悄悄留下缺失的 `node_modules/electron/dist/electron.exe`，导致 `npm run dev` 启动失败。本项目已内置 `.npmrc`，把二进制下载指向 `npmmirror` 镜像，`npm install` 时自动生效，无需手动设置环境变量。

若仍下载失败，可手动补一次：

```bash
# 方式一：用镜像重跑 electron 的 postinstall
node node_modules/electron/install.js   # .npmrc 已配置镜像，会走 npmmirror

# 方式二：临时环境变量（等效）
# bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js
```

如想锁定/升级版本：`npm install electron@latest --save-dev`。

---

## 五、启动预览

```bash
npm run dev
# 等价于 npm start （均为 electron .）
```

启动后：

1. 出现一个 **无框、透明、圆角** 的悬浮面板，直接就是 `dock.html`（默认展开模式）。
2. 顶部「紧凑 / 展开 / 专注」分段按钮 + 右侧最小化 / 关闭。
3. 任务栏出现托盘图标（橙底白星）。

---

## 六、如何验证桌面应用正常运行

逐项勾选：

**三态切换（本次改造的核心）**

- [ ] 点顶部「紧凑」：窗口缩小到约 **280×330**，只剩时间 / 进度 / 当前任务 / 快速输入 / 三个迷你按钮。
- [ ] 点顶部「展开」：窗口放大到约 **430×760**，回到完整主视图（任务列表 / AI 区 / 底部导航）。
- [ ] 点顶部「专注」：窗口变成约 **380×520** 的倒计时圆环视图。
- [ ] 每次切换，只有对应那块面板可见，另两块隐藏（**不会三块同时出现**）。
- [ ] 切换后当前高亮的形态按钮正确变化，且刷新应用后仍停在上次形态（`localStorage` 记忆）。
- [ ] 展开模式底部「开始专注」→ 直接进 focus；focus「退出」→ 回 expanded；紧凑点当前任务卡片或「任务」→ 回 expanded。

**窗口与桌面行为**

- [ ] 面板圆角 + 投影浮在桌面上，**没有把桌面截图当背景**，四角透出真实桌面。
- [ ] 拖动顶部「形态切换条」的空白处可移动窗口；按钮本身可点（不会被拖拽吞掉）。
- [ ] 最小化 / 关闭按钮可用；关闭后退出，托盘里「显示面板 / 常驻最前 / 折叠到托盘 / 退出」可用。
- [ ] 时钟在走、任务可勾选、AI 输入回车能新增 Agent 卡片（原有交互全部保留）。
- [ ] 展开标题栏 📌 常驻最前、🌓 三档透明度、⌄ 折叠到托盘、⚙ 打开设置 均生效。
- [ ] 再次运行 `npm run dev`：**不会开第二个窗口**，而是唤起已有窗口（单实例）。
- [ ] 开发者工具（`Ctrl+Shift+I`）控制台无报错；`window.dock.isElectron === true`、`window.dock.platform === 'win32'`、`window.dock.setMode` 为函数。

> 仍可在浏览器直接打开 `index.html` 验证：此时 `window.dock` 为 `undefined`，所有按钮回退到 toast 提示，原型行为不变。

---

## 七、后续打包成 exe

打包脚本已预留（依赖 `electron-builder`，`npm install` 时已装）：

```bash
# 1) 生成 NSIS 安装包 + 免安装便携版（输出到 dist/）
npm run dist

# 2) 只打未压缩的目录版（最快，用于冒烟测试）
npm run dist:dir
```

产物（位于 `dist/`）：

- `AI Daily Dock Setup x.y.z.exe` — NSIS 安装包（可选安装目录、创建桌面快捷方式）。
- `AI-Daily-Dock-Portable-x.y.z.exe` — 单文件免安装版，双击即用。

打包配置见 `package.json` 的 `"build"` 字段（appId、win 目标 nsis+portable、图标 `assets/icon.png`）。

> 说明：打包会额外下载 winCodeSign / nsis 等工具（首次约 80MB）。国内网络若失败，设置打包镜像环境变量后重试：
> ```bash
> export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> npm run dist
> ```
> （PowerShell 用 `$env:ELECTRON_BUILDER_BINARIES_MIRROR="..."`。）完整打包**不强制在本步骤完成**，脚本已就绪，需要时直接运行即可。

### 重新生成图标（可选）

```bash
npm run icon      # node scripts/make-icon.cjs  → 产出 assets/icon.png + assets/tray.png
```

---

## 八、目录结构

```
.
├── main.js              ← Electron 主进程（窗口/托盘/IPC/安全加固/CLI 服务/快捷键）
├── preload.js           ← 安全 contextBridge API
├── aiService.js         ← AI 能力隔离层（任务拆解/头脑风暴/逐步执行/复盘）
├── agentBridge.js       ← 本地 CLI Agent 桥接（Claude Code/Codex 等，支持取消杀进程树）
├── dataService.js       ← 主进程统一数据层（JSON 文件原子写 + 防抖 + 缓存）
├── package.json         ← npm / electron-builder 配置
├── README.md            ← 本文档
├── src/
│   ├── shared/
│   │   └── perspectives.js   ← 三视角头脑风暴唯一真值（aiService + agent-server 共用）
│   └── renderer/js/
│       ├── state/taskStore.js      ← 渲染层纯数据层（CRUD/持久化/归档/拓扑排序/迁移）
│       ├── ai/dispatchClient.js    ← AI 分发弹窗 + 调 agent-server + 生成白板卡
│       └── ui/renderTasks.js       ← 任务列表 UI 渲染层
├── agent-server/        ← 独立的 Pi SDK 智能分发规划服务（OpenAI 兼容，可选）
│   ├── server.js            ← Express 服务（POST /api/dispatch-plan）
│   ├── pi-planner.js        ← 规划核心（多视角分析 + JSON 解析 + fallback）
│   └── package.json
├── scripts/
│   ├── make-icon.cjs    ← 图标生成器
│   └── install-cli.cjs  ← 安装 dock CLI 到 PATH（含 PATH 校验与降级提示）
├── cli/
│   └── dock-cli.cjs     ← 命令行工具（named pipe + token 鉴权）
├── assets/
│   ├── icon.png         ← 应用图标
│   └── tray.png         ← 托盘图标
├── css/
│   └── dock.css         ← 公共样式
├── index.html           ← 产品入口 / 启动器
├── dock.html            ← 主悬浮面板（compact/board/expanded/focus 四态）
├── settings.html        ← 设置
├── agent-detail.html    ← Agent 详情
└── recap-history.html   ← 历史复盘
```

> 渲染层正在从 dock.html 单文件向 `src/renderer/js/` 模块化迁移：
> 数据层 / AI 分发 / 任务渲染 已拆出，白板交互等仍在 dock.html 内。
> 外部模块统一经 `window.DOCK.{store,app,render,dispatch}` 命名空间通信，
> 不再反向注入函数到 store。
