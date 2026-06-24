/* ============================================================
   dispatchClient.js — AI 派活请求层
   ------------------------------------------------------------
   从 dock.html 抽离，负责：
   - 调用 agent-server 的 /api/dispatch-plan（含浏览器降级）
   - AI 分发规划弹窗的打开 / 渲染 / 关闭
   - 从分发方案创建白板任务卡

   依赖（运行时从 window.DOCK 取，不写死 import）：
     window.DOCK.util       : { $, $$, esc, toast }
     window.DOCK.store      : { activeBoard, createBoard, bMakeNode, uid, save }
     window.DOCK.app        : { refreshAll, setMode, bFullRender, bAddNode }
       (createBoard / bMakeNode / bAddNode / bFullRender / setMode / refreshAll
        仍在 dock.html 中，通过 window.DOCK.app 暴露回调)

   暴露（挂到 window.DOCK.dispatch）：
     dispatchAI()                 展开模式输入框派活入口
     openDispatchPlanner(node)    为指定节点打开分发规划弹窗
     closeDispatchPlanner()       关闭弹窗
     callDispatchPlan(reqBody)    底层 HTTP 请求（可单独测试）
     renderDispatchPlan(plan)     渲染分发方案（暴露以便测试/复用）
     createTaskCardsFromPlan(plan, sourceNode)  从方案创建白板卡
   ============================================================ */
