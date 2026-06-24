/* ============================================================
   dataService.js — Electron 主进程统一数据层
   ------------------------------------------------------------
   所有任务数据由主进程通过 JSON 文件统一管理。
   渲染层 / CLI / Agent Server 都通过这里读写同一份数据。

   数据文件位置：app.getPath('userData')/
     tasks.json        任务数据（boards / activeBoardId）
     settings.json     应用设置
     recaps.json       复盘历史
     agent-runs.json   Agent 运行记录
     model-config.json AI 模型配置

   架构：
     Renderer → preload(window.dock.tasks.*) → IPC → main.js → dataService → JSON 文件
     CLI      → named pipe → main.js → dataService → JSON 文件

   设计原则：
   - 主进程是唯一的数据真值来源（single source of truth）
   - 渲染层持有一份内存缓存（从主进程加载），写操作通过 IPC 同步到主进程
   - 防抖写入：短时间内多次 save 只写一次文件
   - 自动迁移：首次加载时从 localStorage v3 格式迁移到 JSON 文件
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// —— 文件路径 ——
function dataDir() { return app.getPath('userData'); }
function filePath(name) { return path.join(dataDir(), name); }

const FILES = {
  tasks: filePath('tasks.json'),
  settings: filePath('settings.json'),
  recaps: filePath('recaps.json'),
  agentRuns: filePath('agent-runs.json'),
  modelConfig: filePath('model-config.json'),
};

// —— 内存缓存（主进程内，避免每次读文件）——
const cache = {
  tasks: null,
  settings: null,
  recaps: null,
  agentRuns: null,
  modelConfig: null,
};

// —— 防抖写入定时器 ——
const saveTimers = {};

// —— 底层读写 ——
function readJson(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) return defaultValue;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) return defaultValue;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[dataService] readJson error:', file, e.message);
    return defaultValue;
  }
}

function writeJsonSync(file, data) {
  try {
    // 确保目录存在
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 原子写入：先写临时文件再重命名（防止写到一半崩溃损坏数据）
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[dataService] writeJsonSync error:', file, e.message);
    return false;
  }
}

// 防抖写入（默认 300ms 内多次调用只写一次）
function writeJsonDebounced(file, data, delay) {
  delay = delay || 300;
  if (saveTimers[file]) clearTimeout(saveTimers[file]);
  saveTimers[file] = setTimeout(function () {
    saveTimers[file] = null;
    writeJsonSync(file, data);
  }, delay);
}

// 立即刷新所有待写入（退出时调用）
function flushAll() {
  Object.keys(saveTimers).forEach(function (file) {
    if (saveTimers[file]) {
      clearTimeout(saveTimers[file]);
      saveTimers[file] = null;
      // cache 中找对应数据
      if (file === FILES.tasks && cache.tasks) writeJsonSync(file, cache.tasks);
      else if (file === FILES.settings && cache.settings) writeJsonSync(file, cache.settings);
      else if (file === FILES.recaps && cache.recaps) writeJsonSync(file, cache.recaps);
      else if (file === FILES.agentRuns && cache.agentRuns) writeJsonSync(file, cache.agentRuns);
      else if (file === FILES.modelConfig && cache.modelConfig) writeJsonSync(file, cache.modelConfig);
    }
  });
}

/* ============================================================
   tasks.json — 任务数据
   结构：{ boards: [...], activeBoardId: 'xxx', version: 4 }
   ============================================================ */
function loadTasks() {
  if (cache.tasks) return cache.tasks;

  // 尝试从文件读取
  var data = readJson(FILES.tasks, null);

  if (data && data.boards && Array.isArray(data.boards) && data.boards.length > 0) {
    cache.tasks = normalizeTasks(data);
    return cache.tasks;
  }

  // 文件不存在或为空 → 检查是否需要从 localStorage 迁移
  // （localStorage 在渲染层，主进程无法直接读；迁移由渲染层首次加载时触发）
  // 这里返回空结构，渲染层会通过 migrateFromLocalStorage 推送旧数据
  cache.tasks = { boards: [], activeBoardId: null, version: 4 };
  return cache.tasks;
}

// 规范化任务结构：补全顶层 nodes/links 快捷引用
function normalizeTasks(data) {
  if (!data.boards) data.boards = [];
  if (!data.activeBoardId && data.boards.length > 0) data.activeBoardId = data.boards[0].id;
  if (!data.version) data.version = 4;
  // 不持久化顶层 nodes/links（它们是活跃看板的快捷引用），但内存中需要
  // 文件里只存 boards + activeBoardId，加载后同步 nodes/links
  return data;
}

function getTasks() {
  return loadTasks();
}

// 渲染层推送完整任务数据（全量覆盖）
function setTasks(data) {
  // 只保存 boards + activeBoardId + version，不保存冗余的顶层 nodes/links
  var saveData = {
    boards: data.boards || [],
    activeBoardId: data.activeBoardId || null,
    version: 4,
  };
  cache.tasks = saveData;
  writeJsonDebounced(FILES.tasks, saveData);
  return saveData;
}

