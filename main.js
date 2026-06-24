/* ============================================================
   AI Daily Dock · Electron 主进程
   - BrowserWindow 加载现有 index.html（产品入口 / 启动器）
   - contextIsolation: true / nodeIntegration: false / sandbox: true
   - 通过 preload.js 暴露白名单 API
   - 原生窗口框架（Win11 自带圆角 + 阴影 + 可拖拽标题栏）
   - 可配置 alwaysOnTop、整窗透明度、折叠到托盘
   - 系统托盘：左键显隐 / 右键菜单（显示·置顶·退出）
   - 安全加固：拦截外部导航 / 新窗口、注入 CSP
   ============================================================ */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, session, nativeImage, safeStorage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

// —— AI 能力隔离层 ——
const aiService = require('./aiService');
// —— Hermes 风格本地 Agent 桥接 ——
const agentBridge = require('./agentBridge');
// —— 主进程统一数据层（tasks.json 等 JSON 文件管理）——
const dataService = require('./dataService');

// —— 资源路径 ——
const ROOT = __dirname;
const ENTRY = 'dock.html';                  // 桌面应用直接进入主面板（单面板三态：compact / expanded / focus）
const ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
const ALLOWED_PAGES = new Set([
  'index.html', 'dock.html', 'settings.html', 'agent-detail.html', 'recap-history.html'
]);

// —— 运行期状态 ——
let mainWindow = null;
let tray = null;
let alwaysOnTop = false;

