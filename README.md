# OngekiCollab

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ProjectCRYCHIC/OngekiCollabOSS)

**English is the default documentation.** For the Chinese version, see
[README.zh-CN.md](README.zh-CN.md).

OngekiCollab is a self-hosted online relay for ONGEKI. The game keeps its
native Recruit, difficulty, Ready, Start, and Cancel screens; the service
provides room discovery, WebSocket relay transport, the live spectator board,
and administration.

This repository does not contain the game executable or game assets.

## What it provides

- Public and named matching pools.
- The game's native online flow instead of a second room UI.
- Client-to-client comparison of official chart hashes for the selected
  difficulty before a host can start.
- Live recruiting rooms, in-game scores, and recent match history.
- Optional identity verification, player bans, and active-match controls.
- The same client and protocol on Cloudflare Native and Docker self-hosted
  deployments.

A public pool does not merge players into a room automatically. Creating a room
and joining a room are explicit actions; joining another room sends its
directory `roomId` to the service.

## Choose a deployment

| Deployment | Best for | Storage and realtime state | Admin login |
| --- | --- | --- | --- |
| Self-hosted | Full control over the host and data | MySQL/MariaDB or SQLite; Redis or single-process memory | Password |
| Cloudflare Native | Minimal server maintenance | D1 + Durable Objects | Cloudflare Access |

The game client needs only one service origin regardless of the deployment.

## Cloudflare Native

The one-click flow needs a Cloudflare account. A custom domain is optional.
Manual deployment also needs Node.js 22.

### One-click deployment

Click **Deploy to Cloudflare** above. The wizard copies the public repository
and uses `wrangler.jsonc` to:

- create and bind a D1 database;
- create the four Durable Object classes;
- request four independent secrets; and
- apply D1 migrations, build the frontend, and publish a `*.workers.dev`
  service.

Generate each secret independently with `openssl rand -base64 32`; never reuse
one secret for another purpose. After deployment, add a custom domain under
**Worker Settings → Domains & Routes** if needed. Configure Cloudflare Access
for `/admin*` as described below.

### Manual deployment

```bash
npm ci --legacy-peer-deps
npx wrangler login
npx wrangler d1 create ongeki-collab
```
Put the returned `database_id` in `wrangler.jsonc`, adjust the Worker name if
needed, then set the secrets and deploy:

```bash
npx wrangler secret put IDENTITY_HASH_SECRET
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler secret put TICKET_SIGNING_SECRET
npx wrangler secret put ADMIN_RESET_SECRET
npm run deploy
```

The first three secrets are required and must be different 32-byte Base64
values. `ADMIN_RESET_SECRET` is required for production administration and
smoke cleanup. `npm run deploy` rebuilds `web/`, applies remote D1 migrations,
and publishes the Worker and static assets.

On Windows, the repository helper can generate, DPAPI-back up, and upload the
secrets for the current user:

```powershell
./scripts/provision-secrets.ps1 -Upload
```

The encrypted backup is stored at
`%LOCALAPPDATA%\\OngekiCollab\\secrets.dpapi`. Keep it with the matching
Windows user profile. On other systems, use `npx wrangler secret put <NAME>`
for each secret.

Check the deployment before configuring the client:

```bash
curl https://collab.example.com/api/v1/health
```

### Protect the admin console

Create a **Self-hosted** Access application in Cloudflare Zero Trust:

1. Scope the application only to `your-domain/admin*`.
2. Allow only the actual administrators.
3. Set the team issuer domain in `ACCESS_TEAM_DOMAIN`.
4. Set the application's AUD tag in `ACCESS_AUD`.

Do not protect the entire Worker with Access: that would also block the
game's WebSocket connections. Missing or invalid Access configuration keeps
`/admin` at 403; it does not grant unauthenticated admin access.

## Self-hosted

The default Compose profile starts the application, MariaDB, and Redis:

```bash
cp .env.example .env
# Edit .env: database password, required secrets, and initial admin password
docker compose up -d --build
```

Generate the three service secrets independently:

```bash
openssl rand -base64 32
```

The default endpoints are:

- Service: `http://<host>:8080`
- Public board: `http://<host>:8080/`
- Admin console: `http://<host>:8080/admin`

The first admin login uses `ADMIN_INITIAL_PASSWORD`. Once a password hash
exists, that variable no longer overwrites it.

### Storage and realtime choices

| Use case | `COMPOSE_PROFILES` | `DATABASE_BACKEND` | `REALTIME_BACKEND` |
| --- | --- | --- | --- |
| Default full stack | `bundled` | `mysql` | `redis` |
| Small single host | empty | `sqlite` | `memory` |
| External MySQL + Redis | empty | `mysql` | `redis` |
| Bundled MariaDB without Redis | `mariadb` | `mysql` | `memory` |
| SQLite with bundled Redis | `redis` | `sqlite` | `redis` |

For external MySQL/Redis, also set `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`, and `REDIS_URL`.

