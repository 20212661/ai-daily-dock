/* ============================================================
   dock CLI 安装脚本
   运行 npm run link-cli 将 dock 命令注册到系统 PATH
   
   Windows: 创建 dock.cmd shim 到用户 PATH
   macOS/Linux: 创建符号链接到 /usr/local/bin/dock
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'cli', 'dock-cli.cjs');
const platform = process.platform;

console.log('正在安装 dock CLI...');

if (platform === 'win32') {
  // Windows: 创建 .cmd shim
  const shimDir = path.join(process.env.APPDATA || process.env.HOME, 'npm');
  const shimPath = path.join(shimDir, 'dock.cmd');
  const nodePath = process.execPath;
  const shimContent = `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`;
  
  try {
    if (!fs.existsSync(shimDir)) fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(shimPath, shimContent);
    console.log('✅ 已安装 dock CLI → ' + shimPath);
    console.log('   确保该目录在 PATH 中。打开新终端后运行 dock help 验证。');
  } catch (err) {
    console.error('❌ 安装失败:', err.message);
    console.log('   可手动创建: dock.cmd 指向 ' + cliPath);
  }
} else {
  // macOS/Linux: 符号链接到 /usr/local/bin
  const linkPath = '/usr/local/bin/dock';
  try {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(cliPath, linkPath);
    fs.chmodSync(cliPath, 0o755);
    console.log('✅ 已安装 dock CLI → ' + linkPath);
  } catch (err) {
    // 需要 sudo
    try {
      execSync(`sudo ln -sf "${cliPath}" "${linkPath}"`, { stdio: 'inherit' });
      execSync(`chmod +x "${cliPath}"`);
      console.log('✅ 已安装 dock CLI → ' + linkPath);
    } catch (err2) {
      console.error('❌ 安装失败，请手动执行:');
      console.log(`   sudo ln -s "${cliPath}" /usr/local/bin/dock`);
    }
  }
}

console.log('\n用法:');
console.log('  dock              唤起 Dock 窗口');
console.log('  dock add <标题>   创建新便利贴');
console.log('  dock list         显示任务列表');
console.log('  dock help         查看完整帮助');
