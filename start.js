// RomM Translator 一键启动器(由 start.bat 调用,编码安全:本文件为 UTF-8,
// 控制台已由 bat 切换为 65001,中文输出不会乱码)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MIRROR = 'https://registry.npmmirror.com';
const isWin = process.platform === 'win32';

function log(msg) { console.log(msg); }

// 优先使用内置便携 Node
function resolveNode() {
  const portable = path.join(ROOT, 'node', isWin ? 'node.exe' : 'bin/node');
  if (fs.existsSync(portable)) {
    log('[信息] 使用内置便携 Node.js');
    return portable;
  }
  return process.execPath;
}

// 读取 .env 中的 PORT(默认 3000)
function readEnvPort() {
  try {
    const content = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = content.match(/^PORT\s*=\s*(\d+)/m);
    return m ? m[1] : '3000';
  } catch { return '3000'; }
}

// node_modules 缺失时走 npmmirror 镜像安装
function ensureDeps(node) {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) return;
  log('[信息] 首次运行,正在通过 npmmirror 镜像安装依赖...');
  const npm = path.join(path.dirname(node), isWin ? 'npm.cmd' : 'npm');
  const r = spawnSync(npm, ['install', `--registry=${MIRROR}`, '--no-audit', '--no-fund'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin
  });
  if (r.status !== 0) {
    log('[错误] 依赖安装失败,请检查网络后重试。');
    process.exit(1);
  }
  log('[信息] 依赖安装完成');
}

// 检测端口是否被占用(临时监听探测)
function portInUse(port) {
  return new Promise(resolve => {
    const net = require('net');
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(Number(port), '127.0.0.1');
  });
}

(async () => {
  const node = resolveNode();
  const ver = spawnSync(node, ['-v'], { encoding: 'utf8' }).stdout.trim();
  if (!ver) {
    log('[错误] 未找到 Node.js!请将便携版解压到 node 目录,或安装系统 Node.js 后重试。');
    process.exit(1);
  }
  log(`[信息] Node.js 版本: ${ver}`);

  ensureDeps(node);

  const port = readEnvPort();
  if (await portInUse(port)) {
    log(`[警告] 端口 ${port} 已被占用。若页面无法打开,请关闭占用程序,或修改 .env 中的 PORT。`);
  }

  log('');
  log(`[信息] 正在启动 RomM 汉化工作台: http://localhost:${port}`);
  log('[信息] 关闭本窗口即可停止服务。');
  log('');

  // 打开默认浏览器
  const url = `http://localhost:${port}`;
  try {
    const opener = spawn(isWin ? 'cmd' : 'xdg-open', isWin ? ['/c', 'start', '', url] : [url], {
      stdio: 'ignore',
      detached: true
    });
    opener.unref();
  } catch { /* 打开失败不影响服务 */ }

  const child = spawn(node, ['server.js'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', code => {
    log('');
    log('服务已停止。');
    process.exit(code || 0);
  });
})();
