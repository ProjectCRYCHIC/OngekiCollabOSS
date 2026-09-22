# OngekiCollab

> English is the default README: [README.md](README.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ProjectCRYCHIC/OngekiCollabOSS)

OngekiCollab 是一个独立部署的 Ongeki 公网联机中继。游戏端继续使用原生的招募、选难度、Ready、开始和取消界面；服务端负责房间目录、WebSocket 中继、实时看板和管理功能。

仓库不包含游戏本体或游戏资源。

English: OngekiCollab is a self-contained online relay with the same API and client behavior on Cloudflare or a self-hosted server.

## 它能做什么

- 公开匹配池和自定义匹配池。
- 使用游戏原生联机界面，不增加另一套房间 UI。
- 在客户端之间核对所选难度的官方谱面哈希，发现不一致时阻止开局。
- 实时展示招募房间、游玩成绩和最近对战记录。
- 管理身份验证开关、玩家封禁和活跃对战。
- 支持 Cloudflare Native 和 Docker 自托管；两种部署使用同一套客户端和协议。

公开池不会把玩家自动塞进同一房间。创建房间和加入房间是两个明确动作；加入其他房间时，客户端会提交目录里的 `roomId`。

## 先选一种部署方式

| 方式 | 适合谁 | 数据与实时状态 | 管理员登录 |
| --- | --- | --- | --- |
| Self-hosted | 想完全掌握服务器和数据 | MySQL/MariaDB 或 SQLite；Redis 或单进程内存 | 密码登录 |
| Cloudflare Native | 想少维护服务器 | D1 + Durable Objects | Cloudflare Access |

无论选哪一种，游戏客户端都只需要一个服务地址。

## Cloudflare Native

一键部署只需要 Cloudflare 账号；自定义域名可选。手动部署还需要 Node.js 22。

### 一键部署

点击页面顶部的 **Deploy to Cloudflare**。部署向导会复制公开仓库，并按照 `wrangler.jsonc`：

- 创建并绑定 D1 数据库；
- 创建四个 Durable Objects；
- 要求填写四项独立密钥；
- 自动应用 D1 migrations、构建前端并发布到 `*.workers.dev`。

四项密钥都使用 `openssl rand -base64 32` 分别生成，不要复用。自定义域名不是通用模板的一部分；一键部署成功后，可在 Worker 的 **Settings → Domains & Routes** 中添加自己的域名。需要管理台时，再按下文配置 Cloudflare Access。

### 手动部署

```bash
npm ci --legacy-peer-deps
npx wrangler login
npx wrangler d1 create ongeki-collab
```

把命令输出的 `database_id` 写入 `wrangler.jsonc`，并按需修改 Worker 名称。然后设置密钥并部署：

```bash
npx wrangler secret put IDENTITY_HASH_SECRET
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler secret put TICKET_SIGNING_SECRET
npx wrangler secret put ADMIN_RESET_SECRET
npm run deploy
```

`npm run deploy` 会依次重建 `web/`、应用远程 D1 migrations，再发布 Worker 和静态资源。默认先得到 `*.workers.dev` 地址；自定义域名可在部署后添加。

服务运行必须配置三个互相独立的 32 字节 Base64 密钥：

- `IDENTITY_HASH_SECRET`
- `KEY_ENCRYPTION_SECRET`
- `TICKET_SIGNING_SECRET`

生产环境还建议配置第四项 `ADMIN_RESET_SECRET`，用于管理员重置接口和身份模式开启时的线上冒烟清理。

Windows 可以使用仓库脚本生成、在当前用户下加密备份并上传：

```powershell
./scripts/provision-secrets.ps1 -Upload
```

脚本把备份保存在 `%LOCALAPPDATA%\OngekiCollab\secrets.dpapi`。请连同对应的 Windows 用户环境一起妥善备份。其他系统可以使用 `npx wrangler secret put <名称>` 逐项设置。

发布完成后先检查：

```bash
curl https://collab.example.com/api/v1/health
```

### 保护管理页

在 Cloudflare Zero Trust 中创建一个 **Self-hosted** Access 应用：

1. 应用路径只填写 `你的域名/admin*`。
2. Allow 策略只加入真正的管理员。
3. 把团队发行者设置为 `ACCESS_TEAM_DOMAIN`。
4. 把应用的 AUD tag 设置为 `ACCESS_AUD`。

不要给整个 Worker 开 Access，否则游戏的 WebSocket 也会被拦截。两个 Access 配置缺失时，`/admin` 会保持 403；公开看板和游戏接口不因此开放管理权限。

## Self-hosted

默认配置会启动应用、MariaDB 和 Redis，适合直接长期运行。

```bash
cp .env.example .env
# 编辑 .env，至少填写数据库密码、三组必需密钥和初始管理员密码
docker compose up -d --build
```

三组必需密钥都可以用下面的命令单独生成：

```bash
openssl rand -base64 32
```

启动后：

