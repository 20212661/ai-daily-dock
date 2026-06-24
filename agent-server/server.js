/* ============================================================
   Agent Server — Pi SDK 智能分发规划服务
   ------------------------------------------------------------
   启动方式：
     cd agent-server
     npm install
     npm run dev
   
   环境变量：
     PI_API_KEY    — API Key（默认读 DeepSeek）
     PI_BASE_URL   — API 端点（默认 https://api.deepseek.com）
     PI_MODEL      — 模型名（默认 deepseek-v4-flash）
     PORT          — 端口（默认 3874）
   ============================================================ */

const express = require('express');
const cors = require('cors');
const { generateDispatchPlan } = require('./pi-planner');

const app = express();
const PORT = process.env.PORT || 3874;

// —— 中间件 ——
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// —— 健康检查 ——
app.get('/api/health', (req, res) => {
  const hasKey = !!(process.env.PI_API_KEY || process.env.DEEPSEEK_API_KEY);
  res.json({
    ok: true,
    service: 'pi-dispatch-planner',
    version: '1.0.0',
    apiKeyConfigured: hasKey,
    model: process.env.PI_MODEL || 'deepseek-v4-flash',
    endpoint: process.env.PI_BASE_URL || 'https://api.deepseek.com',
  });
});

// —— 核心接口：生成分发规划 ——
app.post('/api/dispatch-plan', async (req, res) => {
  const input = req.body;
  
  // 参数校验
  if (!input || (!input.title && !input.content)) {
    return res.status(400).json({
      ok: false,
      error: '缺少 title 或 content',
    });
  }

  console.log('[Server] 收到规划请求:', {
    noteId: input.noteId,
    title: input.title,
    contextCount: (input.boardContext || []).length,
  });

  try {
    const plan = await generateDispatchPlan(input);
    console.log('[Server] 规划完成:', {
      taskType: plan.taskType,
      confidence: plan.confidence,
      dispatchCount: (plan.dispatchPlan || []).length,
    });
    res.json({ ok: true, plan });
  } catch (err) {
    console.error('[Server] 规划失败:', err);
    res.status(500).json({
      ok: false,
      error: err.message,
      plan: null,
    });
  }
});

// —— 启动 ——
app.listen(PORT, () => {
  const hasKey = !!(process.env.PI_API_KEY || process.env.DEEPSEEK_API_KEY);
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  Pi Dispatch Planner Server                 │');
  console.log('│  http://localhost:' + PORT + '                   │');
  console.log('│  API Key: ' + (hasKey ? '✅ 已配置' : '❌ 未配置') + '                │');
  console.log('│  POST /api/dispatch-plan                    │');
  console.log('│  GET  /api/health                           │');
  console.log('└─────────────────────────────────────────────┘');
  if (!hasKey) {
    console.log('');
    console.log('⚠️  请设置环境变量：');
    console.log('  set PI_API_KEY=你的API密钥');
    console.log('  或 set DEEPSEEK_API_KEY=你的DeepSeek密钥');
  }
});
