/* ============================================================
   taskStore.js — 任务数据层（纯数据 / CRUD / 持久化 / 归档 / 依赖排序 / 迁移）
   ------------------------------------------------------------
   从 dock.html 抽离，负责所有任务数据的读写与变换。
   不接触 DOM、不关心 UI，只暴露纯函数和共享状态。

   依赖：无（仅依赖传入的 consts，由 dock.html 在加载本文件前注入 window.DOCK.consts）

   暴露（挂到 window.DOCK.store）：
     state              当前任务状态对象（tasks）
     consts             常量（TSTORAGE / TSTATUSES / TLABELS / TPILL / BNW / BNH）
     clone / uid / clamp / sign   小工具
     activeBoard / syncActiveRefs  当前活跃看板
     allNodes / allLinks           跨项目聚合
     findNodeAcrossBoards          按 id 跨项目查找节点
     counts                        done/total 统计
     save / pushHistory            持久化 / 历史栈
     autoArchive                   自动归档
     sortByDependencies            拓扑排序
     setTasks / getTasks           内部状态读写（迁移/初始化用）
     upgradeAiContext              旧 aiContext.plan → steps 升级
   ============================================================ */
(function () {
  // —— 常量（与 dock.html 原定义保持一致）——
  var TSTORAGE = 'dailyDockTasks:v3';
  var TSTATUSES = ['inbox', 'planning', 'ai', 'manual', 'today', 'done', 'blocked'];
  var TLABELS = {
    inbox: '收件', planning: '规划', ai: 'AI执行', manual: '人工',
    today: '今日', done: '完成', blocked: '阻塞'
  };
  var TPILL = {
    inbox:    { cls: 'pill--todo', txt: '收件' },
    planning: { cls: 'pill--todo', txt: '待开始' },
    ai:       { cls: 'pill--ai',   txt: 'AI处理中' },
    manual:   { cls: 'pill--todo', txt: '待处理' },
    today:    { cls: 'pill--now',  txt: '进行中' },
    done:     { cls: 'pill--done', txt: '已完成' },
    blocked:  { cls: 'pill--need', txt: '阻塞' }
  };
  var BNW = 172, BNH = 130;

  // —— 核心状态（与 dock.html 原始结构完全一致）——
  //   tasks = {
  //     boards: [{ id, name, nodes:[], links:[] }, ...],
  //     activeBoardId: 'xxx',
  //     nodes: [], links: []   // 当前活跃看板的快捷引用
  //   }
  var tasks = { boards: [], activeBoardId: null, nodes: [], links: [] };

  // —— 小工具 ——
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // 生成全局唯一 id（保留可读前缀）。
  // 优先用 Web Crypto 的 getRandomValues（渲染层可用），比纯 Math.random 碰撞概率更低。
  function uid(p) {
    var prefix = (p || 't');
    try {
      // 渲染层（contextIsolation）下 crypto.getRandomValues 可用
      var bytes = new Uint8Array(8);
      window.crypto.getRandomValues(bytes);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += ('0' + bytes[i].toString(16)).slice(-2);
      }
      return prefix + hex;
    } catch (e) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }

  // —— 当前活跃看板 ——
  function activeBoard() {
    if (!tasks.boards || !Array.isArray(tasks.boards)) return null;
    return tasks.boards.filter(function (b) { return b.id === tasks.activeBoardId; })[0] || null;
  }
  // 把当前活跃看板的 nodes/links 同步到顶层快捷引用
  function syncActiveRefs() {
    var b = activeBoard();
    if (b) { tasks.nodes = b.nodes; tasks.links = b.links; }
    else { tasks.nodes = []; tasks.links = []; }
  }

  // —— 跨项目聚合：所有看板的节点 / 连线扁平数组 ——
  function allNodes() {
    var arr = [];
    if (!tasks.boards) return arr;
    tasks.boards.forEach(function (b) { if (b.nodes) b.nodes.forEach(function (n) { arr.push(n); }); });
    return arr;
  }
  function allLinks() {
    var arr = [];
    if (!tasks.boards) return arr;
    tasks.boards.forEach(function (b) { if (b.links) b.links.forEach(function (l) { arr.push(l); }); });
    return arr;
  }

  // —— 按 id 跨所有项目查找节点 ——
  function findNodeAcrossBoards(id) {
    var found = null;
    tasks.boards.forEach(function (b) {
      if (!found) { found = b.nodes.filter(function (n) { return n.id === id; })[0]; }
    });
    return found;
  }

  // —— 持久化（防抖保存）——
  // Electron 环境：通过 IPC 推送到主进程（主进程写入 userData/tasks.json）
  // 浏览器降级：写入 localStorage（用于 http-server 测试环境）
  var saveTimer = null;
  function saveLocalLegacy() {
    // 浏览器降级路径：写 localStorage
    var saveData = { boards: tasks.boards, activeBoardId: tasks.activeBoardId };
    try { localStorage.setItem(TSTORAGE, JSON.stringify(saveData)); } catch (e) {}
  }
  function save() {
    var savedEl = document.querySelector('#boardSaved');
    if (savedEl) { savedEl.textContent = '保存中…'; savedEl.style.color = 'var(--muted)'; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (window.dock && window.dock.tasks) {
        // Electron：推送全量数据到主进程（主进程防抖写入 tasks.json）
        var saveData = { boards: tasks.boards, activeBoardId: tasks.activeBoardId };
        window.dock.tasks.save(saveData).then(function () {
          if (savedEl) { savedEl.textContent = '已保存'; savedEl.style.color = 'var(--success)'; }
        }).catch(function () {
          if (savedEl) { savedEl.textContent = '保存失败'; savedEl.style.color = 'var(--danger)'; }
        });
      } else {
        // 浏览器降级
        saveLocalLegacy();
        if (savedEl) { savedEl.textContent = '已保存'; savedEl.style.color = 'var(--success)'; }
      }
    }, 300);
  }

  // —— 历史栈（白板撤销用）——
  var history = [];
  function pushHistory() {
    history.push(clone(tasks));
    if (history.length > 60) history.shift();
  }
  function popHistory() { return history.length ? history.pop() : null; }
  function clearHistory() { history = []; }
  function historyLength() { return history.length; }

  // —— 统计：done / total（排除已归档和 inbox）——
  function counts() {
    var active = [], done = 0;
    if (!tasks.boards || !Array.isArray(tasks.boards)) return { total: 0, done: 0 };
    tasks.boards.forEach(function (b) {
      if (!b.nodes) return;
      b.nodes.forEach(function (n) {
        if (n.archived) return;
        if (n.status === 'inbox') return;
        active.push(n);
        if (n.status === 'done') done++;
      });
    });
    return { total: active.length, done: done };
  }

  // —— 自动归档：done 超过 2 天 → 标记 archived ——
  var ARCHIVE_DAYS = 2;
  var ARCHIVE_MS = ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
  function autoArchive() {
    if (!tasks.boards || !Array.isArray(tasks.boards)) return;
    var now = Date.now();
    var changed = false;
    tasks.boards.forEach(function (b) {
      b.nodes.forEach(function (n) {
        if (n.status === 'done' && !n.archived && n.doneAt) {
          var doneTime = new Date(n.doneAt).getTime();
          if ((now - doneTime) > ARCHIVE_MS) { n.archived = true; changed = true; }
        }
        if (n.archived && n.status !== 'done') { n.archived = false; changed = true; }
        if (n.status !== 'done' && n.doneAt) { n.doneAt = null; }
      });
    });
    if (changed) {
      save();
      var archivedCount = 0;
      tasks.boards.forEach(function (b) {
        archivedCount += b.nodes.filter(function (n) { return n.archived; }).length;
      });
      return { changed: true, archivedCount: archivedCount };
    }
    return { changed: false, archivedCount: 0 };
  }

  /* —— 拓扑排序：实线=强依赖（阻塞），虚线/点线=弱依赖（不阻塞）——
     返回 [{ n, deps, depDone, depNames }] 已排序数组。
     排序规则：done 最后；前置已完成排前；同层按状态优先级。
  */
  function sortByDependencies(nodes, links) {
    var nodeMap = {};
    nodes.forEach(function (n) { nodeMap[n.id] = { n: n, deps: [], depDone: true }; });
    (links || []).filter(function (l) {
      var lt = l.linkType || (!l.dashed ? 'solid' : 'dashed');
      return lt === 'solid';
    }).forEach(function (l) {
      if (nodeMap[l.to]) nodeMap[l.to].deps.push(l.from);
    });
    var doneIds = {};
    nodes.filter(function (n) { return n.status === 'done'; }).forEach(function (n) { doneIds[n.id] = true; });
    Object.keys(nodeMap).forEach(function (id) {
      var nd = nodeMap[id];
      nd.depDone = nd.deps.every(function (d) { return doneIds[d]; });
      nd.depNames = nd.deps.map(function (d) {
        var dn = nodes.filter(function (x) { return x.id === d; })[0];
        return dn ? dn.title : '';
      }).filter(function (t) { return t; });
    });
    var statusRank = { today: 0, planning: 1, ai: 2, manual: 3, blocked: 4, done: 5, inbox: 6 };
    var arr = nodes.map(function (n) { return nodeMap[n.id]; });
    arr.sort(function (a, b) {
      if (a.n.status === 'done' && b.n.status !== 'done') return 1;
      if (b.n.status === 'done' && a.n.status !== 'done') return -1;
      if (a.depDone && !b.depDone) return -1;
      if (!a.depDone && b.depDone) return 1;
      var ra = statusRank[a.n.status] || 3, rb = statusRank[b.n.status] || 3;
      if (ra !== rb) return ra - rb;
      return 0;
    });
    return arr;
  }

  // —— 旧数据升级：aiContext.plan(string[]) → aiContext.steps(object[]) ——
  function upgradeAiContext() {
    if (!tasks.boards) return false;
    var changed = false;
    tasks.boards.forEach(function (b) {
      if (!b.nodes) return;
      b.nodes.forEach(function (n) {
        if (n.aiContext && n.aiContext.plan && !n.aiContext.steps) {
          n.aiContext.steps = n.aiContext.plan.map(function (s) {
            return { text: s, status: 'pending', result: null, aiAssisted: false };
          });
          delete n.aiContext.plan;
          changed = true;
        }
      });
    });
    if (changed) save();
    return changed;
  }

  // —— 内部状态读写（供迁移 / 初始化使用）——
  function getTasks() { return tasks; }
  function setTasks(obj) {
    tasks = obj;
    syncActiveRefs();
  }

  /* —— 异步初始化：从主进程加载 tasks.json，或从 localStorage 迁移 ——
     返回 { migrated: bool, source: 'file'|'localStorage'|'empty' }
     dock.html 的 tInit 会在 DOMContentLoaded 后 await 此函数。
  */
  async function init() {
    if (window.dock && window.dock.tasks) {
      // Electron：从主进程加载
      try {
        var r = await window.dock.tasks.load();
        if (r && r.ok && r.tasks && r.tasks.boards && r.tasks.boards.length > 0) {
          // 文件中有数据 → 直接加载
          setTasks({ boards: r.tasks.boards, activeBoardId: r.tasks.activeBoardId || r.tasks.boards[0].id, nodes: [], links: [] });
          return { migrated: false, source: 'file' };
        }
        // 文件中没有数据 → 检查 localStorage 是否有旧数据需要迁移
        var migrated = await migrateFromLocalStorage();
        if (migrated) return { migrated: true, source: 'localStorage' };
        // 都没有 → 空数据（dock.html 会创建示例）
        return { migrated: false, source: 'empty' };
      } catch (e) {
        console.error('[taskStore.init] load from main failed:', e);
        return { migrated: false, source: 'error', error: e.message };
      }
    }
    // 浏览器降级：直接从 localStorage 读
    var migratedBrowser = migrateFromLocalStorageSync();
    return { migrated: migratedBrowser, source: migratedBrowser ? 'localStorage' : 'empty' };
  }

  // 从 localStorage 读取旧数据并迁移到主进程（Electron 环境）
  async function migrateFromLocalStorage() {
    var raw = null;
    try { raw = localStorage.getItem(TSTORAGE); } catch (e) {}
    if (!raw) {
      // 也检查 v2
      try { raw = localStorage.getItem('dailyDockTasks:v2'); } catch (e) {}
    }
    if (!raw) return false;

    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return false; }

    // 规范化为多看板结构
    var normalized = normalizeLegacyData(parsed);
    if (!normalized.boards || normalized.boards.length === 0) return false;

    // 推送到主进程保存
    if (window.dock && window.dock.tasks) {
      try {
        await window.dock.tasks.saveNow({ boards: normalized.boards, activeBoardId: normalized.activeBoardId });
      } catch (e) { console.error('[taskStore] migration save failed:', e); }
    }

    // 加载到内存
    setTasks({ boards: normalized.boards, activeBoardId: normalized.activeBoardId, nodes: [], links: [] });

    // 清除旧的 localStorage（保留作为备份，只加 migrated 标记）
    try { localStorage.setItem(TSTORAGE + ':migrated', '1'); } catch (e) {}
    return true;
  }

  // 浏览器降级：同步从 localStorage 读
  function migrateFromLocalStorageSync() {
    var raw = null;
    try { raw = localStorage.getItem(TSTORAGE); } catch (e) {}
    if (!raw) {
      try { raw = localStorage.getItem('dailyDockTasks:v2'); } catch (e) {}
    }
    if (!raw) return false;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return false; }
    var normalized = normalizeLegacyData(parsed);
    if (!normalized.boards || normalized.boards.length === 0) return false;
    setTasks({ boards: normalized.boards, activeBoardId: normalized.activeBoardId, nodes: [], links: [] });
    return true;
  }

  // 把各种旧格式规范化为 { boards, activeBoardId }
  function normalizeLegacyData(parsed) {
    if (parsed.boards && Array.isArray(parsed.boards) && parsed.boards.length > 0) {
      return { boards: parsed.boards, activeBoardId: parsed.activeBoardId || parsed.boards[0].id };
    }
    // 旧扁平格式（nodes/links 直接在顶层）→ 包进一个看板
    if (parsed.nodes && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
      var b = { id: uid('b'), name: '今日工作流', nodes: parsed.nodes, links: parsed.links || [] };
      return { boards: [b], activeBoardId: b.id };
    }
    return { boards: [], activeBoardId: null };
  }

  // —— 监听外部修改（CLI / 其他窗口改了数据 → 重新加载）——
  // 返回取消监听函数
  function onExternalChange(callback) {
    if (!window.dock || !window.dock.onTasksChanged) return function () {};
    return window.dock.onTasksChanged(function (payload) {
      // 从主进程重新加载最新数据到内存缓存
      if (window.dock && window.dock.tasks) {
        window.dock.tasks.load().then(function (r) {
          if (r && r.ok && r.tasks) {
            setTasks({ boards: r.tasks.boards || [], activeBoardId: r.tasks.activeBoardId, nodes: [], links: [] });
            if (callback) callback(payload);
          }
        });
      }
    });
  }

  // —— 挂载到全局命名空间 ——
  window.DOCK = window.DOCK || {};
  window.DOCK.store = {
    state: tasks,                 // 引用同一对象，外部可直接读 tasks.boards 等
    consts: { TSTORAGE: TSTORAGE, TSTATUSES: TSTATUSES, TLABELS: TLABELS, TPILL: TPILL, BNW: BNW, BNH: BNH },
    clone: clone, uid: uid, clamp: clamp, sign: sign,
    activeBoard: activeBoard, syncActiveRefs: syncActiveRefs,
    allNodes: allNodes, allLinks: allLinks, findNodeAcrossBoards: findNodeAcrossBoards,
    counts: counts,
    save: save, pushHistory: pushHistory, popHistory: popHistory,
    clearHistory: clearHistory, historyLength: historyLength,
    autoArchive: autoArchive,
    sortByDependencies: sortByDependencies,
    upgradeAiContext: upgradeAiContext,
    getTasks: getTasks, setTasks: setTasks,
    init: init,                   // 异步初始化（从主进程加载或从 localStorage 迁移）
    onExternalChange: onExternalChange,  // 监听外部修改（CLI / 其他窗口）
  };
})();
