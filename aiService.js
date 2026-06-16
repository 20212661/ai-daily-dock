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

// —— 模型预设（用户可在设置页选择，也可自定义）——
const MODEL_PRESETS = [
  { id: 'glm-4.5',       name: 'GLM-4.5（智谱）',       url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',  model: 'glm-4.5' },
  { id: 'glm-4-flash',   name: 'GLM-4-Flash（智谱免费）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',  model: 'glm-4-flash' },
  { id: 'deepseek-v3',   name: 'DeepSeek-V3',          url: 'https://api.deepseek.com/v1/chat/completions',           model: 'deepseek-chat' },
  { id: 'deepseek-r1',   name: 'DeepSeek-R1（推理）',    url: 'https://api.deepseek.com/v1/chat/completions',           model: 'deepseek-reasoner' },
  { id: 'kimi-kimi',     name: 'Kimi（月之暗面）',       url: 'https://api.moonshot.cn/v1/chat/completions',            model: 'moonshot-v1-8k' },
  { id: 'qwen-plus',     name: '通义千问 Plus',          url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { id: 'gpt-4o',        name: 'GPT-4o（OpenAI）',      url: 'https://api.openai.com/v1/chat/completions',             model: 'gpt-4o' },
  { id: 'gpt-4o-mini',   name: 'GPT-4o mini（OpenAI）',  url: 'https://api.openai.com/v1/chat/completions',             model: 'gpt-4o-mini' },
  { id: 'claude-sonnet', name: 'Claude 3.5 Sonnet',     url: 'https://api.anthropic.com/v1/chat/completions',          model: 'claude-3-5-sonnet-20241022' },
  { id: 'custom',        name: '自定义（OpenAI 兼容）',   url: '',                                                        model: '' },
];

// —— 真实 API 配置（USE_MOCK=false 时生效）——
const API_CONFIG = {
  url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  model: 'glm-4.5',
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
  const sys = '你是任务拆解助手。用户会给你一个任务描述，你需要把它拆成 3-6 个具体的、可执行的步骤。每步不超过 30 分钟。只返回步骤列表，每行一个步骤，不要编号、不要多余的解释。';
  const ctx = taskContext ? '任务标题：' + (taskContext.title || '') + '\n任务说明：' + (taskContext.desc || '') + '\n' : '';
  const content = await _callAPI(sys, ctx + '用户指令：' + prompt);
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
  MODEL_PRESETS,
  setApiKey,
  getApiKey,
  setModel,
  getProviderInfo,
  draftTaskSteps,
  generateRecapAdvice,
};
