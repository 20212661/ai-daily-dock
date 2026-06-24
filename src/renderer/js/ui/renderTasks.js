/* ============================================================
   renderTasks.js — 任务列表 UI 渲染层
   ------------------------------------------------------------
   从 dock.html 抽离，负责把任务数据渲染成 DOM：
   - renderExpandedTasks()  展开模式今日重点列表（按项目分组 + 依赖排序 + 阻塞提示）
   - renderAgentList()      status='ai' 的任务列表
   - renderAIChips()        动态快捷 chips
   - updateAIPill()         AI 任务计数
   - refreshAll()           数据变化后同步所有模式 UI（进度条/计数/当前任务等）

   依赖（运行时从 window.DOCK 取）：
     window.DOCK.util    : { $, $$, esc, toast, confirmDone }
     window.DOCK.store   : { activeBoard, allNodes, findNodeAcrossBoards, counts, sortByDependencies, save }
     window.DOCK.app     : { switchBoard, setMode }  (点击项目标题跳转白板用)

   暴露（挂到 window.DOCK.render）：
     renderExpandedTasks / renderAgentList / renderAIChips / updateAIPill / refreshAll
   ============================================================ */
(function () {
  function U() { return (window.DOCK && window.DOCK.util) || {}; }
  function S() { return (window.DOCK && window.DOCK.store) || {}; }
  function A() { return (window.DOCK && window.DOCK.app) || {}; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // —— 展开模式：今日重点列表（跨所有项目聚合，按项目分组 + 依赖排序）——
  function renderExpandedTasks() {
    var util = U(), store = S(), app = A();
    var esc = util.esc || String;
    var list = $('#exTaskList');
    if (!list) return;
    var tasks = store.getTasks();
    if (!tasks.boards || !Array.isArray(tasks.boards)) { list.innerHTML = ''; return; }

    // 跨所有项目聚合
    var groups = [];
    var allLinks = [];
    tasks.boards.forEach(function (b) {
      if (!b.nodes) return;
      var boardNodes = b.nodes.filter(function (n) { return n.status !== 'inbox' && !n.archived; });
      if (boardNodes.length > 0) groups.push({ board: b, nodes: boardNodes });
      b.links.forEach(function (l) { allLinks.push(l); });
    });

    var totalShown = groups.reduce(function (s, g) { return s + g.nodes.length; }, 0);
    if (totalShown === 0) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:12.5px;line-height:1.6">还没有今日任务<br>去<b style="color:var(--accent)">白板模式</b>把便利贴状态改为「今日」开始吧</div>';
      return;
    }

    var consts = store.consts || {};
    var TPILL = consts.TPILL || {};
    var html = '';
    var globalIdx = 0;

    groups.forEach(function (g) {
      // 项目标题（第一层）
      html += '<div class="ptask__group" data-board-id="' + g.board.id + '">'
        + '<span class="ptask__group-icon"><svg style="width:12px;height:12px"><use href="#i-board"/></svg></span>'
        + '<span class="ptask__group-name">' + esc(g.board.name) + '</span>'
        + '<span class="ptask__group-cnt">' + g.nodes.length + '</span>'
        + '</div>';
      // 该项目的节点（第二层），按依赖排序，最多显示 6 个
      var sorted = store.sortByDependencies(g.nodes, allLinks).slice(0, 6);
      sorted.forEach(function (nd) {
        globalIdx++;
        var n = nd.n;
        var pill = TPILL[n.status] || TPILL.planning || { cls: 'pill--todo', txt: '' };
        var cls = 'ptask ptask--sub';
        if (n.status === 'today') cls += ' is-now';
        if (n.status === 'done') cls += ' is-done';
        if (!nd.depDone && n.status !== 'done') cls += ' is-blocked';
        var depHint = '';
        if (!nd.depDone && n.status !== 'done') {
          depHint = '<div class="ptask__dep">⚠️ 前置未完成：' + esc(nd.depNames.join('、')) + '</div>';
        }
        html += '<div class="' + cls + '" data-ptask="' + n.id + '" data-board-id="' + g.board.id + '">'
          + '<span class="ptask__idx">' + String(globalIdx).padStart(2, '0') + '</span>'
          + '<span class="ptask__check"><svg><use href="#i-check"/></svg></span>'
          + '<div class="ptask__body">'
          + '<div class="ptask__name">' + esc(n.title) + '</div>'
          + '<div class="ptask__meta"><span class="pri pri--' + (n.priority || 2) + '">' + (n.priority || 'P2') + '</span><span class="pill ' + pill.cls + '"><span class="pd"></span>' + pill.txt + '</span></div>'
          + depHint
          + '</div></div>';
      });
    });

    list.innerHTML = html;

    // 绑定点击：勾选完成 / 取消完成
    $$('[data-ptask]', list).forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.dataset.ptask;
        var n = store.findNodeAcrossBoards(id);
        if (!n) return;
        if (n.status === 'done') {
          n.status = 'today';
          if (util.toast) util.toast('已撤回完成 · ' + n.title, '#i-refresh');
          store.save();
          refreshAll();
        } else {
          // 标记完成 → 弹确认
          if (util.confirmDone) {
            util.confirmDone(n.title, function () {
              n.status = 'done'; n.doneAt = new Date().toISOString();
              if (util.toast) util.toast('已完成 · ' + n.title, '#i-check2', true);
              store.save();
              refreshAll();
            });
          }
        }
      });
    });

    // 项目标题点击 → 跳转白板
    $$('.ptask__group', list).forEach(function (g) {
      g.addEventListener('click', function () {
        var boardId = g.dataset.boardId;
        if (app.switchBoard) app.switchBoard(boardId);
        if (app.setMode) app.setMode('board');
      });
    });
  }

  // —— 全局刷新：数据变化后同步所有模式 UI ——
  function refreshAll() {
    var store = S();
    var tasks = store.getTasks();
    var c = store.counts();

    // 进度
    var pct = c.total > 0 ? Math.round(c.done / c.total * 100) : 0;
    var exDone = $('#exDone'), exTotal = $('#exTotal'), exProg = $('#exProgFill');
    var cmpDone = $('#cmpDone'), cmpBar = $('#cmpBar'), recapDone = $('#recapDone');
    if (exDone) exDone.textContent = c.done + ' 已完成';
    if (exTotal) exTotal.textContent = c.total + ' 项';
    if (exProg) exProg.style.width = pct + '%';
    if (cmpDone) cmpDone.innerHTML = c.done + '<small style="font-size:10px;color:var(--muted);font-weight:600">/' + c.total + '</small>';
    if (cmpBar) cmpBar.style.width = pct + '%';
    if (recapDone) recapDone.innerHTML = c.done + '<small>/' + c.total + '</small>';

    // 今日重点计数（跨所有项目，排除 inbox 和已归档）
    var _allCount = 0;
    if (tasks.boards && Array.isArray(tasks.boards)) {
      tasks.boards.forEach(function (b) {
        if (b.nodes) _allCount += b.nodes.filter(function (n) { return n.status !== 'inbox' && !n.archived; }).length;
      });
    }
    var cnt = $('#exTaskCount'); if (cnt) cnt.textContent = _allCount;

    // 展开任务列表
    renderExpandedTasks();
    renderAgentList();
    renderAIChips();
    updateAIPill();

    // 正在进行（跨所有项目查找 status='today'）
    var curTask = null;
    if (tasks.boards && Array.isArray(tasks.boards)) {
      tasks.boards.forEach(function (b) {
        if (!curTask && b.nodes) { curTask = b.nodes.filter(function (n) { return n.status === 'today'; })[0]; }
      });
    }
    var exCurName = $('#exCurName'), exCurStage = $('#exCurStage');
    var cmpCurName = $('#cmpCurName'), cmpCurStage = $('#cmpCurStage');
    if (curTask) {
      if (exCurName) exCurName.textContent = curTask.title;
      if (exCurStage) exCurStage.textContent = curTask.desc || '进行中';
      if (cmpCurName) cmpCurName.textContent = curTask.title;
      if (cmpCurStage) cmpCurStage.textContent = curTask.desc || '进行中';
    } else {
      if (exCurName) exCurName.textContent = '暂无进行中的任务';
      if (exCurStage) exCurStage.textContent = '去白板选一个任务开始';
      if (cmpCurName) cmpCurName.textContent = '暂无任务 · 去白板添加';
      if (cmpCurStage) cmpCurStage.textContent = '点击进入白板规划';
    }

    // 白板底栏计数 + 空状态
    var bcn = $('#boardCntNodes'); if (bcn) bcn.textContent = tasks.nodes.length + ' 张';
    var bcl = $('#boardCntLinks'); if (bcl) bcl.textContent = tasks.links.length + ' 条';
    var bEmpty = $('#boardEmpty'); if (bEmpty) bEmpty.style.display = tasks.nodes.length ? 'none' : 'block';
  }

  // —— Agent 列表：从真实任务（status='ai'）渲染 ——
  function renderAgentList() {
    var util = U(), store = S();
    var esc = util.esc || String;
    var list = $('#agentList');
    if (!list) return;
    var tasks = store.getTasks();

    var aiTasks = [];
    if (tasks.boards && Array.isArray(tasks.boards)) {
      tasks.boards.forEach(function (b) {
        if (b.nodes) b.nodes.forEach(function (n) { if (n.status === 'ai' && !n.archived) aiTasks.push(n); });
      });
    }
    var cntEl = $('#agentCount'); if (cntEl) cntEl.textContent = aiTasks.length > 0 ? (aiTasks.length + ' · 点击查看详情') : '暂无';
    if (aiTasks.length === 0) {
      list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6">还没有派给 AI 的任务<br>去白板点便利贴右下角的 <svg style="width:12px;height:12px;vertical-align:middle"><use href="#px-bot"/></svg> 派活</div>';
      return;
    }
    var html = '';
    aiTasks.forEach(function (n) {
      var steps = (n.aiContext && n.aiContext.steps) ? n.aiContext.steps : [];
      var doneCnt = steps.filter(function (s) { return s.status === 'done'; }).length;
      var total = steps.length;
      var prompt = (n.aiContext && n.aiContext.prompt) ? n.aiContext.prompt : '';
      var progressTxt = total > 0 ? (doneCnt + '/' + total + ' 步已验证') : '等待开始';
      var curStep = '';
      for (var i = 0; i < steps.length; i++) { if (steps[i].status === 'pending') { curStep = steps[i].text; break; } }
      var curStepTxt = total === 0 ? '尚未生成计划' : (curStep ? ('当前：' + esc(curStep.slice(0, 30) + (curStep.length > 30 ? '…' : ''))) : '全部步骤已验证');
      var hasResult = steps.some(function (s) { return s.result; });
      var pillTxt = doneCnt === 0 ? '计划已就绪' : (doneCnt === total ? '待验收' : '进行中');
      html += '<div class="agent" data-agent data-name="' + esc(n.title) + '" data-task-id="' + n.id + '">'
        + '<div class="agent__top">'
        + '<span class="pill pill--ai"><span class="pd"></span>' + pillTxt + '</span>'
        + '<div class="agent__name">' + esc(n.title) + '</div>'
        + '<span class="agent__chev"><svg><use href="#i-chev"/></svg></span>'
        + '</div>'
        + '<div class="agent__step">'
        + (hasResult ? '<svg style="width:12px;height:12px;color:var(--success)"><use href="#i-check"/></svg>' : '')
        + '<span>' + progressTxt + (curStepTxt ? ' · ' + curStepTxt : '') + '</span>'
        + '</div>'
        + '<div class="agent__foot"><span>共 ' + total + ' 步</span><span class="sep"></span><span>' + (prompt ? esc(prompt.slice(0, 30) + (prompt.length > 30 ? '…' : '')) : '') + '</span></div>'
        + '</div>';
    });
    list.innerHTML = html;
  }

  // —— 动态快捷 chips：从当前活跃项目的节点生成 ——
  function renderAIChips() {
    var util = U(), store = S(), app = A();
    var esc = util.esc || String;
    var chipsEl = $('#aiChips');
    if (!chipsEl) return;
    var board = store.activeBoard ? store.activeBoard() : null;
    if (!board) { chipsEl.innerHTML = ''; return; }
    var candidates = board.nodes.filter(function (n) {
      return n.status !== 'done' && n.status !== 'inbox' && !n.archived;
    }).slice(0, 4);
    if (candidates.length === 0) { chipsEl.innerHTML = ''; return; }
    var html = '';
    candidates.forEach(function (n) {
      html += '<button class="chip" data-chip-node="' + n.id + '"><svg><use href="#i-list"/></svg>规划「' + esc(n.title.length > 10 ? n.title.slice(0, 10) + '…' : n.title) + '」</button>';
    });
    chipsEl.innerHTML = html;
    $$('.chip', chipsEl).forEach(function (c) {
      c.addEventListener('click', function () {
        var nodeId = c.dataset.chipNode;
        var n = board.nodes.filter(function (x) { return x.id === nodeId; })[0];
        if (n && window.DOCK.dispatch) window.DOCK.dispatch.openDispatchPlanner(n);
      });
    });
  }

  // —— 更新 AI 任务计数 pill ——
  function updateAIPill() {
    var store = S();
    var pill = $('#aiAgentPill');
    if (!pill) return;
    var allNodes = store.allNodes ? store.allNodes() : [];
    var cnt = allNodes.filter(function (n) { return n.status === 'ai' && !n.archived; }).length;
    pill.innerHTML = '<span class="pd"></span>' + cnt + ' 个 AI 任务';
  }

  // 挂载到全局命名空间
  window.DOCK = window.DOCK || {};
  window.DOCK.render = {
    renderExpandedTasks: renderExpandedTasks,
    renderAgentList: renderAgentList,
    renderAIChips: renderAIChips,
    updateAIPill: updateAIPill,
    refreshAll: refreshAll
  };
})();