(function () {
  // 从全局取依赖（统一通过 _d() 拿，避免每次写一长串）
  function U() { return (window.DOCK && window.DOCK.util) || {}; }
  function S() { return (window.DOCK && window.DOCK.store) || {}; }
  function A() { return (window.DOCK && window.DOCK.app) || {}; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // —— 分发对象 / 优先级 / 任务类型 中文映射 ——
  var ROUTE_LABELS = {
    human: '我自己处理', planning_agent: '继续让 AI 规划',
    design_agent: '交给设计 Agent', code_agent: '交给代码 Agent',
    research_agent: '交给研究 Agent', later: '暂存以后做'
  };
  var ROUTE_COLORS = {
    human: 'var(--accent-ink)', planning_agent: 'var(--info-ink)',
    design_agent: '#8b5cf6', code_agent: 'var(--success)',
    research_agent: 'var(--warn-ink)', later: 'var(--muted)'
  };
  var PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
  var TASK_TYPE_LABELS = {
    product_design: '产品设计', ui_design: 'UI设计', code_task: '代码开发',
    research: '调研', study: '学习', life_task: '生活事务',
    mixed: '混合型', unknown: '未分类'
  };

  // —— 弹窗 DOM 引用（懒创建）——
  var dpOverlay = null, dpDrawerBody = null, dpDrawerAct = null, dpSourceNode = null;

  // —— 底层请求：调用 agent-server ——
  // 优先走 Electron IPC 代理（若 preload 暴露了 dispatchPlan），否则直接 fetch
  function callDispatchPlan(reqBody) {
    if (window.dock && window.dock.dispatchPlan) {
      return window.dock.dispatchPlan(reqBody);
    }
    return fetch('http://localhost:3874/api/dispatch-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    }).then(function (r) { return r.json(); });
  }

  // —— 确保分发弹窗 DOM 已创建 ——
  function ensureDispatchOverlay() {
    if (dpOverlay) return;
    dpOverlay = document.createElement('div');
    dpOverlay.className = 'overlay';
    dpOverlay.id = 'dpOverlay';
    dpOverlay.innerHTML =
      '<div class="drawer" style="max-width:560px">' +
      '<div class="drawer__head">' +
      '<div class="drawer__icon" style="background:var(--info-soft);color:var(--info-ink)"><svg><use href="#px-bot"/></svg></div>' +
      '<div class="drawer__titles"><div class="drawer__title" id="dpTitle">AI 分发规划</div><div class="drawer__sub" id="dpSub">智能识别任务类型 · 生成分发方案</div></div>' +
      '<button class="drawer__close" id="dpClose"><svg><use href="#i-x"/></svg></button>' +
      '</div>' +
      '<div class="drawer__body" id="dpBody" style="max-height:60vh;overflow-y:auto"></div>' +
      '<div class="drawer__act" id="dpAct"></div>' +
      '</div>';
    document.body.appendChild(dpOverlay);
    dpDrawerBody = $('#dpBody');
    dpDrawerAct = $('#dpAct');
    $('#dpClose').addEventListener('click', closeDispatchPlanner);
    dpOverlay.addEventListener('click', function (e) { if (e.target === dpOverlay) closeDispatchPlanner(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dpOverlay.classList.contains('is-open')) closeDispatchPlanner();
    });
  }

  function closeDispatchPlanner() {
    if (!dpOverlay) return;
    dpOverlay.classList.remove('is-open');
    document.body.style.overflow = '';
    dpSourceNode = null;
  }

  // —— 为指定节点打开分发规划 ——
  function openDispatchPlanner(node) {
    var util = U();
    ensureDispatchOverlay();
    dpSourceNode = node;
    $('#dpTitle').textContent = node.title || 'AI 分发规划';

    // 阶段 1：加载中
    dpDrawerBody.innerHTML = '<div style="text-align:center;padding:30px"><span class="spinner" style="width:24px;height:24px;margin-bottom:12px"></span><div style="font-size:12px;color:var(--muted)">正在识别任务类型…</div></div>';
    dpDrawerAct.innerHTML = '';
    dpOverlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    // 构建请求：带白板上下文（排除自身和已归档）
    var store = S();
    var board = store.activeBoard ? store.activeBoard() : null;
    var boardContext = (board ? board.nodes : []).filter(function (n) {
      return n.id !== node.id && !n.archived;
    }).slice(0, 8).map(function (n) {
      return { id: n.id, title: n.title, content: n.desc || '', status: n.status || 'todo' };
    });
    var reqBody = {
      noteId: node.id,
      title: node.title || '',
      content: node.desc && node.desc !== '双击写点什么' ? node.desc : (node.title || ''),
      boardContext: boardContext
    };

    // 阶段提示切换
    setTimeout(function () {
      if (dpOverlay.classList.contains('is-open')) {
        var spinEl = dpDrawerBody.querySelector('div');
        if (spinEl) spinEl.innerHTML = '<span class="spinner" style="width:24px;height:24px;margin-bottom:12px"></span><div style="font-size:12px;color:var(--muted)">正在拆解任务 · 生成分发方案…</div>';
      }
    }, 1500);

    callDispatchPlan(reqBody).then(function (r) {
      if (r && r.ok && r.plan) {
        renderDispatchPlan(r.plan);
      } else {
        // 服务不可用降级提示
        dpDrawerBody.innerHTML = '<div style="padding:20px;text-align:center">' +
          '<div style="font-size:28px;margin-bottom:8px">🔌</div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--fg-strong);margin-bottom:6px">Pi SDK 服务未启动</div>' +
          '<div style="font-size:11px;color:var(--muted);line-height:1.7">' +
          '请先启动 agent-server：<br>' +
          '<code style="font-size:10px;background:var(--card-2);padding:2px 6px;border-radius:4px">cd agent-server && npm install && npm run dev</code>' +
          '</div></div>';
        dpDrawerAct.innerHTML = '<button class="btn btn--primary" id="dpCloseBtn" style="flex:1">关闭</button>';
        $('#dpCloseBtn').addEventListener('click', closeDispatchPlanner);
      }
    }).catch(function (err) {
      var esc = util.esc || String;
      dpDrawerBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">请求失败：' + esc(err.message || err) + '</div>';
      dpDrawerAct.innerHTML = '<button class="btn btn--ghost" id="dpErrClose" style="flex:1">关闭</button>';
      $('#dpErrClose').addEventListener('click', closeDispatchPlanner);
    });
  }

  // —— 渲染分发方案 ——
  function renderDispatchPlan(plan) {
    var util = U();
    var esc = util.esc || String;
    if (!plan) { closeDispatchPlanner(); return; }
    var html = '';

    // 顶部摘要
    html += '<div style="margin-bottom:14px;padding:10px 12px;background:var(--info-soft);border-radius:var(--r-sub);border:1px solid var(--hair)">';
    html += '<div style="font-size:13px;font-weight:600;color:var(--fg-strong);margin-bottom:4px">' + esc(plan.summary || '') + '</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:10px">';
    if (plan.taskType) {
      html += '<span class="bchip" style="background:var(--ink-soft);color:var(--ink-strong);padding:2px 8px;border-radius:var(--r-pill)">' + esc(TASK_TYPE_LABELS[plan.taskType] || plan.taskType) + '</span>';
    }
    if (typeof plan.confidence === 'number') {
      html += '<span style="color:var(--muted)">置信度 ' + Math.round(plan.confidence * 100) + '%</span>';
    }
    html += '</div>';
    if (plan.missingInfo && plan.missingInfo.length > 0) {
      html += '<div style="margin-top:6px;font-size:10px;color:var(--warn-ink)">⚠️ 缺失：' + esc(plan.missingInfo.join('、')) + '</div>';
    }
    html += '</div>';

    // 多视角分析
    if (plan.perspectives && plan.perspectives.length > 0) {
      var pColors = ['var(--ink)', 'var(--warn-ink)', 'var(--success)'];
      var pIcons = ['#i-search', '#i-spark', '#i-check'];
      html += '<details style="margin-bottom:14px"><summary style="font-size:11px;font-weight:700;color:var(--info-ink);cursor:pointer;display:flex;align-items:center;gap:5px"><svg style="width:12px;height:12px"><use href="#i-spark"/></svg>多视角分析（' + plan.perspectives.length + ' 个视角 · 点击展开）</summary>';
      html += '<div style="margin-top:8px">';
      plan.perspectives.forEach(function (p, i) {
        html += '<div style="margin-bottom:8px;padding:9px 11px;border:1px solid var(--hair);border-radius:var(--r-sub);background:var(--card-2);border-left:3px solid ' + (pColors[i] || 'var(--muted)') + '">';
        html += '<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;font-size:10px;font-weight:700;color:' + (pColors[i] || 'var(--muted)') + '">';
        html += '<svg style="width:11px;height:11px"><use href="' + (pIcons[i] || '#i-spark') + '"/></svg>' + esc(p.perspective) + '</div>';
        html += '<div style="font-size:11px;line-height:1.6;color:var(--fg);white-space:pre-wrap">' + esc(p.analysis) + '</div>';
        html += '</div>';
      });
      html += '</div></details>';
    }

    // 分发卡片列表
    if (plan.dispatchPlan && plan.dispatchPlan.length > 0) {
      html += '<div class="ai-step-label" style="margin-bottom:8px">分发方案（' + plan.dispatchPlan.length + ' 项）</div>';
      plan.dispatchPlan.forEach(function (t) {
        var rc = ROUTE_COLORS[t.routeTo] || 'var(--muted)';
        var rl = ROUTE_LABELS[t.routeTo] || t.routeTo || '未指定';
        var pl = PRIORITY_LABELS[t.priority] || t.priority || '中';
        html += '<div style="margin-bottom:10px;padding:10px 12px;border:1px solid var(--hair);border-radius:var(--r-sub);background:var(--card-2);border-left:3px solid ' + rc + '">';
        html += '<div style="display:flex;justify-content:space-between;align-items:start;gap:8px;margin-bottom:6px">';
        html += '<div style="font-size:12px;font-weight:600;color:var(--fg-strong);flex:1">' + esc(t.title || '') + '</div>';
        html += '<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:var(--r-pill);background:' + rc + '22;color:' + rc + ';white-space:nowrap">' + esc(rl) + '</span>';
        html += '</div>';
        if (t.goal) html += '<div style="font-size:11px;color:var(--muted);margin-bottom:4px"><b>目标：</b>' + esc(t.goal) + '</div>';
        if (t.reason) html += '<div style="font-size:10.5px;color:var(--muted-2);margin-bottom:4px;line-height:1.5"><b>理由：</b>' + esc(t.reason) + '</div>';
        if (t.expectedOutput) html += '<div style="font-size:10.5px;color:var(--muted-2);margin-bottom:4px;line-height:1.5"><b>预期：</b>' + esc(t.expectedOutput) + '</div>';
        html += '<div style="display:flex;gap:6px;align-items:center;margin-top:4px"><span style="font-size:9px;color:var(--muted)">优先级：' + esc(pl) + '</span></div>';
        if (t.promptForNextAgent) {
          html += '<details style="margin-top:6px"><summary style="font-size:10px;color:var(--info-ink);cursor:pointer">📋 提示词/行动建议</summary>';
          html += '<pre style="font-size:10px;background:var(--card);padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-word;margin-top:4px;border:1px solid var(--hair)">' + esc(t.promptForNextAgent) + '</pre>';
          html += '<button class="btn btn--ghost dp-copy-prompt" data-prompt="' + esc(t.promptForNextAgent) + '" style="margin-top:4px;font-size:10px;padding:4px 10px">复制</button>';
          html += '</details>';
        }
        html += '</div>';
      });
    }

    if (plan.suggestedNextAction) {
      html += '<div style="margin-top:8px;padding:8px 10px;background:var(--success-soft);border-radius:var(--r-sub);font-size:11px;color:var(--fg)"><b>👉 下一步：</b>' + esc(plan.suggestedNextAction) + '</div>';
    }

    dpDrawerBody.innerHTML = html;

    // 绑定复制提示词
    $$('.dp-copy-prompt').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var text = btn.dataset.prompt;
        var toast = U().toast;
        if (window.dock && window.dock.ai && window.dock.ai.copyToClipboard) {
          window.dock.ai.copyToClipboard(text).then(function () { if (toast) toast('提示词已复制', '#i-copy', true); });
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { if (toast) toast('提示词已复制', '#i-copy', true); });
        }
      });
    });

    // 底部操作
    dpDrawerAct.innerHTML =
      '<button class="btn btn--ghost" id="dpCancel" style="flex:1">取消</button>' +
      '<button class="btn btn--ghost" id="dpRetry" style="flex:1">重新规划</button>' +
      '<button class="btn btn--primary" id="dpSave" style="flex:1"><svg><use href="#i-check"/></svg>保存为任务卡</button>';
    $('#dpCancel').addEventListener('click', closeDispatchPlanner);
    $('#dpRetry').addEventListener('click', function () { if (dpSourceNode) openDispatchPlanner(dpSourceNode); });
    $('#dpSave').addEventListener('click', function () {
      createTaskCardsFromPlan(plan, dpSourceNode);
      closeDispatchPlanner();
    });

    $('#dpSub').textContent = '识别为「' + (TASK_TYPE_LABELS[plan.taskType] || plan.taskType || '未分类') + '」· ' + (plan.dispatchPlan ? plan.dispatchPlan.length : 0) + ' 项分发';
  }

  // —— 从分发方案创建白板任务卡 ——
  function createTaskCardsFromPlan(plan, sourceNode) {
    var util = U(), store = S(), app = A();
    var esc = util.esc || String;
    // sourceNode 未传时使用内部维护的 dpSourceNode
    sourceNode = sourceNode || dpSourceNode;
    if (!plan || !plan.dispatchPlan || plan.dispatchPlan.length === 0) {
      if (util.toast) util.toast('没有可保存的分发方案', '#i-x');
      return;
    }
    // 为本次分发创建独立白板
    var srcTitle = (sourceNode && sourceNode.title) ? sourceNode.title : '分发任务';
    var boardTitle = srcTitle.slice(0, 14);
    if (srcTitle.length > 14) boardTitle += '…';
    var taskTypeLabel = TASK_TYPE_LABELS[plan.taskType] || plan.taskType || '';
    var newBoardName = '[' + taskTypeLabel + '] ' + boardTitle;
    // createBoard / bMakeNode / bAddNode 是 app 编排器（含 DOM 渲染与 tSave），
    // 一律走 window.DOCK.app 网关，不再反向注入到 store。
    var newBoard = app.createBoard ? app.createBoard(newBoardName) : store.createBoard(newBoardName);
    // createBoard 已切换 activeBoardId 并 syncActiveRefs

    var cols = [
      { x: 30, y: 30 }, { x: 300, y: 30 }, { x: 570, y: 30 },
      { x: 30, y: 280 }, { x: 300, y: 280 }, { x: 570, y: 280 },
      { x: 30, y: 530 }, { x: 300, y: 530 }, { x: 570, y: 530 }
    ];
    var createdNodes = [];
    plan.dispatchPlan.forEach(function (t, i) {
      var pos = cols[i % cols.length];
      var st = 'planning';
      if (t.routeTo === 'human') st = 'manual';
      else if (t.routeTo === 'later') st = 'inbox';
      else if (t.routeTo === 'code_agent' || t.routeTo === 'design_agent' || t.routeTo === 'research_agent' || t.routeTo === 'planning_agent') st = 'ai';
      var makeNode = app.bMakeNode || store.bMakeNode;
      var node = makeNode(pos.x, pos.y, {
        title: t.title || '未命名任务',
        desc: t.goal || '',
        status: st,
        num: String(i + 1).padStart(2, '0'),
        priority: t.priority === 'high' ? 1 : (t.priority === 'low' ? 3 : 2)
      });
      node.dispatchMeta = {
        sourceNoteId: plan.sourceNoteId || '',
        routeTo: t.routeTo || 'human',
        reason: t.reason || '',
        expectedOutput: t.expectedOutput || '',
        priority: t.priority || 'medium',
        promptForNextAgent: t.promptForNextAgent || '',
        taskType: plan.taskType || 'unknown'
      };
      createdNodes.push(node);
    });

    // 自动连线：串联
    var tasks = store.getTasks();
    for (var j = 0; j < createdNodes.length - 1; j++) {
      tasks.links.push({ id: store.uid('l'), from: createdNodes[j].id, to: createdNodes[j + 1].id, dashed: false });
    }

    // 标记源节点为已分发
    if (sourceNode) {
      sourceNode.desc = '已分发 → ' + newBoardName;
      sourceNode.status = 'done';
      sourceNode.completedAt = new Date().toISOString();
      sourceNode.dispatchedToBoard = newBoard.id;
    }

    if (app.bFullRender) app.bFullRender();
    store.save();
    if (app.refreshAll) app.refreshAll();
    if (util.toast) util.toast('已创建独立白板「' + newBoardName + '」· ' + createdNodes.length + ' 张任务卡', '#i-check2', true);
    if (app.setMode) app.setMode('board');
  }

  // —— 展开模式输入框派活入口 ——
  // dispatchAI 需要 aiInput / aiSend，但这两个 DOM 在 dock.html 里绑定事件。
  // 这里暴露纯逻辑版本：传入文本即可。
  function dispatchFromText(text) {
    var util = U(), store = S(), app = A();
    if (!text || !text.trim()) {
      if (util.toast) util.toast('先输入一个任务描述', '#i-spark');
      return null;
    }
    var addNode = app.bAddNode || store.bAddNode;
    var newNode = addNode(100, 100, { title: text.trim(), desc: '待分发', status: 'planning', priority: 2 });
    openDispatchPlanner(newNode);
    return newNode;
  }

  // 挂载到全局命名空间
  window.DOCK = window.DOCK || {};
  window.DOCK.dispatch = {
    dispatchAI: dispatchFromText,           // 兼容旧名（接收文本）
    dispatchFromText: dispatchFromText,
    openDispatchPlanner: openDispatchPlanner,
    closeDispatchPlanner: closeDispatchPlanner,
    callDispatchPlan: callDispatchPlan,
    renderDispatchPlan: renderDispatchPlan,
    createTaskCardsFromPlan: createTaskCardsFromPlan,
    ROUTE_LABELS: ROUTE_LABELS,
    TASK_TYPE_LABELS: TASK_TYPE_LABELS,
    PRIORITY_LABELS: PRIORITY_LABELS
  };
})();
