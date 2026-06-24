/* ============================================================
   Pi Planner — 智能分发规划 Agent 核心逻辑
   ------------------------------------------------------------
   这个 Agent 不是执行型 Agent。
   它只负责：识别任务类型、拆解任务、判断分发对象、生成规划卡片。
   它不会读文件、不会写文件、不会运行命令。
   ============================================================ */

// 默认 fallback 结构（JSON 解析失败时返回）
function fallbackPlan(input, error) {
  return {
    sourceNoteId: (input && input.noteId) || 'unknown',
    summary: '规划失败：' + (error || '未知错误'),
    taskType: 'unknown',
    confidence: 0,
    missingInfo: ['请补充更多任务细节'],
    dispatchPlan: [
      {
        id: 'task_fallback',
        title: (input && input.title) || '未命名任务',
        goal: '需要更多信息才能规划',
        routeTo: 'human',
        reason: 'Pi SDK 未能生成有效规划，建议人工处理',
        expectedOutput: '人工补充信息后重新规划',
        priority: 'medium',
        status: 'pending',
        promptForNextAgent: '请先补充任务的背景信息和预期产出，然后重新提交规划请求。',
      },
    ],
    suggestedNextAction: '检查 agent-server 是否正常运行，或补充任务细节后重试',
  };
}

// 系统提示词：把 Agent 限制为 Planning Router Agent
const PLANNER_SYSTEM_PROMPT = `你是 Planning Router Agent，一个智能任务分发规划 Agent。

你的职责：
你只负责把用户输入的想法、便利贴、待办事项拆解成结构化任务包，并判断每个任务应该交给谁处理。你不负责执行任务，不负责改代码，不负责运行命令，不负责写文件，不负责调用外部工具。

你的工作流程：

1. 理解用户原始想法。
2. 判断任务类型。
3. 找出缺失信息。
4. 拆解成多个可处理任务。
5. 为每个任务选择分发对象。
6. 解释为什么这样分发。
7. 为下一个处理者生成可复制的提示词。
8. 输出严格 JSON。

分发对象只能从以下枚举中选择：

- human：需要用户自己决策、审美判断、取舍、确认方向。
- planning_agent：还需要继续澄清、拆解、设计流程。
- design_agent：适合交给 UI / 交互 / 视觉设计工具。
- code_agent：适合交给代码 Agent 实现、修复、重构。
- research_agent：适合交给论文阅读、资料调研、知识整理 Agent。
- later：暂存，以后再做。

任务类型只能从以下枚举中选择：

- product_design
- ui_design
- code_task
- research
- study
- life_task
- mixed
- unknown

优先级只能从以下枚举中选择：

- high
- medium
- low

禁止事项：

- 禁止输出 Markdown。
- 禁止输出解释性段落。
- 禁止调用工具。
- 禁止说"我已经执行了"。
- 禁止生成文件修改结果。
- 禁止返回自然语言总结作为最终答案。
- 最终只能输出一个 JSON 对象。

输出 JSON 格式如下：
{
"sourceNoteId": "string",
"summary": "string",
"taskType": "product_design | ui_design | code_task | research | study | life_task | mixed | unknown",
"confidence": 0.0,
"missingInfo": ["string"],
"dispatchPlan": [
{
"id": "task_001",
"title": "string",
"goal": "string",
"routeTo": "human | planning_agent | design_agent | code_agent | research_agent | later",
"reason": "string",
"expectedOutput": "string",
"priority": "high | medium | low",
"status": "pending",
"promptForNextAgent": "string"
}
],
"suggestedNextAction": "string"
}

输出要求：

- dispatchPlan 至少 3 项，最多 7 项。
- 每个任务必须能独立成为一张便利贴。
- promptForNextAgent 必须是可复制给对应 Agent 的提示词。
- 如果信息不足，不要拒绝，先给出合理分发，并把问题写入 missingInfo。
- 如果任务很模糊，优先分发给 planning_agent 和 human。
- 如果涉及 UI、前端、论文、代码，要明确拆开，不要混成一个大任务。`;

// 从模型输出中提取 JSON（支持 ```json 代码块和裸 JSON）
function extractJSON(text) {
  if (!text) return null;
  // 尝试 1：直接解析
  try {
    return JSON.parse(text.trim());
  } catch (e) { /* 继续 */ }
  // 尝试 2：提取 ```json ... ``` 之间的内容
  var jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) { /* 继续 */ }
  }
  // 尝试 3：找到第一个 { 和最后一个 } 之间的内容
  var firstBrace = text.indexOf('{');
  var lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    var jsonStr = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (e) { /* 继续 */ }
  }
  // 尝试 4：清理常见问题后重试（去掉尾部逗号）
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    var cleaned = text
      .slice(firstBrace, lastBrace + 1)
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');
    try {
      return JSON.parse(cleaned);
    } catch (e) { /* 放弃 */ }
  }
  return null;
}

// 构建发送给模型的用户消息
function buildUserMessage(input) {
  var msg = '任务来源 noteId: ' + (input.noteId || 'unknown') + '\n';
  msg += '任务标题: ' + (input.title || '(无标题)') + '\n';
  msg += '任务内容: ' + (input.content || (input.title || '(无内容)')) + '\n';
  // 白板上下文
  if (input.boardContext && input.boardContext.length > 0) {
    msg += '\n── 白板上已有的相关任务 ──\n';
    input.boardContext.forEach(function(n, i) {
      msg += (i + 1) + '. [' + (n.status || 'todo') + '] ' + (n.title || '');
      if (n.content) msg += ' — ' + n.content;
      msg += '\n';
    });
    msg += '请考虑这些已有任务，避免重复规划。\n';
  }
  msg += '\n请分析这个任务，输出规划 JSON。';
  return msg;
}

