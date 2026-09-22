# OngekiCollab

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ProjectCRYCHIC/OngekiCollabOSS)

OngekiCollab is a standalone online relay for ONGEKI. Players keep using the game's native Recruit, difficulty selection, Ready, Start, and Cancel controls. The service provides room discovery, WebSocket relay, a live spectator board, and administration.

This repository does not contain the game or its assets.

## Features

- Public and custom matching pools.
- Native multiplayer controls without an additional room UI.
- Client-side comparison of official chart hashes for the selected difficulty; a mismatch blocks the start.
- Live recruiting rooms, scores, and recent match history.
- Identity verification controls, player bans, and active match management.
- Cloudflare Native and Docker self-hosted deployments using the same client and protocol.

The public pool does not automatically place players in one room. Creating a room and joining one are separate actions; joining another room sends its directory `roomId`.

## Choose a deployment

| Option | Best for | Data and live state | Administrator login |
| --- | --- | --- | --- |
| Self-hosted | Full control of the server and data | MySQL/MariaDB or SQLite; Redis or single-process memory | Password |
| Cloudflare Native | Less server maintenance | D1 + Durable Objects | Cloudflare Access |

In either case, the game client needs only one service origin.

## Cloudflare Native

One-click deployment requires a Cloudflare account; a custom domain is optional. Manual deployment also requires Node.js 22.

### One-click deployment

Click **Deploy to Cloudflare** at the top of this page. The wizard copies the public repository and uses `wrangler.jsonc` to:

- Create and bind a D1 database.
- Create four Durable Objects.
- Request four independent secrets.
- Apply D1 migrations, build the frontend, and deploy to `*.workers.dev`.

Generate each secret separately with `openssl rand -base64 32`; do not reuse them. The generic template does not include a custom domain. After deployment, add one under the Worker's **Settings → Domains & Routes** if needed. Configure Cloudflare Access below before using the admin console.

### Manual deployment

```bash
npm ci --legacy-peer-deps
npx wrangler login
npx wrangler d1 create ongeki-collab
```

Copy the resulting `database_id` into `wrangler.jsonc` and change the Worker name if needed. Then set the secrets and deploy:

```bash
npx wrangler secret put IDENTITY_HASH_SECRET
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler secret put TICKET_SIGNING_SECRET
npx wrangler secret put ADMIN_RESET_SECRET
npm run deploy
```

`npm run deploy` rebuilds `web/`, applies remote D1 migrations, and deploys the Worker and static assets. It initially provides a `*.workers.dev` address; you can add a custom domain afterward.

The service requires three independent 32-byte Base64 secrets:

- `IDENTITY_HASH_SECRET`
- `KEY_ENCRYPTION_SECRET`
- `TICKET_SIGNING_SECRET`

For production, also configure `ADMIN_RESET_SECRET` for the administrator reset endpoint and production smoke-test cleanup when identity verification is enabled.

On Windows, the repository script can generate the secrets, create an encrypted backup for the current user, and upload them:

```powershell
./scripts/provision-secrets.ps1 -Upload
```

The backup is stored at `%LOCALAPPDATA%\OngekiCollab\secrets.dpapi`. Back it up together with the corresponding Windows user environment. On other systems, set each secret with `npx wrangler secret put <NAME>`.

Check the service after deployment:

```bash
curl https://collab.example.com/api/v1/health
```

### Protect the admin console

Create a **Self-hosted** Access application in Cloudflare Zero Trust:

1. Set its application path to `your-domain/admin*` only.
2. Allow only actual administrators.
3. Set the team issuer in `ACCESS_TEAM_DOMAIN`.
4. Set the application's AUD tag in `ACCESS_AUD`.

Do not protect the entire Worker with Access, because that would also block the game's WebSocket. If either Access setting is missing, `/admin` returns 403. The public board and game API do not gain admin access.

## Self-hosted

The default configuration starts the app, MariaDB, and Redis for ongoing use.

```bash
cp .env.example .env
# Edit .env: set at least the database password, three required secrets, and initial admin password.
docker compose up -d --build
```

Generate each required secret independently:

```bash
openssl rand -base64 32
```

After startup:

- Service origin: `http://<host>:8080`
- Public board: `http://<host>:8080/`
- Admin console: `http://<host>:8080/admin`

