// 冒烟测试:独立端口启动服务,验证核心接口(需数据库可达;优先用 .env 中的连接参数)
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从 .env 读取的数据库连接参数(供 /api/connect 测试)
const ENV_DB = {
  host: process.env.DB_HOST,
  port: String(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME
};

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch { /* 服务未就绪 */ }
    await sleep(300);
  }
  throw new Error('服务启动超时');
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  let passed = 0, failed = 0;
  const check = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name} ${extra}`); }
  };

  try {
    await waitForServer(`${BASE}/`);

    // 1. 首页可访问
    const page = await fetch(`${BASE}/`);
    check('首页 HTTP 200', page.status === 200);

    // 2. 连接状态接口
    const connRes = await fetch(`${BASE}/api/connection`);
    const conn = await connRes.json();
    check('/api/connection 返回 connected', conn.success === true && typeof conn.connected === 'boolean');

    // 3. 动态连接:错误密码应失败
    const bad = await fetch(`${BASE}/api/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ENV_DB, password: 'wrong-password' })
    });
    const badJson = await bad.json();
    check('错误密码连接被拒绝', badJson.success === false);

    // 4. 动态连接:正确参数应成功(仅当 .env 配置了 DB_HOST)
    if (ENV_DB.host) {
      const ok = await fetch(`${BASE}/api/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ENV_DB)
      });
      const okJson = await ok.json();
      check('正确参数连接成功', okJson.success === true && typeof okJson.total_in_db === 'number');
    } else {
      console.log('  ⏭️  跳过连接成功测试(.env 未配置 DB_HOST)');
    }

    // 5. /api/roms 返回 ROM 列表且带封面字段
    const romsRes = await fetch(`${BASE}/api/roms`);
    const roms = await romsRes.json();
    check('GET /api/roms success', roms.success === true);
    check('返回数据为数组且非空', Array.isArray(roms.data) && roms.data.length > 0);
    const sample = roms.data[0];
    check('数据含封面字段 cover_small', 'cover_small' in sample);
    check('数据含封面字段 url_cover', 'url_cover' in sample);
    check('数据含 name/summary 字段', typeof sample.name === 'string' && typeof sample.summary === 'string');
    check('数据含机种字段 platform_id/platform_name/platform_slug',
      Number.isInteger(sample.platform_id) && typeof sample.platform_name === 'string' && typeof sample.platform_slug === 'string');

    // 5.1 封面代理:首次拉取(局域网/CDN)应 200
    const cover1Start = Date.now();
    const cov1 = await fetch(`${BASE}/api/cover/7`);
    const cover1Ms = Date.now() - cover1Start;
    check('GET /api/cover/7 首次拉取 200', cov1.status === 200 && (cov1.headers.get('content-type') || '').startsWith('image'));
    console.log(`       (首次拉取耗时 ${cover1Ms}ms)`);

    // 5.2 封面代理:二次请求命中磁盘缓存,也应 200 且更快
    const cover2Start = Date.now();
    const cov2 = await fetch(`${BASE}/api/cover/7`);
    const cover2Ms = Date.now() - cover2Start;
    check('GET /api/cover/7 缓存命中 200', cov2.status === 200);
    console.log(`       (缓存命中耗时 ${cover2Ms}ms,首拉 ${cover1Ms}ms)`);

    // 5.3 封面代理:不存在的 id 返回 404
    const cov404 = await fetch(`${BASE}/api/cover/999999`);
    check('GET /api/cover/999999 返回 404', cov404.status === 404);

    // 6. 单条翻译(演示模式)
    const tr = await fetch(`${BASE}/api/translate-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' })
    });
    const trJson = await tr.json();
    check('POST /api/translate-text 成功', trJson.success === true && typeof trJson.result === 'string');

    // 7. 批量翻译
    const tb = await fetch(`${BASE}/api/translate-batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 1, name: 'A' }, { id: 2, name: 'B', summary: 'S' }] })
    });
    const tbJson = await tb.json();
    check('POST /api/translate-batch 返回 2 条', tbJson.success === true && tbJson.data.length === 2);

    // 8. 更新接口参数校验:空数组应 400
    const up = await fetch(`${BASE}/api/roms/update`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] })
    });
    check('更新接口空数组返回 400', up.status === 400);

    // 9. 更新接口无 body 应 400(而非 500)
    const up2 = await fetch(`${BASE}/api/roms/update`, { method: 'POST' });
    check('更新接口无 body 返回 400', up2.status === 400);

    // 10. 断开连接后 /api/roms 应返回 401
    await fetch(`${BASE}/api/disconnect`, { method: 'POST' });
    const afterDisc = await fetch(`${BASE}/api/roms`);
    check('断开后 /api/roms 返回 401', afterDisc.status === 401);
  } catch (e) {
    failed++;
    console.error(`  ❌ 测试异常: ${e.message}`);
  } finally {
    child.kill();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();