// 立即保存（非防抖）
function saveTasksNow(data) {
  var saveData = {
    boards: (data || cache.tasks || {}).boards || [],
    activeBoardId: (data || cache.tasks || {}).activeBoardId || null,
    version: 4,
  };
  cache.tasks = saveData;
  return writeJsonSync(FILES.tasks, saveData);
}

// —— 便捷查询（CLI / Agent Server 可直接调用）——
function getAllNodes() {
  var t = loadTasks();
  var arr = [];
  if (!t.boards) return arr;
  t.boards.forEach(function (b) { if (b.nodes) b.nodes.forEach(function (n) { arr.push(n); }); });
  return arr;
}

function findNode(id) {
  var nodes = getAllNodes();
  for (var i = 0; i < nodes.length; i++) { if (nodes[i].id === id) return nodes[i]; }
  return null;
}

function getBoard(boardId) {
  var t = loadTasks();
  if (!t.boards) return null;
  return t.boards.filter(function (b) { return b.id === boardId; })[0] || null;
}

function getActiveBoard() {
  var t = loadTasks();
  return getBoard(t.activeBoardId);
}

// 统计 done / total
function getCounts() {
  var t = loadTasks();
  var total = 0, done = 0;
  if (!t.boards) return { total: 0, done: 0 };
  t.boards.forEach(function (b) {
    if (!b.nodes) return;
    b.nodes.forEach(function (n) {
      if (n.archived) return;
      if (n.status === 'inbox') return;
      total++;
      if (n.status === 'done') done++;
    });
  });
  return { total: total, done: done };
}

// —— CLI 便捷操作 ——
// 添加任务到活跃看板
function cliAddTask(title) {
  var t = loadTasks();
  if (!t.boards || t.boards.length === 0) {
    // 没有看板 → 创建一个
    t.boards = [{ id: genId('b'), name: '今日工作流', nodes: [], links: [] }];
    t.activeBoardId = t.boards[0].id;
  }
  var board = getActiveBoard() || t.boards[0];
  var node = {
    id: genId('t'),
    x: 100, y: 100,
    status: 'today',
    num: String(board.nodes.length + 1).padStart(2, '0'),
    title: title,
    desc: '来自 CLI',
    priority: 2,
    createdAt: new Date().toISOString(),
    source: 'cli',
  };
  board.nodes.push(node);
  setTasks(t);
  return node;
}

// CLI 按标题模糊匹配标记完成
function cliCompleteTask(match) {
  var t = loadTasks();
  var found = [];
  var lower = (match || '').toLowerCase();
  if (!t.boards) return [];
  t.boards.forEach(function (b) {
    if (!b.nodes) return;
    b.nodes.forEach(function (n) {
      if (n.title.indexOf(match) >= 0 || n.title.toLowerCase().indexOf(lower) >= 0) {
        n.status = 'done';
        n.doneAt = new Date().toISOString();
        found.push(n);
      }
    });
  });
  if (found.length > 0) setTasks(t);
  return found;
}

// —— 小工具：生成全局唯一 id ——
// 用 crypto.randomUUID（v4，122 位随机，碰撞概率可忽略），保留可读前缀。
// 旧实现 Date.now()+Math.random 在快速连续创建时存在极小碰撞可能。
function genId(prefix) {
  var uuid;
  try { uuid = crypto.randomUUID(); } catch (_) {
    // 极旧 Node 兜底（randomUUID 需 Node ≥14.17）
    uuid = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
  }
  return (prefix || 't') + uuid.replace(/-/g, '').slice(0, 16);
}

/* ============================================================
   其他数据文件（settings / recaps / agentRuns / modelConfig）
   结构较简单，统一用通用 load/save 接口
   ============================================================ */
function load(name) {
  // name: 'settings' | 'recaps' | 'agentRuns' | 'modelConfig'
  var file = FILES[name];
  var key = name;
  if (cache[key]) return cache[key];
  cache[key] = readJson(file, {});
  return cache[key];
}

function save(name, data) {
  var file = FILES[name];
  cache[name] = data;
  writeJsonDebounced(file, data);
  return true;
}

function saveNow(name, data) {
  var file = FILES[name];
  cache[name] = data;
  return writeJsonSync(file, data);
}

/* ============================================================
   agent-runs.json — Agent 运行历史（规范化）
   持久形状：{ runs: [...] }，每条 run = { taskId, nodeId, agent, agentId,
     status, prompt, output, startTime, endTime, exitCode, cwd }
   旧文件兜底：若读取到的是数组或 {}，自动规范化为 { runs: [] }
   ============================================================ */
function _normalizeAgentRuns(raw) {
  if (!raw) return { runs: [] };
  if (Array.isArray(raw)) return { runs: raw };
  if (Array.isArray(raw.runs)) return { runs: raw.runs };
  return { runs: [] };
}

function getAgentRuns() {
  var data = _normalizeAgentRuns(load('agentRuns'));
  // 按 startTime 倒序（最新的在前）
  data.runs.sort(function (a, b) {
    var ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    var tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tb - ta;
  });
  return data.runs;
}

function findAgentRun(taskId) {
  if (!taskId) return null;
  var runs = getAgentRuns();
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].taskId === taskId) return runs[i];
  }
  return null;
}

