require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const nodeFetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 封面磁盘缓存目录(首次从 RomM/CDN 拉取后落盘,后续纯本地读取)
// 桌面版通过 ROMM_TRANSLATOR_DATA_DIR 将可写数据放到用户目录，开发模式保持原路径。
const DATA_DIR = process.env.ROMM_TRANSLATOR_DATA_DIR || __dirname;
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'covers');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ============================================================
// 数据库动态连接管理
// ------------------------------------------------------------
// 浏览器无法直连 MariaDB(无 TCP 能力),因此由本服务代理连接:
// 前端把连接参数 POST /api/connect,后端动态创建连接池并校验,
// 后续 /api/roms 等接口均使用"当前连接池"。
// 若 .env 配置了 DB_*,启动时会自动尝试连接(前端可随时覆盖)。
// ============================================================
let currentPool = null;
let connectionInfo = null;

function getPool() {
  return currentPool;
}

async function closeCurrentPool() {
  if (currentPool) {
    try { await currentPool.end(); } catch (e) { /* 忽略关闭错误 */ }
    currentPool = null;
    connectionInfo = null;
  }
}

// 创建连接池并校验连通性,失败则清理并抛出
async function createPoolFromConfig(cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port || 3306,
    user: cfg.user,
    password: cfg.password || '',
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 8000
  });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  return pool;
}

async function applyConnection(cfg) {
  await closeCurrentPool();
  const pool = await createPoolFromConfig(cfg);
  currentPool = pool;
  connectionInfo = {
    host: cfg.host,
    port: cfg.port || 3306,
    user: cfg.user,
    database: cfg.database
  };
  coverMap.clear(); // 换库后封面映射失效
  await refreshCoverMap();
}

// 启动时尝试用 .env 自动连接(失败仅记日志,不阻塞启动)
if (process.env.DB_HOST) {
  (async () => {
    try {
      await applyConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
      });
      console.log(`[数据库] 已自动连接 ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME}(来自 .env)`);
    } catch (e) {
      console.log(`[数据库] .env 自动连接失败(可忽略,稍后可在前端手动连接): ${e.message}`);
    }
  })();
}

// 连接状态查询
app.get('/api/connection', (req, res) => {
  res.json({
    success: true,
    connected: !!currentPool,
    info: connectionInfo
  });
});

// 动态连接(前端传入 MariaDB 连接参数)
app.post('/api/connect', async (req, res) => {
  const { host, port, user, password, database } = req.body || {};
  if (!host || !user || !database) {
    return res.status(400).json({ success: false, message: 'host / user / database 不能为空' });
  }
  try {
    await applyConnection({ host, port: Number(port || 3306), user, password, database });
    const [[cnt]] = await getPool().query('SELECT COUNT(*) AS total FROM roms');
    res.json({
      success: true,
      message: `已连接 ${host}:${port || 3306}/${database}`,
      total_in_db: cnt.total
    });
  } catch (error) {
    await closeCurrentPool();
    console.error('数据库连接失败:', error.message);
    res.status(500).json({ success: false, message: `连接失败: ${error.message}` });
  }
});

// 断开连接
app.post('/api/disconnect', async (req, res) => {
  await closeCurrentPool();
  res.json({ success: true, message: '已断开数据库连接' });
});

// ============================================================
// RomM 封面:代理 + 本地磁盘缓存
// ------------------------------------------------------------
// DB 中 roms 表存封面路径的字段是 path_cover_s / path_cover_l
// (小图/大图),值为相对 RomM resources 目录的路径,例如:
//   roms/1/7/cover/small.png
// 实际文件在 RomM 容器内: /romm/resources/roms/1/7/cover/
// Web 访问 URL 为: {ROMM_URL}/assets/romm/resources/{path}
// 另外 url_cover 是 SteamGridDB 的公开 CDN 地址。
//
// 加载顺序(解决公网 CDN 慢的问题):
//   1. 磁盘缓存(秒开,零网络)
//   2. 局域网 RomM 资源(快)
//   3. CDN url_cover(兜底)
// 首次拉取后落盘 cache/covers/{id}.bin,之后不再访问数据库/网络。
// ============================================================
const ROMM_URL = (process.env.ROMM_URL || '').replace(/\/+$/, '');
const rommCoverUrl = (dbPath) =>
  dbPath && ROMM_URL ? `${ROMM_URL}/assets/romm/resources/${dbPath}` : null;