`memory` supports only one application process; it has no cross-process
locking or message broadcast. SQLite is also a single-application deployment;
do not share its file over a network filesystem.

### Reverse proxy and TLS

Public deployments should use HTTPS/WSS. A minimal Caddy configuration is:

```caddy
collab.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

When the proxy terminates TLS, set `TRUST_PROXY=1` in `.env`. With Nginx,
forward WebSocket Upgrade headers for `/room`, `/api/v1/live`, and
`/api/v1/rooms/*/live`.

If the proxy and app run on the same host, set `APP_BIND=127.0.0.1` so the
application does not listen on every interface.

The standalone client uses Windows WinHTTP/Schannel for TLS negotiation and
certificate validation. Public relays must provide TLS 1.2 or newer. Modern
TLS 1.2/1.3 and ECDSA certificates are supported; do not add HTTP fallback,
redirect following, or certificate-verification bypasses.

## Standalone client configuration

The standalone client is in [`mod/`](mod/). It shares the relay protocol
between MelonLoader 0.7.1 and BepInEx 1–5. Read
[`mod/README.md`](mod/README.md) for build and compatibility details.

### Install exactly one client variant

Choose one loader and one matching OngekiCollab build:

| Loader | Install |
| --- | --- |
| MelonLoader 0.7.1 | Build `OngekiCollab.Mod.dll` and place only it in the game's `Mods` directory |
| BepInEx 1–4 | Place only the DLL matching the loader's major version in its plugin directory |
| BepInEx 5 | Install the package or DLL under `BepInEx/plugins/OngekiCollab`; the package targets BepInEx 5.4.23.2 and HarmonyX/0Harmony 2.9.0.0 |

Do not install MelonLoader and BepInEx variants together, and do not load two
OngekiCollab variants in one game process. Do not copy game assemblies,
loader assemblies, Harmony DLLs, or a separate `Newtonsoft.Json.dll`; the
approved JSON dependency is embedded in the client build.

### Configure `client.json`

The settings file is always beside `mu3.exe`, not under `UserData`, a
STARTLINER profile, or the loader's plugin directory. For example:

```text
F:\package\mu3.exe
F:\package\client.json
```

Start the game once, close it, and edit the generated file. The startup log
prints the resolved absolute path as:

```text
client.json path: <absolute path>
```

For a public relay, use:

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

Only edit `origin`, `pool`, and `onlineMode`:

| Field | Meaning |
| --- | --- |
| `origin` | The final HTTP(S) service root, for example `https://collab.example.com`. It may have a trailing slash, but no path, user info, query, fragment, or Markdown wrapper. The client does not follow redirects. |
| `pool` | Empty selects the public pool. A named pool is 1–64 characters using letters, digits, `_`, or `-`. All players who want to meet must use the same pool. |
| `onlineMode` | `true` enables the public relay flow; `false` keeps the game's native LAN flow. The default in a new file is `false`. |
| `identityId` | Generated after a successful identity binding. Do not edit or delete it during normal troubleshooting. |
| `clientKey` | A persistent 32-byte installation key. It is saved with owner-only Windows ACLs; back it up if the service requires identity verification. Never log or share it. |
| `anonymousKey` | A separate persistent 32-byte key generated when identity verification is disabled. Preserve it to keep the same anonymous installation identity. |

A public configuration should use HTTPS. HTTP is suitable only for a trusted
local self-hosted network. The client maps `http` to `ws` and `https` to
`wss`; it does not silently downgrade a secure origin.

### Use the native game controls

With `onlineMode: true`:

1. The first native Recruit press creates your room.
2. The native Recruit list shows joinable rooms in the configured pool.
3. Selecting another room submits its explicit `roomId`.
4. Difficulty selection, Ready, Start, and Cancel remain the game's controls.
5. A host starts only after every connected player is Ready, chart hashes agree,
   and native Party is ready.

The client has no extra settings panel and no F8 shortcut. LAN/offline sessions
do not perform public identity authentication. If the service requires identity,
log in to the game with the intended AIME/title-server identity before matching;
the client cannot invent missing `accessCode` or `userId`.

### Client troubleshooting

- If the log says the client configuration is invalid, check the exact
  `client.json path`, a final HTTP(S) origin, and valid pool characters.
- If the service redirects HTTP to HTTPS, replace `origin` with the final
  HTTPS address; redirects are intentionally not followed.
- An identity-stage 403 caused by changed identity fields means the original
  AIME/title server must be restored, or an administrator must reset the
  binding. Do not delete the key file as a retry.
- A missing or invalid `/api/v1/identity-mode` response stops matching rather
  than guessing the server's identity policy.
- The MelonLoader variant writes redacted failures to the MelonLoader log; the
  BepInEx variant writes them to the BepInEx log. Identity values, tickets, and
  server response bodies are not logged.

The standalone client has offline compilation and protocol checks. A real
two-client, cross-network gameplay test is still required before claiming full
runtime compatibility.

## Board and administration

The public board is served at `/` and supports light/dark themes and Chinese,
English, and Japanese UI. It shows recruiting and playing rooms, player slots,
difficulty, live scores, recent matches, song covers, and song metadata.

The admin console is at `/admin`:

- Cloudflare uses Access.
- Self-hosted uses the password initialized by `ADMIN_INITIAL_PASSWORD`.
- Administrators can toggle identity verification, ban/unban players, inspect
  active matches, and force-close matches.

Reset a self-hosted admin password with:

```bash
docker compose exec -e ADMIN_NEW_PASSWORD='new-password' app npm run admin:reset-password
```

Password reset also invalidates existing admin sessions.

## Upgrade and backup

### Cloudflare

```bash
git pull
npm ci --legacy-peer-deps
npm run check
npm run deploy
```

Migrations are append-only; do not edit migrations that have already shipped.

### Self-hosted

```bash
git pull
docker compose build
docker compose up -d
```

Container startup applies migrations according to `DATABASE_BACKEND`. Rebuilding
the image does not remove data volumes.

For MariaDB:

```bash
docker compose exec db sh -c 'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' > backup.sql
cat backup.sql | docker compose exec -T db sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
```

For SQLite, back up the database file under `sqlite_data`. Redis contains
rebuildable realtime state and is not a persistent backup source.

## Local development

```bash
npm ci --legacy-peer-deps

npm run dev                  # Cloudflare Worker
npm run dev:web              # Vue frontend, API proxy to 8787
npm run dev:selfhost         # self-hosted Node runtime

npm run check                # type checks, tests, frontend checks, name scan
npm run build:web            # rebuild board, admin, and login assets
```

To test MySQL/Redis combinations:

```bash
npm run test:selfhost:deps
npm run test:selfhost
npm run test:selfhost:deps:down
```

Important directories:

| Directory | Contents |
| --- | --- |
| `src/core` | Platform-independent protocol, matching, room, and admin logic |
| `src/adapters` | D1, MySQL, SQLite, Durable Objects, Redis, and memory adapters |
| `src/runtimes` | Cloudflare Worker and self-hosted Node entry points |
| `frontend` | Vue 3 board, admin, and login sources |
| `web` | Generated deployment assets from `npm run build:web` |
| `mod` | MelonLoader 0.7.1 / BepInEx 1–5 client |
| `tests/contract` | Shared protocol contract tests |

## API and protocol overview

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Health check |
| `GET /api/v1/rooms` | Room directory |
| `GET /api/v1/history` | Match history |
| `GET /api/v1/songs` | Board song metadata |
| `GET /api/v1/live?pool=...` | Read-only room/history WebSocket |
| `WS /api/v1/rooms/{roomId}/live` | Read-only live scores for one room |
| `POST /api/v1/match` | Create/join; request must include the current `protocolVersion` |
| `WS(S) /room`, `/room/{pool}` | Game control frames and binary relay |
| `/admin` | Admin console and admin API |

A match uses `protocolVersion: 1`. The service rejects a missing or unsupported
protocol version before creating a room or issuing a WebSocket ticket;
`gameVersion` describes game data and does not isolate rooms.

1. The client calls Match and receives `roomId`, `peerId`, a short-lived
   one-time `ticket`, and `wsPath`.
2. It connects to the room WebSocket with the ticket and receives `snapshot`.
3. Ready reports the final song, difficulty, and locally available official
   chart hashes.
4. Clients compare hashes among connected Ready players with the same
   `(songId, selectedDifficulty)`; a conflict blocks the host.
5. During play, clients send scores; `endPlay` freezes the final score into
   history.

Binary relay frames accept only Party/Advertise ports 50000 and 50002. Setting
50001 and DeliveryChecker 50003 remain local.

## Privacy and security boundaries

- Public HTTP/WS responses do not return chart hashes, raw game identity values,
  or complete title-server addresses.
- When identity verification is enabled, the service stores keyed identity
  digests and the client stores its installation key locally.
- When identity verification is disabled, `anonymousKey` identifies one
  installation. Replacing it can evade an anonymous ban; it is not a strong
  account identity.
- Room tickets are short-lived and room-scoped; the service also rate-limits
  clients.
- The admin surface has no unauthenticated fallback.
- Chart equality is decided by the clients in a room; the server validates the
  report shape and relays the state.

## Verification status

- Production instance: `https://collab.anontokyo.jp`
- Cloudflare integration tests and self-hosted MySQL/SQLite × Redis/memory
  contract tests are covered by `npm run check`.
- The standalone client has offline build and protocol checks; real two-client
  cross-network gameplay remains a separate hardware/runtime validation step.

Production smoke test:

```bash
node scripts/smoke-production.mjs
```

When identity verification is enabled, smoke cleanup needs
`ADMIN_RESET_SECRET`. On Windows:

```powershell
./scripts/provision-secrets.ps1 -Smoke
```
