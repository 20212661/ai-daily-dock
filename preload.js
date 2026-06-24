/* ============================================================
   AI Daily Dock · preload
   在 contextIsolation + sandbox 开启、nodeIntegration 关闭的前提下，
   通过 contextBridge 向渲染层暴露一个最小、白名单化的 window.dock API。
   渲染层（dock.html 等）只能调用这里显式暴露的方法，无法直接访问 Node / Electron。
   ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

// 仅允许跳转到这些本地页面，杜绝路径穿越 / 任意 file:// 加载
const ALLOWED_PAGES = [
  'index.html',
  'dock.html',
  'settings.html',
  'agent-detail.html',
  'recap-history.html'
];

contextBridge.exposeInMainWorld('dock', {
  // 环境标识，渲染层据此决定是否启用桌面增强（浏览器里为 undefined）
  isElectron: true,
  platform: process.platform,           // 'win32' | 'darwin' | 'linux'
  electronVersion: process.versions.electron,

  // —— 窗口控制（均经主进程 IPC，渲染层无 Node 权限）——
  /** 设置窗口常驻最前：true 屏保级置顶，false 取消 */
  setAlwaysOnTop: (on) => ipcRenderer.invoke('dock:setAlwaysOnTop', !!on),

  /** 设置整窗透明度：0~1（桌面悬浮面板透明） */
  setOpacity: (val) => ipcRenderer.invoke('dock:setOpacity', Number(val)),

  /** 折叠到系统托盘（隐藏窗口，托盘图标可恢复） */
  collapseToTray: () => ipcRenderer.invoke('dock:collapse'),

  /** 在当前窗口内打开某个本地页面（受 ALLOWED_PAGES 白名单限制） */
  openPage: (name) => {
    if (ALLOWED_PAGES.includes(name)) {
      return ipcRenderer.invoke('dock:openPage', name);
    }
    return Promise.resolve(false);
  },

  /** 切换面板形态并同步窗口尺寸：'compact' | 'expanded' | 'focus' */
  setMode: (mode) => ipcRenderer.invoke('dock:setMode', mode),

  /** 无框窗口控制 */
  minimize: () => ipcRenderer.invoke('dock:minimize'),
  close: () => ipcRenderer.invoke('dock:close'),

  // 主进程 → 渲染层：置顶状态被外部（托盘菜单）改变时通知 UI 同步
  onAlwaysOnTopChange: (cb) => {
    const handler = (_e, val) => cb(!!val);
    ipcRenderer.on('dock:alwaysOnTopChanged', handler);
    return () => ipcRenderer.removeListener('dock:alwaysOnTopChanged', handler);
  },

  // 主进程 → 渲染层：全局快捷键触发（'board' / 'ai'）
  onShortcut: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('dock:shortcut', handler);
    return () => ipcRenderer.removeListener('dock:shortcut', handler);
  },

  // 主进程 → 渲染层：CLI 命令（dock add/list/complete/recap）
  onCliCommand: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('cli:command', handler);
    return () => ipcRenderer.removeListener('cli:command', handler);
  },

  // 主进程 → 渲染层：任务数据被外部（CLI / 其他窗口）修改时通知刷新
  onTasksChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('tasks:changed', handler);
    return () => ipcRenderer.removeListener('tasks:changed', handler);
  },

  // —— 数据层 API（主进程统一管理 tasks.json 等 JSON 文件）——
  tasks: {
    /** 从主进程加载全部任务数据（启动时调用） */
    load: () => ipcRenderer.invoke('tasks:load'),
    /** 保存任务数据到主进程（防抖写入 JSON 文件） */
    save: (tasksData) => ipcRenderer.invoke('tasks:save', tasksData),
    /** 立即保存（非防抖，用于关键操作） */
    saveNow: (tasksData) => ipcRenderer.invoke('tasks:saveNow', tasksData),
    /** 获取所有节点（跨所有看板） */
    allNodes: () => ipcRenderer.invoke('tasks:allNodes'),
    /** 统计 done/total */
    counts: () => ipcRenderer.invoke('tasks:counts'),
    /** 按 id 查节点 */
    findNode: (id) => ipcRenderer.invoke('tasks:findNode', id),
  },

  // 通用数据文件读写（settings / recaps / agentRuns / modelConfig）
  data: {
    load: (name) => ipcRenderer.invoke('data:load', name),
    save: (name, data) => ipcRenderer.invoke('data:save', name, data),
    exportAll: () => ipcRenderer.invoke('data:export'),
    importAll: (data) => ipcRenderer.invoke('data:import', data),
    clearAll: () => ipcRenderer.invoke('data:clear'),
  },

  // —— AI 能力（经主进程 IPC，Key 不暴露给渲染层）——
  ai: {
    /** 保存 API Key（主进程加密存储） */
    saveKey: (key) => ipcRenderer.invoke('ai:saveKey', key),
    /** 读取 API Key 是否已配置（不返回 Key 本身） */
    hasKey: () => ipcRenderer.invoke('ai:loadKey').then(r => r.ok && !!r.key),
    /** 获取 AI 配置信息（模式、模型名、预设列表，不含 Key） */
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    /** 切换模型预设 */
    setModel: (presetId, customUrl, customModel) => ipcRenderer.invoke('ai:setModel', presetId, customUrl, customModel),
    /** 任务拆解：输入指令 → 返回步骤草案（人审核后才执行） */
    draftSteps: (prompt, taskContext) => ipcRenderer.invoke('ai:draftSteps', prompt, taskContext),
    /** 多模型头脑风暴：多个 AI 从不同角度分析问题，返回多份分析供人综合 */
    brainstorm: (prompt, taskContext) => ipcRenderer.invoke('ai:brainstorm', prompt, taskContext),
    /** 复制文本到剪贴板 */
    copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
    /** 打开外部链接（网页版 AI） */
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    /** 逐步执行：人点「用 AI 辅助这步」→ AI 返回该步结果供人审核 */
    executeStep: (stepContext) => ipcRenderer.invoke('ai:executeStep', stepContext),
    /** 复盘建议 */
    recapAdvice: (doneTasks, missTasks) => ipcRenderer.invoke('ai:recapAdvice', doneTasks, missTasks),
  },
  /** Hermes 风格本地 Agent 桥接 */
  agent: {
    /** 检测本地已安装的 CLI Agent */
    detect: () => ipcRenderer.invoke('agent:detect'),
    /** 派活给本地 Agent（后台异步执行，返回 taskId） */
    dispatch: (agentId, prompt, opts) => ipcRenderer.invoke('agent:dispatch', agentId, prompt, opts),
    /** 查询 Agent 任务状态 */
    status: (taskId) => ipcRenderer.invoke('agent:status', taskId),
    /** 取消 Agent 任务 */
    cancel: (taskId) => ipcRenderer.invoke('agent:cancel', taskId),
    /** 列出所有运行中 Agent 任务 */
    list: () => ipcRenderer.invoke('agent:list'),
    /** Agent 运行历史（持久化，按时间倒序） */
    runs: () => ipcRenderer.invoke('agent:runs'),
    /** 按 taskId 查单条历史记录 */
    run: (taskId) => ipcRenderer.invoke('agent:run', taskId),
  },

  // —— 开机自启 ——
  getLoginItem: () => ipcRenderer.invoke('app:getLoginItem'),
  setLoginItem: (on) => ipcRenderer.invoke('app:setLoginItem', !!on),

  // —— 复盘快照（规范化列表）——
  recaps: {
    list: () => ipcRenderer.invoke('recaps:list'),
  }
});