- 服务地址：`http://<主机>:8080`
- 公开看板：`http://<主机>:8080/`
- 管理台：`http://<主机>:8080/admin`

首次登录使用 `.env` 中的 `ADMIN_INITIAL_PASSWORD`。数据库已有密码哈希后，这个变量不会再次覆盖密码。

### 选择存储方式

| 用法 | `COMPOSE_PROFILES` | `DATABASE_BACKEND` | `REALTIME_BACKEND` |
| --- | --- | --- | --- |
| 默认完整栈 | `bundled` | `mysql` | `redis` |
| 最轻量单机 | 留空 | `sqlite` | `memory` |
| 外部 MySQL + Redis | 留空 | `mysql` | `redis` |
| 随附 MariaDB、不要 Redis | `mariadb` | `mysql` | `memory` |
| SQLite + 随附 Redis | `redis` | `sqlite` | `redis` |

使用外部 MySQL/Redis 时，再填写 `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 和 `REDIS_URL`。

`memory` 只适合一个应用进程，不支持多副本之间的锁和消息广播。SQLite 也按单应用设计，不要让多个容器通过网络文件系统共享同一个 SQLite 文件。

### 反向代理

公网服务应使用 HTTPS/WSS。Caddy 的最小配置如下：

```caddy
collab.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

反向代理终止 TLS 时，把 `.env` 中的 `TRUST_PROXY` 设为 `1`。使用 Nginx 时，记得为 `/room`、`/api/v1/live` 和 `/api/v1/rooms/*/live` 转发 WebSocket Upgrade 头。

如果反向代理和应用在同一台机器，还可以设置 `APP_BIND=127.0.0.1`，避免应用端口直接监听所有网卡。

> **Unity 5.6 Mono TLS 说明：** 独立客户端通过 Windows `winhttp.dll`/Schannel 处理 TLS 协商和证书校验，公网中继必须使用 HTTPS/WSS 和 TLS 1.2 或更高版本。当前客户端支持现代 TLS 1.2/1.3 与 ECDSA 证书；不要回退到 HTTP、跟随重定向或关闭证书校验。

## 客户端怎么连接

独立客户端位于 `mod/`。编译方法和运行边界见 [`mod/README.md`](mod/README.md)。最短流程是：

1. 二选一安装客户端：MelonLoader 运行 `mod/build.ps1`，把自包含的 `OngekiCollab.Mod.dll` 放入 `Mods`；BepInEx 1–5 运行 `mod/build-all-bepinex.ps1`，只取与你的 Loader 大版本一致的 `OngekiCollab.BepInEx<大版本>.dll`。全部 DLL 均已内嵌指定版本的 JSON/WebSocket 库，不要再另外复制，也不要同时安装多个变体。
2. 首次启动后编辑与 `mu3.exe` 同级的 `client.json`。例如游戏是 `F:\package\mu3.exe`，配置文件就是 `F:\package\client.json`；它不在 `UserData`、STARTLINER profile 或 `BepInEx\plugins` 中。启动日志会先打印实际使用的绝对路径：`client.json path: ...`。
3. 修改配置中的中继字段；保留自动生成的身份和密钥字段：

```json
{
  "origin": "https://collab.example.com",
  "pool": "",
  "identityId": "",
  "clientKey": "",
  "anonymousKey": "",
  "onlineMode": true
}
```

4. `origin` 必须是纯 HTTP(S) 服务根地址，例如 `https://collab.example.com`（可带结尾 `/`）；不能包含路径、用户信息、查询参数、片段或 Markdown 包装。它必须已经是最终地址：客户端不会跟随 HTTP→HTTPS 重定向。`pool` 留空表示公开池；也可以填写 1–64 位字母、数字、`_` 或 `-`。不要手动覆盖 `identityId`、`clientKey` 或 `anonymousKey`。
5. 重启游戏。

`onlineMode: false` 会保留原来的局域网联机。公网地址应使用 HTTPS；HTTP 只适合可信的本地自托管环境。

在线模式仍然使用游戏原生按钮：

- 第一次按下“招募”就会创建房间。
- 招募列表会显示当前匹配池中本机可用的歌曲房间。
- 玩家进房后仍可用原生界面切换难度和 Ready。
- 房主只有在所有在线玩家 Ready、谱面一致并且原生 Party 就绪后才能开始。

## 看板和管理台

公开看板位于 `/`，支持深浅主题和中、英、日三种界面。它会显示：

- 正在招募和正在游玩的房间；
- 玩家槽位、难度和实时成绩；
- 最近 72 小时的对战记录；
- 乐曲封面和歌曲元数据。

管理台位于 `/admin`，可以：

- 开启或关闭玩家身份验证；
- 搜索玩家并封禁、解封；
- 查看活跃对战并强制关闭。

Cloudflare 部署使用 Access 登录；自托管使用密码登录。自托管管理员密码可这样重置：

```bash
docker compose exec -e ADMIN_NEW_PASSWORD='新密码' app npm run admin:reset-password
```

