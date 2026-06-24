/* ============================================================
   AI Daily Dock · agentBridge.js
   Hermes 风格的本地 Agent 桥接层
   - 检测本地已安装的 CLI Agent（Claude Code、Codex 等）
   - 通过 spawn 调用 Agent 执行任务
   - 流式收集输出，完成后返回完整结果
   - 支持「派活→后台执行→结果回来」的异步工作流
   
   设计原则（符合 playbook）：
   - 人发起任务，Agent 执行，人审核结果
   - 不自动执行，每一步都由人触发
   - Agent 有工作目录概念，可沉淀项目上下文
   ============================================================ */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// —— Agent 注册表 ——
// 每个条目描述如何在本地找到并调用这个 Agent
const AGENT_REGISTRY = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    cmd: 'claude',
    // 检测命令是否可用
    detect: function() {
      try { execSync('claude --version', { stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; }
    },
    // 构建执行命令：非交互模式，传入 prompt
    buildArgs: function(prompt, opts) {
      return ['-p', prompt, '--no-input'];
    },
    cwd: null, // 工作目录，null=用户选择
  },
  {
    id: 'codex',
    name: 'Codex (OpenAI)',
    cmd: 'codex',
    detect: function() {
      try { execSync('codex --version', { stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; }
    },
    buildArgs: function(prompt, opts) {
      return ['--prompt', prompt];
    },
    cwd: null,
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    cmd: 'gemini',
    detect: function() {
      try { execSync('gemini --version', { stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; }
    },
    buildArgs: function(prompt, opts) {
      return ['-p', prompt];
    },
    cwd: null,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    cmd: 'opencode',
    detect: function() {
      try { execSync('opencode --version', { stdio: 'pipe', timeout: 3000 }); return true; } catch { return false; }
    },
    buildArgs: function(prompt, opts) {
      return ['-p', prompt];
    },
    cwd: null,
  },
  {
    id: 'custom',
    name: '自定义 CLI Agent',
    cmd: '',
    detect: function() { return false; },
    buildArgs: function(prompt, opts) { return [prompt]; },
    cwd: null,
  },
];

// —— 检测本地已安装的 Agent ——
function detectAgents() {
  var found = [];
  AGENT_REGISTRY.forEach(function(a) {
    try {
      if (a.detect()) {
        found.push({ id: a.id, name: a.name, available: true });
      }
    } catch(e) { /* 忽略检测错误 */ }
  });
  return found;
}

// —— 运行中的任务追踪 ——
// 结构: { [taskId]: { agent, proc, output, status, startTime, cwd } }
const runningTasks = {};

// —— 持久化回调（由 main.js 注入，避免 agentBridge 直接 require dataService 造成循环依赖）——
// main.js 启动时调 agentBridge.setPersistence({ saveRun, loadRuns }) 注入。
var _persistence = null;
function setPersistence(api) { _persistence = api || null; }

// 把一个终态 taskInfo 投影并持久化为历史记录（写 agent-runs.json）
function persistRun(taskInfo) {
  if (!_persistence || !_persistence.saveRun || !taskInfo) return;
  try {
    _persistence.saveRun({
      taskId: taskInfo.taskId,
      nodeId: taskInfo.nodeId || null,
      agent: taskInfo.agent,
      agentId: taskInfo.agentId,
      status: taskInfo.status,
      prompt: taskInfo.prompt,
      output: taskInfo.output,
      startTime: taskInfo.startTime,
      endTime: taskInfo.endTime || new Date().toISOString(),
      exitCode: taskInfo.exitCode,
      cwd: taskInfo.cwd,
    });
  } catch (e) { /* 持久化失败不影响主流程 */ }
}

// —— 派活给本地 Agent ——
// 返回 taskId，Agent 在后台执行，通过 getAgentTaskStatus 轮询结果
function dispatchToAgent(agentId, prompt, opts) {
  opts = opts || {};
  var agent = AGENT_REGISTRY.filter(function(a) { return a.id === agentId; })[0];
  if (!agent) {
    return { ok: false, error: '未知的 Agent: ' + agentId };
  }
  if (!agent.cmd) {
    return { ok: false, error: '该 Agent 未配置命令，请在设置中填写' };
  }

  // 生成唯一任务 ID
  var taskId = 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var cwd = opts.cwd || agent.cwd || process.env.USERPROFILE || process.cwd();

  // 构建参数
  var args = agent.buildArgs(prompt, opts);

  // 启动进程
  var proc;
  try {
    proc = spawn(agent.cmd, args, {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: Object.assign({}, process.env, opts.env || {}),
    });
  } catch(err) {
    return { ok: false, error: '启动 Agent 失败: ' + err.message };
  }

  // 追踪输出
  var output = '';
  var taskInfo = {
    taskId: taskId,
    agent: agent.name,
    agentId: agentId,
    nodeId: opts.nodeId || null,       // 关联的白板任务节点 id（用于详情页跳转）
    status: 'running',
    output: '',
    startTime: new Date().toISOString(),
    cwd: cwd,
    prompt: prompt,
    proc: proc,                       // 保留进程引用，cancel 时据此杀进程树
    cancelled: false,                 // 取消标记：阻止后续 close/error 事件覆盖状态
  };

  proc.stdout.on('data', function(data) {
    var chunk = data.toString();
    output += chunk;
    taskInfo.output = output;
    taskInfo.updatedAt = new Date().toISOString();
  });

  proc.stderr.on('data', function(data) {
    var chunk = data.toString();
    output += '[stderr] ' + chunk;
    taskInfo.output = output;
  });

  proc.on('error', function(err) {
    if (taskInfo.cancelled) return;  // 已取消则忽略后续事件
    taskInfo.status = 'error';
    taskInfo.error = err.message;
    taskInfo.endTime = new Date().toISOString();
    persistRun(taskInfo);            // 持久化到 agent-runs.json
  });

  proc.on('close', function(code) {
    if (taskInfo.cancelled) return;  // 取消触发的关闭不覆盖状态，避免误判 done/failed
    taskInfo.status = code === 0 ? 'done' : 'failed';
    taskInfo.exitCode = code;
    taskInfo.endTime = new Date().toISOString();
    taskInfo.output = output;
    persistRun(taskInfo);            // 持久化到 agent-runs.json
  });

  runningTasks[taskId] = taskInfo;

  return { ok: true, taskId: taskId, agent: agent.name };
}

// —— 查询任务状态 ——
function getAgentTaskStatus(taskId) {
  var task = runningTasks[taskId];
  if (!task) {
    return { ok: false, error: '任务不存在: ' + taskId };
  }
  return {
    ok: true,
    taskId: taskId,
    status: task.status,          // running / done / failed / error / cancelled
    agent: task.agent,
    agentId: task.agentId,        // 详情页据此显示 Agent 类型
    nodeId: task.nodeId || null,  // 关联的白板任务节点
    prompt: task.prompt,          // 详情页显示原始指令
    output: task.output,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    cwd: task.cwd,
  };
}

// —— 取消正在运行的任务（真正杀进程树）——
// Windows 下 spawn 用了 shell:true（经 cmd.exe 启动），直接 proc.kill 只杀 cmd，
// 子 Agent 进程会成为孤儿继续运行。因此用 taskkill /T /F /PID 递归杀整棵树。
function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return; // 已退出
  var pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore', timeout: 5000 });
      return;
    } catch (e) { /* taskkill 失败则降级到 proc.kill */ }
  }
  try { proc.kill('SIGTERM'); } catch (e) {}
  // SIGTERM 兜底：500ms 后强杀
  setTimeout(function () {
    try { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); } catch (e) {}
  }, 500);
}

function cancelAgentTask(taskId) {
  var task = runningTasks[taskId];
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.status === 'done' || task.status === 'failed' || task.status === 'error') {
    return { ok: false, error: '任务已结束，无法取消' };
  }
  // 先打取消标记：阻止 close/error 回调把状态改回 done/failed
  task.cancelled = true;
  // 杀进程树
  killProcessTree(task.proc);
  // 设最终状态
  task.status = 'cancelled';
  task.endTime = new Date().toISOString();
  persistRun(task);                // 持久化取消记录到 agent-runs.json
  return { ok: true };
}

// —— 获取所有运行中的任务 ——
function listAgentTasks() {
  return Object.keys(runningTasks).map(function(id) {
    var t = runningTasks[id];
    return {
      taskId: id,
      status: t.status,
      agent: t.agent,
      prompt: (t.prompt || '').slice(0, 80),
      startTime: t.startTime,
    };
  });
}

// —— 导出 ——
module.exports = {
  AGENT_REGISTRY,
  detectAgents,
  dispatchToAgent,
  getAgentTaskStatus,
  cancelAgentTask,
  listAgentTasks,
  setPersistence,    // 主进程注入持久化回调
};