// 取得应用图标（无图标资源时优雅降级为 null，不阻塞启动）
function appIcon() {
  try {
    if (fs.existsSync(ICON_PNG)) {
      return nativeImage.createFromPath(ICON_PNG);
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

// 切换「常驻最前」并广播给渲染层（按钮 / 托盘菜单共用同一真值）
function setAlwaysOnTop(win, val) {
  alwaysOnTop = !!val;
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(alwaysOnTop, 'screen-saver'); // screen-saver：高于普通窗口，低于系统遮罩
    win.webContents.send('dock:alwaysOnTopChanged', alwaysOnTop);
  }
}

function createWindow() {
  const icon = appIcon();

  mainWindow = new BrowserWindow({
    width: 460,                           // 默认展开模式尺寸
    height: 820,
    minWidth: 260,                        // 允许收到紧凑模式尺寸
    minHeight: 300,
    title: 'AI Daily Dock',
    icon: icon || undefined,
    backgroundColor: '#00000000',         // 透明窗口，四角透出桌面
    autoHideMenuBar: true,
    frame: false,                         // 无框：面板本体即窗口（顶部 modeswitch 条为拖拽区）
    transparent: true,                    // 透明：圆角 + 投影浮于桌面，不绘制/截图桌面背景
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,                          // 首屏就绪后再显示，避免白屏
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,             // ✅ 隔离上下文
      nodeIntegration: false,             // ✅ 关闭 Node 集成
      sandbox: true,                      // ✅ 沙箱（preload 仅可用 contextBridge/ipcRenderer）
      spellcheck: false,
      devTools: true
    }
  });

  mainWindow.loadFile(ENTRY);

  // 首次绘制完成再展示
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  // —— 开发模式：自动打开 DevTools（便于浏览器式调试）——
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' }); // detach = 独立窗口，类似浏览器
  }

  // —— 安全：拦截外部链接 ——
  // 渲染层里的 <a target=_blank> 或 window.open 走系统浏览器，App 内不加载任何远程内容
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 仅允许本地 file:// 之间的页面跳转（如 index→dock→settings），阻止远程导航
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// —— 安全：注入严格 CSP ——
// 原型使用内联 <style>/<script>，故放开 'unsafe-inline'；禁止任何远程脚本/样式/连接。
function installCSP() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

// —— 系统托盘：折叠到托盘 / 恢复 / 置顶切换 / 退出 ——
function createTray() {
  const icon = appIcon();
  if (!icon) return; // 无图标资源则跳过托盘（窗口控制仍可用）

  // 托盘用小尺寸图标更清晰
  const trayIcon = icon.resize({ width: 32 });

  tray = new Tray(trayIcon);
  tray.setToolTip('AI Daily Dock · 桌面悬浮 AI 协作面板');

  const menu = () => Menu.buildFromTemplate([
    { label: '显示面板', click: showWindow },
    { type: 'separator' },
    {
      label: '常驻最前',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => setAlwaysOnTop(mainWindow, item.checked)
    },
    { label: '折叠到托盘', click: () => hideWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu());

  // 左键：已聚焦→隐藏；否则显示并聚焦（典型的悬浮面板交互）
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
      hideWindow();
    } else {
      showWindow();
    }
  });

  // 置顶状态变化后刷新菜单勾选
  ipcMain.on('__refresh-tray', () => tray && tray.setContextMenu(menu()));
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function hideWindow() {
  if (mainWindow) mainWindow.hide();
}

// —— IPC：渲染层（preload）调用的窗口控制 ——
ipcMain.handle('dock:setAlwaysOnTop', (_e, val) => {
  setAlwaysOnTop(mainWindow, val);
  return alwaysOnTop;
});
ipcMain.handle('dock:setOpacity', (_e, val) => {
  const v = Math.max(0.2, Math.min(1, Number(val) || 1)); // 限制下限，避免完全不可见后无法操作
  if (mainWindow) mainWindow.setOpacity(v);
  return v;
});
ipcMain.handle('dock:collapse', () => { hideWindow(); return true; });
ipcMain.handle('dock:openPage', (_e, name) => {
  if (!mainWindow || !ALLOWED_PAGES.has(name)) return false;
  mainWindow.loadFile(name);
  return true;
});

// —— 形态切换：按模式调整窗口内容尺寸（白板居中打开，其他保持位置）——
const MODE_SIZE = {
  compact: [430, 330],
  expanded: [460, 820],
  board: [1200, 800],     // 白板大窗口（侧边栏160 + 画布1040），内容区自适应填满
  focus: [400, 580]
};
let resizeAnimId = null;
function animateContentSize(win, targetW, targetH, duration, center) {
  if (resizeAnimId) { clearInterval(resizeAnimId); resizeAnimId = null; }
  const { screen } = require('electron');
  const display = screen.getDisplayMatching(win.getBounds());
  const sw = display.workAreaSize.width, sh = display.workAreaSize.height;
  const [startW, startH] = win.getContentSize();
  const startBounds = win.getBounds();
  // 居中目标位置
  const targetX = Math.round((sw - targetW) / 2);
  const targetY = Math.round((sh - targetH) / 2);
  const frameOffsetW = startBounds.width - startW;
  const frameOffsetH = startBounds.height - startH;
  const startTime = Date.now();
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  resizeAnimId = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const e = ease(t);
    const w = Math.round(startW + (targetW - startW) * e);
    const h = Math.round(startH + (targetH - startH) * e);
    if (win.isDestroyed()) return;
    win.setContentSize(w, h);
    if (center) {
      const x = Math.round(startBounds.x + (targetX - startBounds.x) * e);
      const y = Math.round(startBounds.y + (targetY - startBounds.y) * e);
      win.setPosition(x, y);
    }
    if (t >= 1) { clearInterval(resizeAnimId); resizeAnimId = null; }
  }, 16);
}
ipcMain.handle('dock:setMode', (e, mode) => {
  const size = MODE_SIZE[mode];
  if (!size) return false;
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  if (win && !win.isDestroyed()) animateContentSize(win, size[0], size[1], 320, mode === 'board');
  return true;
});

// —— AI 能力 IPC 通道（aiService 隔离层）——
// API Key 加密存储路径
const AI_KEY_FILE = path.join(app.getPath('userData'), 'ai_key.enc');

// 安全存储：加密保存 API Key（操作系统级加密）
ipcMain.handle('ai:saveKey', (_e, key) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // 降级：明文存储（仅当 OS 不支持加密时，如部分 Linux）
      fs.writeFileSync(AI_KEY_FILE, key, 'utf8');
      return { ok: true, encrypted: false };
    }
    const encrypted = safeStorage.encryptString(key);
    fs.writeFileSync(AI_KEY_FILE, encrypted);
    aiService.setApiKey(key);
    return { ok: true, encrypted: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 读取 API Key（解密）
ipcMain.handle('ai:loadKey', () => {
  try {
    if (!fs.existsSync(AI_KEY_FILE)) return { ok: true, key: '' };
    const buf = fs.readFileSync(AI_KEY_FILE);
    let key;
    if (safeStorage.isEncryptionAvailable()) {
      key = safeStorage.decryptString(buf);
    } else {
      key = buf.toString('utf8');
    }
    aiService.setApiKey(key);
    return { ok: true, key: key };
  } catch (err) {
    return { ok: false, error: err.message, key: '' };
  }
});

// AI 任务拆解（保持人主导：AI 只返回草案，人在 dock.html 审核）
ipcMain.handle('ai:draftSteps', async (_e, prompt, taskContext) => {
  try {
    const steps = await aiService.draftTaskSteps(prompt, taskContext);
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, error: err.message, steps: [] };
  }
});

