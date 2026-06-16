#!/usr/bin/env node
/* ============================================================
   AI Daily Dock · CLI 工具
   与桌面应用通过 IPC socket 通信
   
   用法：
     dock                    唤起 Dock 窗口
     dock add "任务标题"      创建新便利贴（当前活跃看板）
     dock list               列出当前看板的所有任务
     dock recap              生成今日复盘
     dock complete "标题"    按标题模糊匹配标记完成
   
   与 Codex/Claude Code 联动：
     在 CLI Agent 中执行 shell 命令即可推送任务到 Dock
   ============================================================ */
const net = require('net');
const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\daily-dock-ipc'
  : '/tmp/daily-dock-ipc.sock';

function sendToApp(payload) {
  return new Promise((resolve) => {
    const client = net.createConnection(PIPE_PATH, () => {
      client.write(JSON.stringify(payload));
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({ ok: false, error: '无法解析响应' }); }
    });
    client.on('error', () => {
      resolve({ ok: false, error: 'Dock 未运行，请先启动应用' });
    });
    // 3 秒超时
    setTimeout(() => { client.destroy(); resolve({ ok: false, error: '连接超时' }); }, 3000);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'show';

  let payload;
  switch (cmd) {
    case 'show':
      payload = { cmd: 'show' };
      break;
    case 'add':
    case 'new':
      const title = args.slice(1).join(' ').trim();
      if (!title) { console.error('用法: dock add <任务标题>'); process.exit(1); }
      payload = { cmd: 'add', title };
      break;
    case 'list':
    case 'ls':
      payload = { cmd: 'list' };
      break;
    case 'complete':
    case 'done':
      const match = args.slice(1).join(' ').trim();
      if (!match) { console.error('用法: dock complete <任务标题关键词>'); process.exit(1); }
      payload = { cmd: 'complete', match };
      break;
    case 'recap':
      payload = { cmd: 'recap' };
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(`
AI Daily Dock CLI

用法:
  dock                      唤起 Dock 窗口
  dock add <标题>           创建新便利贴（当前活跃看板）
  dock list                 列出当前看板的所有任务
  dock complete <关键词>    按标题模糊匹配标记完成
  dock recap                生成今日复盘
  dock help                 显示帮助

与 Codex/Claude Code 联动:
  # Agent 完成任务后自动推送
  dock complete "论文笔记归档"

  # Agent 创建新任务
  dock add "下一步：优化白板侧边栏"
`);
      process.exit(0);
    default:
      console.error('未知命令: ' + cmd + '，输入 dock help 查看帮助');
      process.exit(1);
  }

  const res = await sendToApp(payload);
  if (res.ok) {
    if (res.message) console.log('✅ ' + res.message);
    if (res.data) console.log(JSON.stringify(res.data, null, 2));
  } else {
    console.error('❌ ' + (res.error || '操作失败'));
    process.exit(1);
  }
}

main();