// id -> { path_cover_s, url_cover }(内存映射,避免每个图片请求都查数据库)
let coverMap = new Map();

async function refreshCoverMap() {
  const pool = getPool();
  if (!pool) return;
  try {
    const [rows] = await pool.query('SELECT id, path_cover_s, url_cover FROM roms');
    coverMap = new Map(rows.map(r => [r.id, { path_cover_s: r.path_cover_s, url_cover: r.url_cover }]));
    console.log(`[封面] 封面映射已加载 ${coverMap.size} 条`);
  } catch (e) {
    console.error('刷新封面映射失败:', e.message);
  }
}

async function fetchCoverInfo(id) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query('SELECT path_cover_s, url_cover FROM roms WHERE id = ?', [id]);
    if (!rows.length) return null;
    const info = { path_cover_s: rows[0].path_cover_s, url_cover: rows[0].url_cover };
    coverMap.set(id, info);
    return info;
  } catch { return null; }
}

function clearCoverCache(id) {
  for (const f of [`${id}.bin`, `${id}.mime`]) {
    try { fs.rmSync(path.join(CACHE_DIR, f), { force: true }); } catch { /* 忽略 */ }
  }
}

// 并发下载去重:同一 id 同时多个请求时只拉一次
const pendingFetches = new Map();

