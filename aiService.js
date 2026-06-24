/* ============================================================
   AI Daily Dock · aiService.js
   AI 能力隔离层：任务系统（dock.html 自己写）与 AI 能力（SDK/API）之间的桥接。
   
   设计原则：
   - dock.html 永远只调用 aiService 的方法，不关心背后是 mock 还是真实 API
   - 切换 mock ↔ 真实只需改 USE_MOCK 一行
   - API Key 只存在主进程，渲染层不接触
   ============================================================ */

// —— 配置：mock / 真实切换 ——
const USE_MOCK = false; // ✅ 已切换为真实 API

// —— 三视角头脑风暴的「唯一真值」来自共享模块（与 agent-server 共用，避免分叉）——
const PERSPECTIVES = require('./src/shared/perspectives');

// —— 模型预设（用户可在设置页选择，也可自定义）——
// 所有 url 均为 OpenAI 兼容的 /chat/completions 端点，模型名以各家 2026 年官方文档为准。
// 注意：本客户端只支持 OpenAI 协议（choices[0].message.content），
//   因此 Anthropic Claude（原生 /v1/messages、x-api-key 鉴权）不在此列——
//   如需用 Claude，请在「自定义」里填一个 OpenAI 兼容的网关/代理地址。
const MODEL_PRESETS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash（快速）',  url: 'https://api.deepseek.com/chat/completions',                          model: 'deepseek-v4-flash' },
  { id: 'deepseek-v4-pro',   name: 'DeepSeek-V4-Pro（高质量）',   url: 'https://api.deepseek.com/chat/completions',                          model: 'deepseek-v4-pro' },
  // deepseek-chat / deepseek-reasoner 为旧名，2026-07-24 后停用，已替换为 V4 系列
  { id: 'glm-4.5',           name: 'GLM-4.5（智谱·旗舰）',        url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',              model: 'glm-4.5' },
  { id: 'glm-4.5-air',       name: 'GLM-4.5-Air（智谱·轻量快速）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',              model: 'glm-4.5-air' },
  { id: 'kimi-k2.6',         name: 'Kimi K2.6（月之暗面·最新）',   url: 'https://api.moonshot.cn/v1/chat/completions',                        model: 'kimi-k2.6' },
  { id: 'kimi-latest',       name: 'Kimi Latest（自动指向最新）',  url: 'https://api.moonshot.cn/v1/chat/completions',                        model: 'kimi-latest' },
  { id: 'qwen-plus',         name: '通义千问 Plus',               url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { id: 'qwen-plus-latest',  name: '通义千问 Plus（最新版）',      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus-latest' },
  { id: 'gpt-4o',            name: 'GPT-4o（OpenAI）',            url: 'https://api.openai.com/v1/chat/completions',                         model: 'gpt-4o' },
  { id: 'gpt-4o-mini',       name: 'GPT-4o mini（OpenAI·低价）',  url: 'https://api.openai.com/v1/chat/completions',                         model: 'gpt-4o-mini' },
  { id: 'custom',            name: '自定义（OpenAI 兼容）',        url: '',                                                                   model: '' },
];

// —— 真实 API 配置（USE_MOCK=false 时生效）——
const API_CONFIG = {
  url: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-v4-flash',
  apiKey: '',  // 由主进程通过 setApiKey() 注入
  timeout: 30000,
};

// —— API Key 管理（主进程调用）——
let _apiKey = '';
function setApiKey(key) { _apiKey = key; API_CONFIG.apiKey = key; }
function getApiKey() { return _apiKey; }

// —— 模型切换 ——
function setModel(presetId, customUrl, customModel) {
  var p = MODEL_PRESETS.filter(function(m){return m.id===presetId;})[0];
  if (!p) return;
  if (presetId === 'custom') {
    API_CONFIG.url = customUrl || '';
    API_CONFIG.model = customModel || '';
  } else {
    API_CONFIG.url = p.url;
    API_CONFIG.model = p.model;
  }
}
function getProviderInfo() {
  return { url: API_CONFIG.url, model: API_CONFIG.model };
}

/* ============================================================
   核心 AI 能力：任务拆解
   输入：用户写的指令 + 任务上下文
   输出：步骤数组（字符串）
   ============================================================ */
async function draftTaskSteps(prompt, taskContext) {
  if (USE_MOCK) {
    return _mockDraftSteps(prompt, taskContext);
  }
  return _realDraftSteps(prompt, taskContext);
}

/* ============================================================
   核心 AI 能力：逐步执行（人主导模式下，人点某一步 → AI 返回该步结果）
   输入：stepContext = {title, desc, instruction, stepText, stepIdx, totalSteps, priorSteps}
   输出：该步的具体执行结果（文本）
   ============================================================ */
async function executeStep(stepContext) {
  if (USE_MOCK) {
    return _mockExecuteStep(stepContext);
  }
  return _realExecuteStep(stepContext);
}

/* ============================================================
   核心 AI 能力：多模型头脑风暴
   让多个 AI 从不同视角分析同一问题，人综合后形成决策
   输入：prompt + taskContext（含依赖关系）
   输出：[{perspective, analysis}] 多份分析
   ============================================================ */
// 三个分析视角：统一来自 src/shared/perspectives（与 agent-server 共用同一份定义，
// 改一处两端同步生效）。保持 BRAINSTORM_PERSPECTIVES 名以兼容既有导出。
const BRAINSTORM_PERSPECTIVES = PERSPECTIVES.build(PERSPECTIVES.DEFAULT_MAX_WORDS);

async function brainstorm(prompt, taskContext) {
  // 构建公共上下文
  var ctxStr = '';
  if (taskContext) {
    ctxStr += '任务：' + (taskContext.title || '') + (taskContext.desc ? '（' + taskContext.desc + '）' : '') + '\n';
    var deps = taskContext.dependencies;
    if (deps && (deps.upstream && deps.upstream.length > 0 || deps.downstream && deps.downstream.length > 0)) {
      ctxStr += '\n白板依赖关系：\n';
      if (deps.upstream && deps.upstream.length > 0) {
        ctxStr += '上游：' + deps.upstream.map(d => d.title + '(' + d.status + ')').join(', ') + '\n';
      }
      if (deps.downstream && deps.downstream.length > 0) {
        ctxStr += '下游：' + deps.downstream.map(d => d.title + '(' + d.status + ')').join(', ') + '\n';
      }
    }
  }
  ctxStr += '\n用户的原始想法：' + prompt;

  if (USE_MOCK) {
    return _mockBrainstorm(prompt, taskContext);
  }

  // 并发调用三个视角
  var results = await Promise.allSettled(
    BRAINSTORM_PERSPECTIVES.map(function(p) {
      return _callAPI(p.system, ctxStr).then(function(content) {
        return { perspective: p.name, analysis: content };
      });
    })
  );
  // 过滤成功的
  var analyses = [];
  results.forEach(function(r, i) {
    if (r.status === 'fulfilled') {
      analyses.push(r.value);
    } else {
      analyses.push({ perspective: BRAINSTORM_PERSPECTIVES[i].name, analysis: '（此视角分析失败：' + (r.reason && r.reason.message || '未知错误') + '）' });
    }
  });
  return analyses;
}

function _mockBrainstorm(prompt, taskContext) {
  var title = (taskContext && taskContext.title) || '任务';
  return Promise.resolve([
    {
      perspective: '架构师视角',
      analysis: '【Mock】「' + title + '」的核心目标是明确产出标准。\n最小可行路径：先确定最核心的 20% 工作。\n风险：需求模糊可能导致返工。\n建议：先写出验收标准再动手。'
    },
    {
      perspective: '质疑者视角',
      analysis: '【Mock】你确定真的需要做「' + title + '」吗？\n· 任务描述中有哪些假设没有验证？\n· 边界情况考虑了吗？\n· 如果不做会怎样？'
    },
    {
      perspective: '实践者视角',
      analysis: '【Mock】30 分钟内能做的：\n· 快速搜索最佳实践\n· 找到可复用的模板\n· 最值得做的 3 步：1) 确定范围 2) 找参考 3) 快速产出原型'
    }
  ]);
}

/* ============================================================
   核心 AI 能力：复盘建议
   输入：今日完成的任务 + 未完成任务
   输出：建议文本
   ============================================================ */
async function generateRecapAdvice(doneTasks, missTasks) {
  if (USE_MOCK) {
    return _mockRecapAdvice(doneTasks, missTasks);
  }
  return _realRecapAdvice(doneTasks, missTasks);
}

/* ============================================================
   真实 API 实现（USE_MOCK=false 时调用）
   ============================================================ */
async function _callAPI(systemPrompt, userPrompt) {
  if (!API_CONFIG.apiKey) {
    throw new Error('未配置 API Key，请在设置页填写');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_CONFIG.timeout);
  try {
    const res = await fetch(API_CONFIG.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_CONFIG.apiKey,
      },
      body: JSON.stringify({
        model: API_CONFIG.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error('API 返回错误 ' + res.status + ': ' + errText.slice(0, 200));
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('API 返回格式异常');
    return content;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时（30秒），请检查网络或重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function _realDraftSteps(prompt, taskContext) {
  const sys = '你是任务拆解助手。用户会给你一个任务描述，你需要把它拆成 3-6 个具体的、可执行的步骤。\n' +
    '要求：\n' +
    '1. 每步不超过 30 分钟，必须是可立即执行的具体动作\n' +
    '2. 如果有上游任务（前置），前几步应衔接上游产出，不要重复上游已完成的工作\n' +
    '3. 如果有下游任务（后续），最后几步应为下游任务做好准备（如产出可复用的中间结果）\n' +
    '4. 考虑上下游任务的状态——已完成的上游意味着你可以直接引用其产出\n' +
    '只返回步骤列表，每行一个步骤，不要编号、不要多余的解释。';
  // 构建上下文：任务信息 + 白板依赖关系
  var ctx = '';
  if (taskContext) {
    ctx += '任务标题：' + (taskContext.title || '') + '\n';
    ctx += '任务说明：' + (taskContext.desc || '') + '\n';
    // 附加白板依赖关系
    var deps = taskContext.dependencies;
    if (deps && (deps.upstream && deps.upstream.length > 0 || deps.downstream && deps.downstream.length > 0)) {
      ctx += '\n── 白板依赖关系 ──\n';
      if (deps.upstream && deps.upstream.length > 0) {
        ctx += '上游（前置）任务：\n';
        deps.upstream.forEach(function(d) {
          ctx += '  · [' + d.linkType + '] ' + d.title + (d.desc ? '（' + d.desc + '）' : '') + ' · 状态：' + d.status + '\n';
        });
      }
      if (deps.downstream && deps.downstream.length > 0) {
        ctx += '下游（后续）任务：\n';
        deps.downstream.forEach(function(d) {
          ctx += '  · [' + d.linkType + '] ' + d.title + (d.desc ? '（' + d.desc + '）' : '') + ' · 状态：' + d.status + '\n';
        });
      }
      ctx += '── 依赖关系结束 ──\n';
    }
  }
  ctx += '\n用户指令：' + prompt;
  const content = await _callAPI(sys, ctx);
  // 解析返回的步骤（按换行分割，过滤空行）
  return content.split('\n').map(s => s.replace(/^\d+[.、)\s]+/, '').trim()).filter(s => s.length > 0).slice(0, 8);
}

async function _realRecapAdvice(doneTasks, missTasks) {
  const sys = '你是工作复盘助手。根据用户今天完成的任务和未完成的任务，给出 2-3 条简洁的明日建议。只返回建议，每行一条。';
  const doneList = doneTasks.map(t => '- ' + (t.title || '') + (t.desc ? '（' + t.desc + '）' : '')).join('\n');
  const missList = missTasks.map(t => '- ' + (t.title || '') + '（状态：' + (t.status || '') + '）').join('\n');
  const content = await _callAPI(sys, '今日完成：\n' + (doneList || '无') + '\n\n未完成：\n' + (missList || '无'));
  return content;
}

async function _realExecuteStep(ctx) {
  const sys = '你是任务执行助手。用户正在逐步完成一个任务，现在需要你执行其中的某一步。\n' +
    '请给出这一步的具体执行结果。要求：\n' +
    '1. 内容具体、可操作，不要泛泛而谈\n' +
    '2. 如果是信息收集/分析类，给出实际内容\n' +
    '3. 如果是写作/整理类，给出实际文本\n' +
    '4. 给完后简要说明你的依据，便于人审核判断';
  const prior = ctx.priorSteps && ctx.priorSteps.length > 0
    ? '\n前序步骤及结果：\n' + ctx.priorSteps.map(s => '  ' + s.s + (s.r ? ' → ' + s.r.slice(0, 100) : '（待处理）')).join('\n')
    : '';
  // 附加白板依赖关系（如果有）
  var depCtx = '';
  if (ctx.dependencies && (ctx.dependencies.upstream && ctx.dependencies.upstream.length > 0 || ctx.dependencies.downstream && ctx.dependencies.downstream.length > 0)) {
    depCtx += '\n── 白板上下文 ──\n';
    if (ctx.dependencies.upstream && ctx.dependencies.upstream.length > 0) {
      depCtx += '上游（前置）任务产出可参考：\n';
      ctx.dependencies.upstream.forEach(function(d) {
        depCtx += '  · [' + d.linkType + '] ' + d.title + ' · 状态：' + d.status + '\n';
      });
    }
    if (ctx.dependencies.downstream && ctx.dependencies.downstream.length > 0) {
      depCtx += '下游（后续）任务需要你的输出作为输入：\n';
      ctx.dependencies.downstream.forEach(function(d) {
        depCtx += '  · [' + d.linkType + '] ' + d.title + '\n';
      });
    }
    depCtx += '请考虑这些上下游关系，确保这步的产出能衔接上下游。\n';
  }
  const userMsg = '任务：' + (ctx.title || '') + (ctx.desc ? '（' + ctx.desc + '）' : '') + '\n' +
    '用户指令：' + (ctx.instruction || '') + '\n' +
    '当前是第 ' + (ctx.stepIdx + 1) + '/' + ctx.totalSteps + ' 步\n' +
    '这一步：' + ctx.stepText + prior + depCtx;
  const content = await _callAPI(sys, userMsg);
  return content;
}

function _mockExecuteStep(ctx) {
  return Promise.resolve('[Mock 模拟输出] 第 ' + (ctx.stepIdx + 1) + '/' + ctx.totalSteps + ' 步：' + ctx.stepText + '\n\n' +
    '这是 mock 模式下的模拟输出。在真实模式下，AI 会根据任务上下文给出具体可操作的结果。\n' +
    '任务：' + (ctx.title || '') + '\n' +
    '指令：' + (ctx.instruction || ''));
}

/* ============================================================
   Mock 实现（USE_MOCK=true 时调用，开发/演示用）
   ============================================================ */
function _mockDraftSteps(prompt, taskContext) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      var title = (taskContext && taskContext.title) || '任务';
      var steps = [];
      if (/拆|拆解|分解|break/i.test(prompt)) {
        steps = ['分析「' + title + '」的核心目标和约束', '识别关键子任务和依赖关系', '列出可执行的具体步骤（每步≤30min）', '预估每步所需时间', '生成任务清单并排优先级'];
      } else if (/整理|归档|总结|summar/i.test(prompt)) {
        steps = ['收集「' + title + '」相关材料', '提取关键信息要点', '按主题/时间分类整理', '生成结构化笔记', '校对并归档'];
      } else if (/搜索|调研|查找|research/i.test(prompt)) {
        steps = ['确定「' + title + '」的搜索关键词', '查找权威来源和最新资料', '筛选高相关度结果', '提取核心发现', '整理成调研摘要'];
      } else {
        steps = ['理解「' + title + '」的具体需求', '确定执行方案和约束条件', '拆分为可操作的步骤', '预估时间和资源', '生成执行计划供你确认'];
      }
      resolve(steps);
    }, 800 + Math.random() * 600); // 模拟网络延迟
  });
}

function _mockRecapAdvice(doneTasks, missTasks) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      var lines = [];
      if (missTasks.length > 0) {
        lines.push('优先推进「' + (missTasks[0].title || '') + '」，避免拖延到明天');
      }
      if (doneTasks.length > 2) {
        lines.push('今天完成了 ' + doneTasks.length + ' 项任务，效率不错，保持节奏');
      }
      lines.push('建议明天先做困难任务，下午留给 AI 协作');
      resolve(lines.join('\n'));
    }, 600);
  });
}

// —— 导出（CommonJS，供 main.js require）——
module.exports = {
  USE_MOCK,
  API_CONFIG,
  BRAINSTORM_PERSPECTIVES,
  MODEL_PRESETS,
  setApiKey,
  getApiKey,
  setModel,
  getProviderInfo,
  draftTaskSteps,
  brainstorm,
  executeStep,
  generateRecapAdvice,
};
