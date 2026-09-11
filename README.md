# RomM 汉化工作台

<p align="center">
  <img src="assets/icon-512.png" alt="RomM 汉化工作台" width="128" height="128" />
</p>

面向自建游戏库 [RomM](https://github.com/rommapp/romm) 的本地汉化工具：直连 RomM 底层 MariaDB，在网页里批量用 AI 翻译游戏名称与简介，并写回数据库；同时提供封面缓存、封面 URL 修改与本地图片上传。

> 仅建议在本机或可信局域网使用。更新类接口无鉴权，请勿直接暴露到公网。

## 功能特性

- **数据库直连**：由本地 Node 后端代理连接 RomM 的 MariaDB（浏览器无法直连 TCP 数据库）
- **批量 AI 翻译**：名称 + 简介，OpenAI 兼容接口（DeepSeek / OpenAI / Ollama 等），后端并发 3
- **机种筛选**：按平台 / 分类过滤 ROM 列表，便于分批处理
- **封面加速**：本地磁盘缓存 → 局域网 RomM 资源 → SteamGridDB 兜底，懒加载
- **封面管理**：修改封面 URL、上传本地图，走 RomM 官方 API，不破坏数据库结构
- **配置可前端化**：数据库连接、翻译 API、HTTP 代理均可在页面里配置并保存
- **便携启动**：Windows 双击 `start.bat` 即可；也可用系统 Node 开发运行

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js · Express · mysql2 |
| 前端 | 原生 HTML / CSS / JS（零构建） |
| 翻译 | OpenAI 兼容 Chat Completions |
| 可选桌面壳 | Python · pywebview · PyInstaller（`desktop.py`） |

## 下载（Release）

打 `v*` 标签后，GitHub Actions 会在 Windows 环境自动打包桌面版，并把 zip 挂到 [Releases](https://github.com/dkl070418/Romm-Rom-Translator/releases)。

```bash
git tag v1.0.0
git push origin v1.0.0
```

产物：`RomMTranslator-win64-v*.zip`（含 `RomMTranslator.exe`、内置 Node、前端与 `.env.example`）。  
解压后把 `.env.example` 复制为 `.env` 填好配置，双击 EXE 即可。

也可以在 Actions 页手动触发 **Build Windows EXE**（`workflow_dispatch`），artifact 可下载，但不会自动创建 Release。

## 快速开始

### 方式一：开发模式（推荐先用这个）

```bash
# 1. 安装依赖（国内可用镜像）
npm install --registry=https://registry.npmmirror.com

# 2. 准备配置
copy .env.example .env
# 编辑 .env，填入 MariaDB / RomM / 翻译 API 等信息

# 3. 启动
npm start
# 浏览器打开 http://localhost:3000
```

也可以不写 `.env`，启动后在页面顶部连接栏直接填数据库参数。

### 方式二：便携启动（Windows）

1. 准备好项目目录（含内置 `node/` 或本机已装 Node）
2. 双击 **`start.bat`**
3. 浏览器自动打开 `http://localhost:3000`

若缺少 `node_modules`，启动器会通过 npmmirror 自动安装。若提示找不到 Node，可将 [Node.js Windows 便携版](https://registry.npmmirror.com/-/binary/node/) 解压到项目 `node/` 目录。

### 方式三：桌面窗口（可选）

```bash
pip install -r requirements-desktop.txt
python desktop.py
```

打包可参考 `RomMTranslator.spec`（PyInstaller）。

## 配置说明

### 数据库连接（二选一）

1. **前端配置（推荐）**：页面顶部填写主机 / 端口 / 用户 / 密码 / 库名 →「连接」。参数保存在浏览器 localStorage。
2. **`.env` 配置**：复制 `.env.example` 为 `.env` 后填写，启动时自动连接；前端仍可随时覆盖。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | 是 | RomM 的 MariaDB 连接信息 |
| `PORT` | 否 | 本服务端口，默认 `3000` |
| `HOST` | 否 | 监听地址，默认 `127.0.0.1` |
| `ROMM_URL` | 否 | RomM Web 地址，用于拼接封面资源 URL |
| `ROMM_USER` / `ROMM_PASSWORD` | 否 | 修改 / 上传封面时调用 RomM API |
| `TRANSLATE_API_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL` | 否 | 翻译接口；不配则演示模式（仅加 `[译]` 前缀） |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | 否 | IGDB 封面搜索（[Twitch 开发者控制台](https://dev.twitch.tv/console/apps)） |

### 翻译 API 示例（DeepSeek）

```env
TRANSLATE_API_URL=https://api.deepseek.com/v1
TRANSLATE_API_KEY=sk-xxxxxxxx
TRANSLATE_MODEL=deepseek-chat
```

也可在页面「⚙️ 翻译 API 设置」中配置，会持久化到 `translate-config.json`（已 gitignore）。只需填基础地址，系统会自动补全 `/v1/chat/completions`。

配置后：勾选游戏 →「AI 翻译选中项」→ 确认 → 保存到数据库。

> 保存会覆盖库中的 `name` / `summary`。请先用「导出选中项 JSON」备份（导出含 `original_name` / `original_summary`）。

## 封面说明

- 前端统一走本地代理 `/api/cover/:id`，加载顺序：本地缓存 `cache/covers/` → 局域网 RomM 资源 → SteamGridDB CDN
- 删除 `cache/covers/` 可强制全部重新拉取
- 「封面 URL」「上传封面」走 RomM 官方 API（`PUT /api/roms/{id}`），需要配置 `ROMM_URL` + 账号
- **不要**直接改数据库中的 `path_cover_s` / `path_cover_l`，否则容易裂图；也不要随意改主键 / 外键

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/connection` | 查询当前连接状态 |
| POST | `/api/connect` | 动态连接 `{host, port, user, password, database}` |
| POST | `/api/disconnect` | 断开数据库 |
| GET | `/api/roms` | 获取 ROM 列表（含封面 URL） |
| POST | `/api/translate-text` | 翻译单条文本 |
| POST | `/api/translate-batch` | 批量翻译 `[{id, name, summary}]` |
| POST | `/api/roms/update` | 批量写回 `[{id, name, summary}]` |

## 测试

```bash
npm test
```

冒烟测试会在独立端口拉起服务，覆盖连接 / 列表 / 翻译 / 更新等场景。

## 安全与隐私

请勿将下列文件提交到 Git（已在 `.gitignore` 中）：

- `.env`
- `translate-config.json`
- `proxy-config.json`
- `cache/`、`dist/`、`build/`、`node/`

仓库仅保留模板：

- `.env.example`
- `translate-config.example.json`
- `proxy-config.example.json`

## 目录结构（核心）

```
romm-translator/
├── server.js                 # Express 后端（DB / 翻译 / 封面 / RomM API）
├── public/index.html         # 单页前端
├── start.bat / start.js      # Windows 一键启动
├── desktop.py                # 可选桌面壳
├── RomMTranslator.spec       # PyInstaller 打包配置（含 icon）
├── assets/icon.ico           # 应用图标
├── .github/workflows/        # Windows EXE 自动打包
├── tests/smoke.js            # 冒烟测试
├── .env.example              # 配置模板
└── translate-config.example.json
```

## License

[Apache License 2.0](LICENSE)