/* ============================================================
   规划函数
   使用 OpenAI 兼容的 chat/completions 接口（fetch 直连，无第三方 SDK）。
   默认指向 DeepSeek，也可通过环境变量切到任何 OpenAI 兼容服务
   （智谱 / 通义 / Kimi / 真 OpenAI / 自建网关等）。
   ============================================================ */

// 从环境变量读取 API 配置，fallback 到 DeepSeek
const PI_API_KEY = process.env.PI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const PI_BASE_URL = process.env.PI_BASE_URL || 'https://api.deepseek.com';
// 默认用 DeepSeek-V4-Flash（deepseek-chat 旧名将于 2026-07-24 停用）
const PI_MODEL = process.env.PI_MODEL || 'deepseek-v4-flash';

// 组装 chat/completions 端点：兼容用户填带或不带尾斜杠、带或不带 /v1 的 baseURL
function chatCompletionsUrl() {
  var base = PI_BASE_URL.replace(/\/+$/, '');
  // DeepSeek 端点恰好是 https://api.deepseek.com（无 /v1），
  // 通用 OpenAI 兼容服务多为 https://xxx/v1 —— 统一拼接，不做启发式猜测路径，
  // 因为各厂商路径差异大，交由 PI_BASE_URL 完整指定更稳妥。
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

/**
 * 调用 OpenAI 兼容的 chat/completions
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {number} maxTokens  最大 token（默认 2048）
 * @param {number} temperature
 * @returns {Promise<string>} 模型输出的文本内容
 */
async function callChat(systemPrompt, userMessage, maxTokens, temperature) {
  if (!PI_API_KEY) {
    throw new Error('未配置 API Key（PI_API_KEY / DEEPSEEK_API_KEY）');
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 30000);
  try {
    var res = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + PI_API_KEY,
      },
      body: JSON.stringify({
        model: PI_MODEL,
        max_tokens: maxTokens || 2048,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      var errText = '';
      try { errText = await res.text(); } catch (e) {}
      throw new Error('API 返回错误 ' + res.status + ': ' + (errText || '').slice(0, 200));
    }
    var data = await res.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') throw new Error('API 返回格式异常：缺少 choices[0].message.content');
    return content;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('请求超时（30秒），请检查网络或重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 三个分析视角：统一来自 ../src/shared/perspectives（与主进程 aiService 共用同一份定义，
// 改一处两端同步生效）。这里用 120 字实例化（agent-server 历史上限）。
const PERSPECTIVES = require('../src/shared/perspectives').build(120);

/**
 * 多视角分析：并发调用三个视角，返回分析结果
 */
async function runPerspectives(input) {
  const ctx = buildUserMessage(input);
  const results = await Promise.allSettled(
    PERSPECTIVES.map(function(p) {
      return callChat(p.system, ctx, 500).then(function(text) {
        return { perspective: p.name, analysis: text || '(无输出)' };
      });
    })
  );
  return results.map(function(r, i) {
    if (r.status === 'fulfilled') return r.value;
    return {
      perspective: PERSPECTIVES[i].name,
      analysis: '(分析失败: ' + (r.reason && r.reason.message || '未知错误') + ')',
    };
  });
}

/**
 * 生成分发规划（含多视角分析）
 * @param {object} input - { noteId, title, content, boardContext }
 * @returns {Promise<object>} DispatchPlan JSON（含 perspectives 字段）
 */
async function generateDispatchPlan(input) {
  // 检查 API Key
  if (!PI_API_KEY) {
    console.warn('[PiPlanner] 未配置 PI_API_KEY，返回 fallback');
    return fallbackPlan(input, '未配置 API Key');
  }

  // 第一阶段：多视角分析（并发）
  console.log('[PiPlanner] 阶段 1: 多视角分析...');
  var perspectives = [];
  try {
    perspectives = await runPerspectives(input);
    console.log('[PiPlanner] 多视角分析完成:', perspectives.length, '个视角');
  } catch(err) {
    console.warn('[PiPlanner] 多视角分析失败，跳过:', err.message);
  }

  // 第二阶段：基于多视角分析生成分发规划
  console.log('[PiPlanner] 阶段 2: 生成分发规划...');
  const userMessage = buildUserMessage(input);
  // 把多视角分析结果作为上下文喂给规划 Agent
  var enrichedMessage = userMessage;
  if (perspectives.length > 0) {
    enrichedMessage += '\n\n── 多视角分析结果（请参考这些分析来做分发决策）──\n';
    perspectives.forEach(function(p) {
      enrichedMessage += '\n【' + p.perspective + '】\n' + p.analysis + '\n';
    });
    enrichedMessage += '── 分析结束 ──\n\n请在以上多视角分析的基础上，综合判断后输出分发规划 JSON。';
  }

  try {
    const text = await callChat(PLANNER_SYSTEM_PROMPT, enrichedMessage, 2048);

    // 解析 JSON
    var plan = extractJSON(text);
    if (!plan) {
      console.warn('[PiPlanner] JSON 解析失败，原始输出:', text.slice(0, 200));
      var fb = fallbackPlan(input, '模型输出无法解析为 JSON');
      fb.perspectives = perspectives;
      return fb;
    }

    // 补全 sourceNoteId（确保一致）
    plan.sourceNoteId = input.noteId || plan.sourceNoteId || 'unknown';
    // 附上多视角分析
    plan.perspectives = perspectives;

    return plan;
  } catch (err) {
    console.error('[PiPlanner] API 调用失败:', err.message);
    return fallbackPlan(input, err.message);
  }
}

module.exports = {
  generateDispatchPlan,
  fallbackPlan,
  extractJSON,
  PLANNER_SYSTEM_PROMPT,
  PERSPECTIVES,
  runPerspectives,
};