// AI 多模型头脑风暴（三个视角并发分析，人综合决策）
ipcMain.handle('ai:brainstorm', async (_e, prompt, taskContext) => {
  try {
    const analyses = await aiService.brainstorm(prompt, taskContext);
    return { ok: true, analyses };
  } catch (err) {
    return { ok: false, error: err.message, analyses: [] };
  }
});

// 剪贴板写入
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(text);
  return { ok: true };
});

// 打开外部链接
ipcMain.handle('shell:openExternal', (_e, url) => {
  shell.openExternal(url);
  return { ok: true };
});

// AI 逐步执行（人主导：人点某一步 → AI 返回该步结果 → 人审核验收）
ipcMain.handle('ai:executeStep', async (_e, stepContext) => {
  try {
    const result = await aiService.executeStep(stepContext);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message, result: '' };
  }
});

/* ---------- Hermes 本地 Agent 桥接 ---------- */
// 检测本地已安装的 CLI Agent
ipcMain.handle('agent:detect', () => {
  return { ok: true, agents: agentBridge.detectAgents() };
});

// 派活给本地 Agent（后台异步执行）
ipcMain.handle('agent:dispatch', (_e, agentId, prompt, opts) => {
  return agentBridge.dispatchToAgent(agentId, prompt, opts || {});
});

// 查询 Agent 任务状态（轮询）
ipcMain.handle('agent:status', (_e, taskId) => {
  return agentBridge.getAgentTaskStatus(taskId);
});

// 取消 Agent 任务
ipcMain.handle('agent:cancel', (_e, taskId) => {
  return agentBridge.cancelAgentTask(taskId);
});

// 列出所有 Agent 任务
ipcMain.handle('agent:list', () => {
  return { ok: true, tasks: agentBridge.listAgentTasks() };
});

// Agent 运行历史（持久化的 agent-runs.json，按时间倒序）
ipcMain.handle('agent:runs', () => {
  return { ok: true, runs: dataService.getAgentRuns() };
});

// 按 taskId 查单条 Agent 历史记录
ipcMain.handle('agent:run', (_e, taskId) => {
  var run = dataService.findAgentRun(taskId);
  return run ? { ok: true, run: run } : { ok: false, error: '历史记录不存在' };
});

// 复盘快照列表（持久化的 recaps.json，按 date 倒序）
ipcMain.handle('recaps:list', () => {
  return { ok: true, items: dataService.getRecaps() };
});

// AI 复盘建议
ipcMain.handle('ai:recapAdvice', async (_e, doneTasks, missTasks) => {
  try {
    const advice = await aiService.generateRecapAdvice(doneTasks, missTasks);
    return { ok: true, advice };
  } catch (err) {
    return { ok: false, error: err.message, advice: '' };
  }
});

/* ============================================================
   数据层 IPC：渲染层通过这些通道读写 tasks.json
   主进程是唯一数据真值来源，渲染层持有内存缓存
   ============================================================ */

// 读取全部任务数据（启动时加载到渲染层缓存）
ipcMain.handle('tasks:load', () => {
  try {
    const tasks = dataService.getTasks();
    return { ok: true, tasks: tasks };
  } catch (err) {
    return { ok: false, error: err.message, tasks: null };
  }
});

