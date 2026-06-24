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

  // 校验 shimDir 是否在 PATH 中：npm 全局目录通常在 PATH，但不保证
  const pathDirs = (process.env.PATH || '').split(';').map(function (d) { return d.toLowerCase().replace(/\\/g, '\\\\'); });
  const shimDirNorm = shimDir.toLowerCase().replace(/\\/g, '\\\\');
  const inPath = pathDirs.indexOf(shimDirNorm) >= 0;

  try {
    if (!fs.existsSync(shimDir)) fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(shimPath, shimContent);
    console.log('✅ 已安装 dock CLI → ' + shimPath);
    if (inPath) {
      console.log('   该目录已在 PATH 中。打开新终端运行 dock help 验证。');
    } else {
      console.warn('⚠️  ' + shimDir + ' 不在 PATH 中，直接运行 dock 会找不到。');
      console.warn('   两种解决办法（任选其一）：');
      console.warn('   1) 把该目录加入 PATH（推荐，一劳永逸）');
      console.warn('   2) 不装 shim，直接用完整路径调用：');
      console.warn('      "' + shimPath + '" help');
    }
  } catch (err) {
    console.error('❌ 写入 shim 失败:', err.message);
    console.log('   可手动创建 dock.cmd，内容为：');
    console.log('   ' + shimContent.trim());
    console.log('   或直接用 node 调用：node "' + cliPath + '" help');
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