// 追加一条 Agent 运行记录（同 taskId 覆盖，最多保留 200 条）
function addAgentRun(run) {
  if (!run || !run.taskId) return false;
  var data = _normalizeAgentRuns(load('agentRuns'));
  // output 截断，避免单条过长撑爆文件
  var clean = {
    taskId: run.taskId,
    nodeId: run.nodeId || null,
    agent: run.agent || '',
    agentId: run.agentId || '',
    status: run.status || 'unknown',
    prompt: (run.prompt || '').slice(0, 500),
    output: (run.output || '').slice(-4096),
    startTime: run.startTime || new Date().toISOString(),
    endTime: run.endTime || null,
    exitCode: run.exitCode,
    cwd: run.cwd || '',
  };
  // 同 taskId 覆盖
  var replaced = false;
  for (var i = 0; i < data.runs.length; i++) {
    if (data.runs[i].taskId === clean.taskId) { data.runs[i] = clean; replaced = true; break; }
  }
  if (!replaced) data.runs.unshift(clean);
  // 限制最多 200 条
  if (data.runs.length > 200) data.runs = data.runs.slice(0, 200);
  save('agentRuns', data);
  return true;
}

/* ============================================================
   recaps.json — 每日复盘快照（规范化）
   持久形状：{ items: [...] }，每条 = { id, date:'YYYY-MM-DD', createdAt, summary,
     doneCount, totalCount, aiCount, doneTasks:[], missTasks:[], advice }
   旧文件兜底：数组或 {} → { items: [] }
   ============================================================ */
function _normalizeRecaps(raw) {
  if (!raw) return { items: [] };
  if (Array.isArray(raw)) return { items: raw };
  if (Array.isArray(raw.items)) return { items: raw.items };
  return { items: [] };
}

function getRecaps() {
  var data = _normalizeRecaps(load('recaps'));
  // 按 date 倒序
  data.items.sort(function (a, b) {
    return (b.date || '').localeCompare(a.date || '');
  });
  return data.items;
}

// 追加一条复盘快照（同 date 覆盖，最多保留 90 条）
function addRecap(recap) {
  if (!recap || !recap.date) return false;
  var data = _normalizeRecaps(load('recaps'));
  // 同 date 覆盖
  var replaced = false;
  for (var i = 0; i < data.items.length; i++) {
    if (data.items[i].date === recap.date) { data.items[i] = recap; replaced = true; break; }
  }
  if (!replaced) data.items.unshift(recap);
  // 限制最多 90 条
  if (data.items.length > 90) data.items = data.items.slice(0, 90);
  save('recaps', data);
  return true;
}

// —— 数据导出 / 备份 ——
function exportAll() {
  return {
    tasks: loadTasks(),
    settings: load('settings'),
    recaps: load('recaps'),
    agentRuns: load('agentRuns'),
    modelConfig: load('modelConfig'),
    exportedAt: new Date().toISOString(),
    version: 4,
  };
}

// —— 数据导入 ——
function importAll(data) {
  if (!data) return false;
  if (data.tasks) { cache.tasks = normalizeTasks(data.tasks); writeJsonSync(FILES.tasks, cache.tasks); }
  if (data.settings) { cache.settings = data.settings; writeJsonSync(FILES.settings, data.settings); }
  if (data.recaps) { cache.recaps = data.recaps; writeJsonSync(FILES.recaps, data.recaps); }
  if (data.agentRuns) { cache.agentRuns = data.agentRuns; writeJsonSync(FILES.agentRuns, data.agentRuns); }
  if (data.modelConfig) { cache.modelConfig = data.modelConfig; writeJsonSync(FILES.modelConfig, data.modelConfig); }
  return true;
}

// —— 清除所有数据（重置）——
function clearAll() {
  cache.tasks = { boards: [], activeBoardId: null, version: 4 };
  writeJsonSync(FILES.tasks, cache.tasks);
  // 同步重置结构化存储
  cache.agentRuns = { runs: [] };
  writeJsonSync(FILES.agentRuns, cache.agentRuns);
  cache.recaps = { items: [] };
  writeJsonSync(FILES.recaps, cache.recaps);
  return true;
}

// —— 模块导出 ——
module.exports = {
  FILES: FILES,
  // tasks
  loadTasks: loadTasks,
  getTasks: getTasks,
  setTasks: setTasks,
  saveTasksNow: saveTasksNow,
  getAllNodes: getAllNodes,
  findNode: findNode,
  getBoard: getBoard,
  getActiveBoard: getActiveBoard,
  getCounts: getCounts,
  cliAddTask: cliAddTask,
  cliCompleteTask: cliCompleteTask,
  // generic
  load: load,
  save: save,
  saveNow: saveNow,
  // agent-runs 历史
  getAgentRuns: getAgentRuns,
  findAgentRun: findAgentRun,
  addAgentRun: addAgentRun,
  // recaps 复盘快照
  getRecaps: getRecaps,
  addRecap: addRecap,
  // backup
  exportAll: exportAll,
  importAll: importAll,
  clearAll: clearAll,
  flushAll: flushAll,
  genId: genId,
};