Sign in with `ADMIN_INITIAL_PASSWORD` from `.env` the first time. Once a password hash exists in the database, this variable does not overwrite it.

### Choose storage and realtime backends

| Setup | `COMPOSE_PROFILES` | `DATABASE_BACKEND` | `REALTIME_BACKEND` |
| --- | --- | --- | --- |
| Default complete stack | `bundled` | `mysql` | `redis` |
| Small single-server setup | Empty | `sqlite` | `memory` |
| External MySQL + Redis | Empty | `mysql` | `redis` |
| Bundled MariaDB, no Redis | `mariadb` | `mysql` | `memory` |
| SQLite + bundled Redis | `redis` | `sqlite` | `redis` |

For external MySQL or Redis, also set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `REDIS_URL` as applicable.

The `memory` backend is for a single app process; it cannot share locks or broadcasts across replicas. SQLite is also designed for one app instance. Do not share one SQLite file between containers over a network filesystem.

### Reverse proxy

Use HTTPS/WSS for public access. A minimal Caddy configuration is:

```caddy
collab.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

If the reverse proxy terminates TLS, set `TRUST_PROXY=1` in `.env`. With Nginx, forward WebSocket Upgrade headers for `/room`, `/api/v1/live`, and `/api/v1/rooms/*/live`.

If the proxy and app run on the same machine, you can set `APP_BIND=127.0.0.1` so the app port does not listen on every interface.

The standalone mod uses Windows WinHTTP/Schannel for relay HTTP, WebSocket, and TLS. Public endpoints must support TLS 1.2 or newer; ECDSA certificates work without an additional RSA certificate chain. Do not use HTTP fallback or disable certificate verification to work around transport failures.

## Connect a client

The standalone client is in `mod/`; see [`mod/README.md`](mod/README.md) for build instructions and runtime requirements. In short:

1. Install one client variant. For MelonLoader, run `mod/build.ps1` and put the self-contained `OngekiCollab.Mod.dll` in `Mods`. For BepInEx 1–5, run `mod/build-all-bepinex.ps1` and install only the `OngekiCollab.BepInEx<major>.dll` matching your loader version. Each DLL embeds the required JSON dependency; do not copy another copy or load multiple variants together.
2. After the first launch, edit `client.json` beside `mu3.exe`. For example, with `F:\package\mu3.exe`, edit `F:\package\client.json`. It is not in `UserData`, a STARTLINER profile, or `BepInEx\plugins`. The startup log prints its resolved absolute path as `client.json path: ...`.
3. Change the relay settings and preserve generated identity and key fields:

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

4. `origin` must be the final root HTTP(S) service address, such as `https://collab.example.com` (an ending `/` is allowed). It cannot contain a path, user info, query, fragment, or Markdown wrapper. The client does not follow HTTP-to-HTTPS redirects. An empty `pool` selects the public pool; a named pool accepts 1–64 letters, digits, `_`, or `-`. Do not manually replace `identityId`, `clientKey`, or `anonymousKey`.
5. Restart the game.

`onlineMode: false` keeps native LAN play. Use HTTPS for public relays; HTTP is suitable only for trusted local self-hosted environments.

Online mode uses the game's native controls:

- The first press of Recruit creates a room.
- The Recruit list shows rooms for locally available songs in the current pool.
- Players can still change difficulty and Ready through the native interface.
- The host can start only when all connected players are Ready, their chart hashes agree, and native Party is ready.

## Board and admin console

The public board at `/` supports light and dark themes and Chinese, English, and Japanese. It shows:

- Recruiting and playing rooms.
- Player slots, difficulty, and live scores.
- Matches from the last 72 hours.
- Song covers and metadata.

The admin console at `/admin` can:

- Enable or disable player identity verification.
- Find, ban, and unban players.
- Inspect active matches and close them.

Cloudflare uses Access authentication; self-hosted deployments use a password. Reset a self-hosted admin password with:

```bash
docker compose exec -e ADMIN_NEW_PASSWORD='your-new-password' app npm run admin:reset-password
```

Resetting the password also invalidates existing admin sessions.

## Upgrades and backups

### Cloudflare

```bash
git pull
npm ci --legacy-peer-deps
npm run check
npm run deploy
```

D1 migrations are append-only; do not edit migrations that have already been deployed.

### Self-hosted

```bash
git pull
docker compose build
docker compose up -d
```

The container runs migrations for `DATABASE_BACKEND` at startup. Rebuilding the image does not remove data volumes.

MariaDB backup and restore example:

```bash
docker compose exec db sh -c 'mariadb-dump -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' > backup.sql
cat backup.sql | docker compose exec -T db sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
```

For SQLite, back up the database file in `sqlite_data`. Redis stores rebuildable realtime state and is not a durable backup source.

## Local development

```bash
npm ci --legacy-peer-deps

npm run dev                  # Run the Cloudflare Worker locally.
npm run dev:web              # Hot-reload the Vue frontend; proxy API requests to port 8787.
npm run dev:selfhost         # Run the self-hosted Node runtime.

npm run check                # Type checking, tests, frontend checks, and prohibited-name scan.
npm run build:web            # Rebuild the public board, admin page, and login page.
```

To test the MySQL/Redis combination:

```bash
npm run test:selfhost:deps
npm run test:selfhost
npm run test:selfhost:deps:down
```

Main directories:

| Directory | Contents |
| --- | --- |
| `src/core` | Platform-independent protocol, matching, room, and admin logic |
| `src/adapters` | D1, MySQL, SQLite, Durable Objects, Redis, and memory adapters |
| `src/runtimes` | Cloudflare Worker and self-hosted Node entry points |
| `frontend` | Vue 3 board, admin, and login source |
| `web` | Deployment assets generated by `npm run build:web` |
| `mod` | MelonLoader 0.7.1 / BepInEx 1–5 clients with a shared multiplayer core |
| `tests/contract` | Protocol contract tests shared by both deployments |

## API and protocol overview

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Health check |
| `GET /api/v1/rooms` | Room directory |
| `GET /api/v1/history` | Match history |
| `GET /api/v1/songs` | Song metadata for the board |
| `GET /api/v1/live?pool=...` | Read-only room and history WebSocket |
| `WS /api/v1/rooms/{roomId}/live` | Read-only live scores for one room |
| `POST /api/v1/match` | Create or join a room; requires the current `protocolVersion` |
| `WS(S) /room`, `/room/{pool}` | Game control frames and binary relay |
| `/admin` | Admin console and API |

Every Match request includes `protocolVersion: 1`. The service rejects missing or unsupported versions before creating a room or issuing a WebSocket ticket. `gameVersion` describes the game data version and does not isolate rooms.

A typical online session:

1. The client calls Match and receives `roomId`, `peerId`, a short-lived one-use `ticket`, and `wsPath`.
2. The client connects to the room WebSocket with the ticket and receives a `snapshot`.
3. On Ready, it reports the final song and difficulty selection with hashes for all locally existing official charts.
4. Clients compare selected-difficulty hashes for every connected, Ready player on the same song and difficulty; a mismatch blocks the start.
5. During play, clients send scores. `endPlay` saves the last report to history.

The binary relay accepts only ports 50000 and 50002 for Party/Advertise. Setting port 50001 and DeliveryChecker port 50003 stay on their local paths.

## Privacy and security boundaries

- Public HTTP/WS responses do not expose chart hashes, raw game identity values, or full title server addresses.
- When identity verification is enabled, the service stores keyed digests of identity fields and an encrypted client key.
- When verification is disabled, a separate random `anonymousKey` identifies one installation. Replacing it may evade an anonymous ban, so it is not a strong account identity.
- Room tickets expire and are valid only for their room; the service also applies IP rate limits.
- The admin console has no unauthenticated fallback. Invalid Access, password, or session configuration denies access.
- Room clients decide chart consistency together; the service validates only the report format and forwards room state.

## Verification

- Production instance: `https://collab.anontokyo.jp`
- `npm run check` covers Cloudflare integration tests and contract tests for self-hosted MySQL/SQLite × Redis/memory configurations.
- The standalone client has passed offline builds and protocol tests. A real two-client cross-network gameplay test is still needed.

Production smoke test:

```bash
node scripts/smoke-production.mjs
```

When identity verification is enabled, smoke-test cleanup requires `ADMIN_RESET_SECRET`. On Windows, you can use:

```powershell
./scripts/provision-secrets.ps1 -Smoke
```