function downloadCover(id, info) {
  const sources = [];
  if (ROMM_URL && info.path_cover_s) sources.push(`${ROMM_URL}/assets/romm/resources/${info.path_cover_s}`);
  if (info.url_cover) sources.push(info.url_cover);

  return (async () => {
    for (const url of sources) {
      try {
        const r = await fetch(url, {
          signal: AbortSignal.timeout(12000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 100) continue; // 防空图
        const mime = (r.headers.get('content-type') || 'image/png').split(';')[0].trim();
        fs.writeFileSync(path.join(CACHE_DIR, `${id}.bin`), buf);
        fs.writeFileSync(path.join(CACHE_DIR, `${id}.mime`), mime);
        return { buf, mime };
      } catch { /* 尝试下一个源 */ }
    }
    return null;
  })();
}

// 封面代理接口:GET /api/cover/:id
app.get('/api/cover/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: '无效的 id' });
  }

  const binPath = path.join(CACHE_DIR, `${id}.bin`);
  const mimePath = path.join(CACHE_DIR, `${id}.mime`);

  // 1. 磁盘缓存命中 → 直接返回,零网络
  if (fs.existsSync(binPath)) {
    const mime = fs.existsSync(mimePath) ? fs.readFileSync(mimePath, 'utf8') : 'image/png';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(fs.readFileSync(binPath));
  }

  // 2. 未命中 → 拉取并落盘(并发去重)
  if (!pendingFetches.has(id)) {
    pendingFetches.set(id, (async () => {
      const info = coverMap.get(id) || (await fetchCoverInfo(id));
      if (!info) return null;
      return downloadCover(id, info);
    })().finally(() => pendingFetches.delete(id)));
  }

  const result = await pendingFetches.get(id);
  if (!result) {
    return res.status(404).json({ success: false, message: '封面获取失败(本地与 CDN 均不可用)' });
  }
  res.set('Content-Type', result.mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(result.buf);
});

// ============================================================
// RomM 封面修改(走 RomM 官方 API,安全,不会破坏数据库)
// ------------------------------------------------------------
// PUT /api/roms/{id} 支持 artwork(上传图片)与 url_cover(设置 URL),
// 需要 roms.write 权限。凭据来自 .env:ROMM_USER / ROMM_PASSWORD。
// ============================================================
let rommToken = null;
let rommTokenExp = 0;

async function getRommToken() {
  if (!ROMM_URL) throw new Error('未配置 ROMM_URL(见 .env)');
  if (!process.env.ROMM_USER || !process.env.ROMM_PASSWORD) {
    throw new Error('未配置 ROMM_USER / ROMM_PASSWORD(见 .env)');
  }
  if (rommToken && rommTokenExp > Date.now() + 60000) return rommToken;

  const body = new URLSearchParams({
    grant_type: 'password',
    username: process.env.ROMM_USER,
    password: process.env.ROMM_PASSWORD,
    scope: 'roms.write assets.read'
  });
  const res = await fetch(`${ROMM_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`RomM 登录失败: HTTP ${res.status}`);
  const json = await res.json();
  rommToken = json.access_token;
  rommTokenExp = Date.now() + (json.expires - 60) * 1000;
  return rommToken;
}

async function updateRommCover(romId, { url, fileBuf, fileName }) {
  const token = await getRommToken();
  const fd = new FormData();
  if (url) fd.append('url_cover', url);
  if (fileBuf) fd.append('artwork', new Blob([fileBuf], { type: 'image/png' }), fileName || 'cover.png');

  const res = await fetch(`${ROMM_URL}/api/roms/${romId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RomM 更新封面失败: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// 通过 URL 更新封面
app.post('/api/roms/:id/cover', async (req, res) => {
  const id = Number(req.params.id);
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ success: false, message: 'url 必须以 http(s):// 开头' });
  }
  try {
    await updateRommCover(id, { url });
    clearCoverCache(id);
    if (coverMap.has(id)) coverMap.get(id).url_cover = url;
    res.json({ success: true, message: '封面 URL 已更新' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 上传本地图片作为封面(base64 传输,避免引入 multipart 依赖)
app.post('/api/roms/:id/cover/upload', async (req, res) => {
  const id = Number(req.params.id);
  const { file_base64, file_name } = req.body || {};
  if (!file_base64) return res.status(400).json({ success: false, message: '缺少 file_base64' });
  try {
    const buf = Buffer.from(file_base64, 'base64');
    if (buf.length === 0) return res.status(400).json({ success: false, message: '图片内容为空' });
    await updateRommCover(id, { fileBuf: buf, fileName: file_name || 'cover.png' });
    clearCoverCache(id);
    res.json({ success: true, message: '封面已上传更新' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// IGDB 封面搜索
// ------------------------------------------------------------
// 通过 Twitch/IGDB API 搜索游戏封面,供用户选择后应用。
// 需要在 .env 配置 IGDB_CLIENT_ID + IGDB_CLIENT_SECRET。
// 支持通过代理访问(在设置面板中配置)。
// ============================================================

// 代理请求:有代理走 node-fetch + proxy-agent,无代理走内置 fetch
// 首次无代理时自动尝试重新加载配置(防止服务器启动时配置文件还不存在)
async function proxyFetch(url, options = {}) {
  if (currentProxyAgent) {
    return nodeFetch(url, { ...options, agent: currentProxyAgent });
  }
  // 尝试重新加载代理配置
  const pcfg = loadProxyConfig();
  if (pcfg.enabled && pcfg.host) {
    currentProxyAgent = new HttpsProxyAgent(`http://${pcfg.host}:${pcfg.port || 80}`);
    console.log(`[代理] 延迟加载代理 ${pcfg.host}:${pcfg.port}`);
    return nodeFetch(url, { ...options, agent: currentProxyAgent });
  }
  return fetch(url, options);
}
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID || '';
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET || '';

let igdbToken = null;
let igdbTokenExp = 0;

async function getIgdbToken() {
  if (!IGDB_CLIENT_ID || !IGDB_CLIENT_SECRET) {
    throw new Error('未配置 IGDB_CLIENT_ID / IGDB_CLIENT_SECRET(见 .env)');
  }
  if (igdbToken && igdbTokenExp > Date.now() + 60000) return igdbToken;

  const res = await proxyFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: IGDB_CLIENT_ID,
      client_secret: IGDB_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }).toString()
  });
  if (!res.ok) throw new Error(`IGDB 认证失败: HTTP ${res.status}`);
  const json = await res.json();
  igdbToken = json.access_token;
  igdbTokenExp = Date.now() + (json.expires_in - 60) * 1000;
  return igdbToken;
}

// RomM platform_slug -> IGDB platform.id 映射(常用机种)
const PLATFORM_MAP = {
  nes: 18, snes: 19, n64: 4, gba: 24, ds: 37, '3ds': 37,
  nds: 37, ndi: 37, gb: 33, gbc: 22,
  megadrive: 29, genesis: 29, sms: 64, gg: 35,
  psx: 7, ps1: 7, ps2: 8, ps3: 9, psp: 38, psvita: 46,
  'ps4': 48, 'ps5': 130,
  xbox: 11, 'xbox360': 12, 'xboxone': 49, 'xboxseries': 169,
  switch: 130, 'nswitch': 130,
  wii: 5, 'wiiu': 41,
  pc: 6, steam: 6, windows: 6,
  nds: 37, 'gamecube': 17, gc: 17,
  arcade: 52, pico: 63,
};

function igdbSlugToPlatformId(slug) {
  if (!slug) return null;
  const s = slug.toLowerCase().replace(/-/g, '');
  return PLATFORM_MAP[s] || null;
}

// 搜索结果缓存(query + platform -> results, 1小时过期)
const searchCache = new Map();
const SEARCH_CACHE_TTL = 3600 * 1000;

function getCacheKey(q, platform) {
  return `${q}|${platform || ''}`;
}

function getCachedSearch(q, platform) {
  const key = getCacheKey(q, platform);
  const entry = searchCache.get(key);
  if (entry && Date.now() - entry.ts < SEARCH_CACHE_TTL) return entry.results;
  searchCache.delete(key);
  return null;
}

function setCachedSearch(q, platform, results) {
  const key = getCacheKey(q, platform);
  searchCache.set(key, { results, ts: Date.now() });
  // 防止缓存无限膨胀,超过 500 条时清理最旧的
  if (searchCache.size > 500) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

// 从 RomM DB 搜索已有封面
async function searchRommCovers(query) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.url_cover, r.path_cover_s, p.name AS platform_name
       FROM roms r
       LEFT JOIN platforms p ON p.id = r.platform_id
       WHERE r.name LIKE ? OR r.id = ?
       LIMIT 10`,
      [`%${query}%`, Number(query) || 0]
    );
    return rows
      .filter(r => r.url_cover || r.path_cover_s)
      .map(r => ({
        url: r.url_cover || (ROMM_URL ? `${ROMM_URL}/assets/romm/resources/${r.path_cover_s}` : null),
        thumbnail: r.url_cover || null,
        name: r.name,
        platforms: r.platform_name ? [r.platform_name] : [],
        source: 'romm',
        rom_id: r.id
      }))
      .filter(r => r.url);
  } catch { return []; }
}

// 从 IGDB 搜索封面
async function searchIgdbCovers(query, platformId) {
  if (!IGDB_CLIENT_ID || !IGDB_CLIENT_SECRET) return [];
  try {
    const token = await getIgdbToken();
    const queryStr = `search "${query}"; fields name, cover.url, platforms.name; limit 20;`;

    const res = await proxyFetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': IGDB_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain'
      },
      body: queryStr
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('IGDB 搜索失败:', res.status, errText.slice(0, 200));
      return [];
    }
    const games = await res.json();
    const results = [];
    for (const g of games) {
      if (!g.cover) continue;
      let url = g.cover.url || '';
      if (url.startsWith('//')) url = 'https:' + url;
      const bigUrl = url.replace(/\/t_\w+\//, '/t_cover_big/');
      const thumbUrl = url.replace(/\/t_\w+\//, '/t_thumb/');
      const platforms = (g.platforms || []).map(p => p.name).filter(Boolean);
      results.push({
        url: bigUrl,
        thumbnail: thumbUrl,
        name: g.name || query,
        platforms,
        source: 'igdb'
      });
    }
    return results;
  } catch (e) {
    console.error('IGDB 搜索异常:', e.message);
    return [];
  }
}

// 搜索封面接口
app.get('/api/search-covers', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ success: false, message: '搜索关键词不能为空' });

  const platformSlug = (req.query.platform || '').trim() || null;
  const platformId = platformSlug ? igdbSlugToPlatformId(platformSlug) : null;

  // 检查缓存
  const cached = getCachedSearch(q, platformSlug);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  // 并行搜索 RomM DB + IGDB
  let rommResults = [];
  let igdbResults = [];
  let igdbError = null;
  try {
    [rommResults, igdbResults] = await Promise.all([
      searchRommCovers(q),
      searchIgdbCovers(q, platformId).catch(e => { igdbError = e.message; return []; })
    ]);
  } catch (e) {
    igdbError = e.message;
  }

  // 合并去重(RomM 优先)
  const seen = new Set();
  const merged = [];
  for (const r of [...rommResults, ...igdbResults]) {
    const key = r.url.split('?')[0]; // 忽略查询参数去重
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
  }

  // 有结果才缓存,空结果不缓存(防止代理未配置时缓存空结果)
  if (merged.length > 0) {
    setCachedSearch(q, platformSlug, merged);
  }
  const resp = { success: true, data: merged };
  if (igdbError) resp.igdb_error = igdbError;
  if (!currentProxyAgent && IGDB_CLIENT_ID) resp.warn = '代理未启用,IGDB 可能无法访问,请在设置中启用代理';
  res.json(resp);
});

// ============================================================
// 翻译服务(OpenAI 兼容接口:DeepSeek / OpenAI / Ollama 等)
// 在 .env 配置 TRANSLATE_API_URL / TRANSLATE_API_KEY / TRANSLATE_MODEL
// 不配置时退回演示模式(仅加前缀),便于先跑通流程。
// ============================================================
const TRANSLATE_API_URL = process.env.TRANSLATE_API_URL || '';
const TRANSLATE_API_KEY = process.env.TRANSLATE_API_KEY || '';
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'deepseek-chat';

async function translateText(text, targetLang = '中文') {
  if (!TRANSLATE_API_URL) {
    return { mocked: true, result: `[译] ${text}` };
  }
  const res = await fetch(`${TRANSLATE_API_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TRANSLATE_API_KEY}`
    },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `你是游戏元数据汉化专家。把用户提供的游戏名称或简介翻译成${targetLang}。` +
            '只输出翻译结果本身，不要任何解释、引号、前缀或多余内容。' +
            '游戏名称保持简洁通顺，专有名词（人名、地名、系列名）采用玩家惯用译法；' +
            '简介翻译要通顺自然，保留原文换行结构。'
        },
        { role: 'user', content: text }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`翻译 API 返回 ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('翻译 API 返回格式异常');
  return { result: content.trim() };
}

// 并发执行器(限制同时进行的翻译请求数,避免打爆 API)
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// ============================================================
// 接口
// ============================================================

// 获取 ROM 列表(含封面信息)
app.get('/api/roms', async (req, res) => {
  const pool = getPool();
  if (!pool) {
    return res.status(401).json({ success: false, message: '未连接数据库,请先在上方填写连接信息' });
  }
  try {
    const [countResult] = await pool.query('SELECT COUNT(*) as total FROM roms');
    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.summary, r.path_cover_s, r.path_cover_l, r.url_cover,
              r.platform_id, p.name AS platform_name, p.slug AS platform_slug,
              p.category AS platform_category
       FROM roms r
       LEFT JOIN platforms p ON p.id = r.platform_id`
    );

    const data = rows.map(r => ({
      id: r.id,
      name: r.name,
      summary: r.summary,
      path_cover_s: r.path_cover_s,
      path_cover_l: r.path_cover_l,
      url_cover: r.url_cover,
      platform_id: r.platform_id,
      platform_name: r.platform_name,
      platform_slug: r.platform_slug,
      platform_category: r.platform_category,
      // 封面统一走本地代理(局域网优先 + 磁盘缓存),无封面则 null
      cover_small: (r.url_cover || r.path_cover_s) ? `/api/cover/${r.id}` : null,
      cover_large: (r.url_cover || r.path_cover_l) ? `/api/cover/${r.id}` : null
    }));

    coverMap = new Map(rows.map(r => [r.id, { path_cover_s: r.path_cover_s, url_cover: r.url_cover }]));

    res.json({ success: true, total_in_db: countResult[0].total, data });
  } catch (error) {
    console.error('查询数据库失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 翻译单条文本(名称或简介)
app.post('/api/translate-text', async (req, res) => {
  const { text, target_lang } = req.body || {};
  if (!text) return res.status(400).json({ success: false, message: '缺少 text 参数' });
  try {
    const out = await translateText(text, target_lang);
    res.json({ success: true, ...out });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 批量翻译: [{ id, name, summary }] -> [{ id, translated_name, translated_summary, error? }]
app.post('/api/translate-batch', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: '无效的数据参数' });
  }
  try {
    const results = await mapWithConcurrency(items, 3, async (item) => {
      try {
        const name = item.name ? await translateText(item.name) : null;
        const summary = item.summary ? await translateText(item.summary) : null;
        return {
          id: item.id,
          translated_name: name ? name.result : item.name,
          translated_summary: summary ? summary.result : item.summary
        };
      } catch (e) {
        return { id: item.id, error: e.message };
      }
    });
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 批量写回数据库
app.post('/api/roms/update', async (req, res) => {
  const pool = getPool();
  if (!pool) {
    return res.status(401).json({ success: false, message: '未连接数据库' });
  }
  const { items } = req.body || {}; // 期望格式: [{ id: 1, name: "新名字", summary: "新简介" }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: '无效的数据参数' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const item of items) {
      // 仅更新名称与简介，切勿修改主键 ID
      await connection.query(
        'UPDATE roms SET name = ?, summary = ? WHERE id = ?',
        [item.name, item.summary, item.id]
      );
    }

    await connection.commit();
    res.json({ success: true, message: `成功更新 ${items.length} 条记录` });
  } catch (error) {
    await connection.rollback();
    console.error('批量更新失败，已回滚:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// 翻译设置 + 英文翻译(供封面搜索用)
// ------------------------------------------------------------
// 前端可配置翻译 API 地址和密钥,支持自动补全路径。
// 设置持久化到 translate-config.json。
// ============================================================
const translateConfigPath = path.join(DATA_DIR, 'translate-config.json');

function loadTranslateConfig() {
  try {
    if (fs.existsSync(translateConfigPath)) {
      return JSON.parse(fs.readFileSync(translateConfigPath, 'utf8'));
    }
  } catch { /* 忽略 */ }
  // 默认值:优先用 .env 已有的翻译配置
  return {
    baseUrl: process.env.TRANSLATE_API_URL || '',
    apiKey: process.env.TRANSLATE_API_KEY || '',
    model: process.env.TRANSLATE_MODEL || 'deepseek-chat',
    prompt: ''
  };
}

function saveTranslateConfig(cfg) {
  try {
    fs.writeFileSync(translateConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('保存翻译配置失败:', e.message);
  }
}

// 智能补全 API 路径:用户输入基础地址,自动拼出完整的 chat/completions 端点
function resolveTranslateUrl(baseUrl) {
  let url = baseUrl.replace(/\/+$/, '');
  // 已经包含完整路径则直接用
  if (/\/(v\d+\/)?(chat\/)?completions?$/i.test(url)) return url;
  // 包含 /v1 但没有 completions
  if (/\/v\d+$/i.test(url)) return url + '/chat/completions';
  // 只有基础地址(如 http://192.168.x.x:8090 或 https://api.deepseek.com)
  return url + '/v1/chat/completions';
}

// 获取翻译设置
app.get('/api/translate-settings', (req, res) => {
  const cfg = loadTranslateConfig();
  res.json({
    success: true,
    data: {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey ? '****' + cfg.apiKey.slice(-4) : '',
      apiKeySet: !!cfg.apiKey,
      model: cfg.model,
      prompt: cfg.prompt || '',
      resolvedUrl: cfg.baseUrl ? resolveTranslateUrl(cfg.baseUrl) : ''
    }
  });
});

// 获取可用模型列表(从 OpenAI 兼容接口的 /v1/models 拉取)
app.get('/api/translate-models', async (req, res) => {
  const cfg = loadTranslateConfig();
  if (!cfg.baseUrl || !cfg.apiKey) {
    return res.json({ success: true, data: [], message: '未配置翻译 API' });
  }
  try {
    let modelsUrl = cfg.baseUrl.replace(/\/+$/, '');
    if (!/\/v\d+\/models$/i.test(modelsUrl)) {
      if (/\/v\d+$/i.test(modelsUrl)) modelsUrl += '/models';
      else modelsUrl += '/v1/models';
    }
    const apiRes = await fetch(modelsUrl, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` }
    });
    if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
    const json = await apiRes.json();
    const models = (json.data || json || [])
      .map(m => m.id || m)
      .filter(Boolean)
      .sort();
    res.json({ success: true, data: models });
  } catch (e) {
    res.json({ success: true, data: [], message: '获取模型列表失败: ' + e.message });
  }
});

// 保存翻译设置
app.post('/api/translate-settings', (req, res) => {
  const { baseUrl, apiKey, model, prompt } = req.body || {};
  const current = loadTranslateConfig();
  const cfg = {
    baseUrl: baseUrl !== undefined ? baseUrl : current.baseUrl,
    apiKey: apiKey !== undefined ? apiKey : current.apiKey,
    model: model !== undefined ? model : current.model,
    prompt: prompt !== undefined ? prompt : current.prompt
  };
  saveTranslateConfig(cfg);
  res.json({ success: true, message: '翻译设置已保存' });
});

// ============================================================
// 代理设置(用于 IGDB 等外网请求)
// ============================================================
const proxyConfigPath = path.join(DATA_DIR, 'proxy-config.json');

function loadProxyConfig() {
  try {
    if (fs.existsSync(proxyConfigPath)) {
      return JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'));
    }
  } catch { /* 忽略 */ }
  return { enabled: false, host: '', port: '' };
}

function saveProxyConfig(cfg) {
  try {
    fs.writeFileSync(proxyConfigPath, JSON.stringify(cfg, null, 2), 'utf8');
    // 同步更新当前代理 agent
    currentProxyAgent = cfg.enabled && cfg.host ? new HttpsProxyAgent(`http://${cfg.host}:${cfg.port || 80}`) : null;
  } catch (e) {
    console.error('保存代理配置失败:', e.message);
  }
}

let currentProxyAgent = null;
// 启动时加载代理配置
(() => {
  const pcfg = loadProxyConfig();
  if (pcfg.enabled && pcfg.host) {
    currentProxyAgent = new HttpsProxyAgent(`http://${pcfg.host}:${pcfg.port || 80}`);
    console.log(`[代理] 已启用 ${pcfg.host}:${pcfg.port}`);
  }
})();

// 获取代理设置
app.get('/api/proxy-settings', (req, res) => {
  const cfg = loadProxyConfig();
  res.json({ success: true, data: cfg });
});

// 保存代理设置
app.post('/api/proxy-settings', (req, res) => {
  const { enabled, host, port } = req.body || {};
  const cfg = {
    enabled: !!enabled,
    host: (host || '').trim(),
    port: (port || '').trim() || '80'
  };
  saveProxyConfig(cfg);
  searchCache.clear(); // 代理变更后清空搜索缓存
  res.json({
    success: true,
    message: cfg.enabled ? `代理已启用: ${cfg.host}:${cfg.port}` : '代理已关闭'
  });
});

// 游戏名称翻译端点:支持中→英 / 中→日,传入平台名提高准确度
app.post('/api/translate-game-name', async (req, res) => {
  const { text, target, platform } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, message: '缺少 text 参数' });
  }
  const cfg = loadTranslateConfig();
  if (!cfg.baseUrl || !cfg.apiKey) {
    return res.status(400).json({
      success: false,
      message: '未配置翻译 API,请在顶部「翻译设置」中填写地址和密钥'
    });
  }

  const lang = target === 'ja' ? '日文罗马音' : '英文';
  const platformHint = platform ? `\n该游戏所属平台: ${platform}` : '';

  // 默认提示词(含平台上下文)
  const defaultPrompt = `你是游戏名称翻译专家。将用户提供的游戏名称翻译成${lang}。
只输出翻译结果本身，不要任何解释、引号、前缀或多余内容。
要求：
1. 必须使用该游戏在国际游戏数据库(IGDB/SteamGridDB)中的官方英文名称
2. 专有名词采用玩家社区和数据库通用的译名，不要直译
3. 如果是日本游戏，用罗马音或国际通用英文名(如 ゼルダの伝説 -> The Legend of Zelda)
4. 如果是中文游戏，用海外发行名(如 忍者猫 -> Kyatto Ninden Teyandee)
${platformHint}`;

  try {
    const url = resolveTranslateUrl(cfg.baseUrl);
    const apiRes = await proxyFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: (cfg.prompt || defaultPrompt) + platformHint
          },
          { role: 'user', content: text }
        ]
      })
    });
    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      throw new Error(`翻译 API 返回 ${apiRes.status}: ${errBody.slice(0, 200)}`);
    }
    const json = await apiRes.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('翻译 API 返回格式异常');
    res.json({ success: true, result: content.trim() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`服务已启动：http://${HOST}:${PORT}`);
  console.log(`RomM 封面基址: ${ROMM_URL || '(未配置,仅用 CDN url_cover)'}`);
  const tc = loadTranslateConfig();
  console.log(`翻译服务: ${tc.baseUrl ? resolveTranslateUrl(tc.baseUrl) : '(演示模式,仅加 [译] 前缀)'}`);
});