// 保存任务数据（渲染层全量推送，主进程防抖写入 JSON）
ipcMain.handle('tasks:save', (_e, tasksData) => {
  try {
    dataService.setTasks(tasksData);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 立即保存（非防抖，用于退出 / 关键操作）
ipcMain.handle('tasks:saveNow', (_e, tasksData) => {
  try {
    return { ok: dataService.saveTasksNow(tasksData) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 便捷查询：获取所有节点（跨所有看板）
ipcMain.handle('tasks:allNodes', () => {
  return { ok: true, nodes: dataService.getAllNodes() };
});

// 便捷查询：统计
ipcMain.handle('tasks:counts', () => {
  return { ok: true, counts: dataService.getCounts() };
});

// 便捷查询：按 id 查节点
ipcMain.handle('tasks:findNode', (_e, id) => {
  return { ok: true, node: dataService.findNode(id) };
});

// 通用数据文件读写（settings / recaps / agentRuns / modelConfig）
ipcMain.handle('data:load', (_e, name) => {
  return { ok: true, data: dataService.load(name) };
});
ipcMain.handle('data:save', (_e, name, data) => {
  return { ok: dataService.save(name, data) };
});

// 数据导出 / 导入 / 清除
ipcMain.handle('data:export', () => {
  return { ok: true, data: dataService.exportAll() };
});
ipcMain.handle('data:import', (_e, data) => {
  return { ok: dataService.importAll(data) };
});
ipcMain.handle('data:clear', () => {
  return { ok: dataService.clearAll() };
});

// 获取 AI 配置信息（不暴露 Key）
ipcMain.handle('ai:getConfig', () => {
  return {
    useMock: aiService.USE_MOCK,
    model: aiService.API_CONFIG.model,
    url: aiService.API_CONFIG.url,
    hasKey: !!aiService.getApiKey(),
    presets: aiService.MODEL_PRESETS,
  };
});

// 切换模型
ipcMain.handle('ai:setModel', (_e, presetId, customUrl, customModel) => {
  try {
    aiService.setModel(presetId, customUrl, customModel);
    return { ok: true, model: aiService.API_CONFIG.model, url: aiService.API_CONFIG.url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// —— 无框窗口控制：最小化 / 关闭 ——
ipcMain.handle('dock:minimize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  if (win && !win.isDestroyed()) win.minimize();
  return true;
});
ipcMain.handle('dock:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  if (win && !win.isDestroyed()) win.close(); // → window-all-closed → 退出
  return true;
});

// —— 开机自启（写入系统登录项，settings 页控制）——
ipcMain.handle('app:getLoginItem', () => {
  try {
    var s = app.getLoginItemSettings();
    return { ok: true, openAtLogin: !!s.openAtLogin };
  } catch (e) {
    return { ok: false, error: e.message, openAtLogin: false };
  }
});
ipcMain.handle('app:setLoginItem', (_e, on) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { ok: true, openAtLogin: !!on };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// —— CLI IPC Server：接收 dock CLI 命令 ——
let ipcServer = null;

// 每次启动生成一次性 token，CLI 必须在每条命令里带上，避免同机其他进程
// 任意 add/complete/recap。token 写入用户临时目录的文件，CLI（同用户）可读。
// 路径按用户隔离：多用户机器上互不干扰。
function genToken() {
  // crypto.randomUUID 在 Node ≥14.17 可用，否则降级
  try { return require('crypto').randomUUID(); } catch (_) {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}
const IPC_TOKEN = genToken();
function tokenFilePath() {
  const os = require('os');
  const uid = (os.userInfo && os.userInfo().uid) || process.env.USERNAME || 'user';
  return path.join(os.tmpdir(), 'daily-dock-ipc-token-' + uid);
}

function startIpcServer() {
  // 管道路径按用户隔离（多用户机器不冲突）
  const PIPE_PATH = process.platform === 'win32'
    ? '\\\\.\\pipe\\daily-dock-ipc-' + (process.env.USERNAME || 'user')
    : '/tmp/daily-dock-ipc-' + ((require('os').userInfo && require('os').userInfo().uid) || 'user') + '.sock';

  // 把 token 写到文件，CLI 启动时读取并附在每条命令里
  try { fs.writeFileSync(tokenFilePath(), IPC_TOKEN, { mode: 0o600 }); } catch (_) {}

  // 清理旧 socket
  try { if (process.platform !== 'win32') fs.unlinkSync(PIPE_PATH); } catch (_) {}

  ipcServer = net.createServer((conn) => {
    let data = '';
    conn.on('data', (chunk) => { data += chunk; });
    conn.on('end', () => {
      let res = { ok: false, error: '无效命令' };
      try {
        const msg = JSON.parse(data);
        // 鉴权：token 不匹配直接拒绝（防同机其他进程未授权调用）
        if (!msg || msg.token !== IPC_TOKEN) {
          res = { ok: false, error: '未授权：token 不匹配（请用 dock CLI 调用）' };
        } else {
          res = handleCliCommand(msg);
        }
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      conn.end(JSON.stringify(res));
    });
    conn.on('error', () => {});
  });

  ipcServer.on('error', () => {});

  // Windows named pipe / Unix domain socket
  if (process.platform === 'win32') {
    ipcServer.listen(PIPE_PATH);
  } else {
    ipcServer.listen(PIPE_PATH);
  }
}

function handleCliCommand(msg) {
  switch (msg.cmd) {
    case 'show':
      showWindow();
      return { ok: true, message: 'Dock 已显示' };

    case 'add':
    case 'new': {
      // 主进程直接写入 tasks.json，并通知渲染层刷新
      const node = dataService.cliAddTask(msg.title || '未命名');
      if (mainWindow) {
        showWindow();
        // 通知渲染层从主进程重新加载数据
        mainWindow.webContents.send('tasks:changed', { source: 'cli', action: 'add', node: node });
      }
      return { ok: true, message: '已创建任务：' + (msg.title || '未命名'), data: { id: node.id, title: node.title } };
    }

    case 'list':
    case 'ls': {
      // ✅ 主进程直接读取 tasks.json，不再依赖渲染层
      const nodes = dataService.getAllNodes();
      const activeBoard = dataService.getActiveBoard();
      const boardName = activeBoard ? activeBoard.name : '无活跃看板';
      const list = nodes.filter(function (n) { return !n.archived && n.status !== 'inbox'; })
        .map(function (n) {
          return { title: n.title, status: n.status, priority: n.priority, board: boardName };
        });
      return { ok: true, message: '当前看板：' + boardName + '（' + list.length + ' 项）', data: list };
    }

    case 'complete':
    case 'done': {
      // 主进程直接标记完成，并通知渲染层
      const found = dataService.cliCompleteTask(msg.match || '');
      if (found.length > 0 && mainWindow) {
        showWindow();
        mainWindow.webContents.send('tasks:changed', { source: 'cli', action: 'complete', nodes: found });
      }
      return { ok: true, message: '已标记完成 ' + found.length + ' 个任务', data: found.map(function (n) { return n.title; }) };
    }

    case 'recap':
      if (!mainWindow) return { ok: false, error: '窗口未初始化' };
      showWindow();
      mainWindow.webContents.send('cli:command', { cmd: 'recap' });
      return { ok: true, message: '已生成复盘' };

    default:
      return { ok: false, error: '未知命令：' + msg.cmd };
  }
}

// —— 全局快捷键：从任何应用中唤起 Dock ——
function registerGlobalShortcuts() {
  // Alt+N（Win）/ Option+N（Mac）：显示/隐藏 Dock
  globalShortcut.register('Alt+N', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
  // Alt+B：快速切换到白板模式（如果窗口隐藏则先显示）
  globalShortcut.register('Alt+B', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) showWindow();
    mainWindow.focus();
    mainWindow.webContents.send('dock:shortcut', 'board');
  });
  // Alt+A：快速唤起 AI 派活输入框
  globalShortcut.register('Alt+A', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) showWindow();
    mainWindow.focus();
    mainWindow.webContents.send('dock:shortcut', 'ai');
  });
}

// —— 单实例：再次启动时唤起已有窗口，而不是新开进程 ——
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  // 注入 agentBridge 的持久化回调：完成的 Agent 任务写入 agent-runs.json
  // （通过 dataService.addAgentRun，避免 agentBridge 直接 require dataService 造成循环依赖）
  agentBridge.setPersistence({
    saveRun: function (run) { dataService.addAgentRun(run); },
    loadRuns: function () { return dataService.getAgentRuns(); },
  });

  app.whenReady().then(() => {
    installCSP();
    createWindow();
    createTray();
    registerGlobalShortcuts();
    startIpcServer();

    app.on('activate', () => {           // macOS：点 Dock 图标时重建窗口
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// 全部窗口关闭：非 macOS 退出（有关闭按钮 = 退出；折叠走托盘隐藏）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出时注销所有全局快捷键，并刷新待写入数据 + 清理 IPC token 文件
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  dataService.flushAll();
  try { fs.unlinkSync(tokenFilePath()); } catch (_) {}
});