重置密码会同时吊销已有管理员会话。

## 升级和备份

### Cloudflare

```bash
git pull
npm ci --legacy-peer-deps
npm run check
npm run deploy
```

D1 迁移只追加，不修改已经发布的迁移文件。

### Self-hosted

```bash
git pull
docker compose build
docker compose up -d
```

容器启动时会按照 `DATABASE_BACKEND` 自动执行迁移。数据卷不会因为重新构建镜像而删除。

MariaDB 备份与恢复示例：

```bash
docker compose exec db sh -c 'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' > backup.sql
cat backup.sql | docker compose exec -T db sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
```

SQLite 部署应备份 `sqlite_data` 中的数据库文件。Redis 只保存可重建的实时状态，不应当作持久备份来源。

## 本地开发

```bash
npm ci --legacy-peer-deps

npm run dev                  # Cloudflare Worker 本地运行
npm run dev:web              # Vue 前端热更新，API 代理到 8787
npm run dev:selfhost         # 自托管 Node 运行时

npm run check                # 类型检查、全部测试、前端检查和禁用词扫描
npm run build:web            # 重建公开看板、管理页和登录页
```

需要测试 MySQL/Redis 组合时：

```bash
npm run test:selfhost:deps
npm run test:selfhost
npm run test:selfhost:deps:down
```

主要目录：

| 目录 | 内容 |
| --- | --- |
| `src/core` | 平台无关的协议、匹配、房间和管理逻辑 |
| `src/adapters` | D1、MySQL、SQLite、Durable Objects、Redis 和内存适配器 |
| `src/runtimes` | Cloudflare Worker 与自托管 Node 入口 |
| `frontend` | Vue 3 看板、管理页和登录页源码 |
| `web` | `npm run build:web` 生成的部署文件 |
| `mod` | 共用联机核心的 MelonLoader 0.7.1 / BepInEx 1–5 客户端 |
| `tests/contract` | 两种部署共用的协议契约测试 |

## API 和协议速览

| 端点 | 用途 |
| --- | --- |
| `GET /api/v1/health` | 健康检查 |
| `GET /api/v1/rooms` | 房间目录 |
| `GET /api/v1/history` | 对战历史 |
| `GET /api/v1/songs` | 看板用乐曲元数据 |
| `GET /api/v1/live?pool=...` | 房间与历史的只读实时 WebSocket |
| `WS /api/v1/rooms/{roomId}/live` | 单个房间的只读实时成绩 |
| `POST /api/v1/match` | 创建或加入房间；请求必须携带当前 `protocolVersion` |
| `WS(S) /room`、`/room/{pool}` | 游戏控制帧和二进制中继 |
| `/admin` | 管理控制台和管理 API |

一次联机的大致流程：

Match 请求固定携带 `protocolVersion: 1`。服务端会在创建房间或签发 WebSocket ticket 前拒绝缺失或不支持的协议版本，`gameVersion` 仍只表示游戏数据版本，不参与房间隔离。

1. 客户端调用 Match，取得 `roomId`、`peerId`、短期一次性 `ticket` 和 `wsPath`。
2. 客户端使用 ticket 连接房间 WebSocket，并接收 `snapshot`。
3. Ready 时上报最终选择的歌曲、难度和本机已有的官方谱面哈希。
4. 各客户端比较所有已连接且 Ready 玩家的同难度哈希；冲突时阻止开始。
5. 游玩中发送成绩，`endPlay` 后把最后成绩写入历史。

二进制中继只接受 Party/Advertise 使用的 50000 和 50002 端口。Setting 50001 与 DeliveryChecker 50003 始终保留在本地路径。

## 隐私和安全边界

- 公开 HTTP/WS 响应不返回谱面哈希、游戏身份原值或完整 title server 地址。
- 身份模式开启时，服务端只保存身份字段的带密钥摘要；客户端密钥加密保存。
- 身份模式关闭时，客户端使用独立的随机 `anonymousKey`。它只能识别一个安装，删除或替换密钥可能绕过匿名封禁，因此不等同于强账号身份。
- 房间 ticket 有时效且只能用于对应房间；服务端还保留 IP 限流。
- 管理页没有无认证降级路径。Access 配置、密码或会话配置错误时会拒绝访问。
- 谱面一致性由房内客户端共同判断，服务端只验证格式并转发房内状态。

## 验证

- 生产实例：`https://collab.anontokyo.jp`
- Cloudflare 集成测试和自托管 MySQL/SQLite × Redis/memory 契约测试均由 `npm run check` 覆盖。
- 独立客户端目前完成了离线编译和协议测试；真实双机跨网游玩仍需实机验证。

生产冒烟脚本：

```bash
node scripts/smoke-production.mjs
```

身份验证开启时，冒烟清理需要 `ADMIN_RESET_SECRET`；Windows 可直接使用：

```powershell
./scripts/provision-secrets.ps1 -Smoke
```

