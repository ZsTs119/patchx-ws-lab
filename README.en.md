# PatchX WS Lab

[简体中文](./README.md) | English

PatchX WS Lab is a conversation-first WebSocket testing console for PatchX AI Server. It works inside this repository under `dev/ws-lab`, and it can also be packaged as a standalone static site for internal company access.

## Purpose

WS Lab is a static frontend package. It does not require a frontend build step.

Required files:

- `index.html`
- `src/`
- `styles/`
- `modules/`
- `vendor/`
- `README.md`
- `README.en.md`

Optional local helper files:

- `open-ws-lab.cmd`
- `open-ws-lab.ps1`

Do not package server source code, logs, secrets, or the rest of the repository unless your deployment process explicitly needs them.

## Run Locally

Start PatchX AI Server first:

```bash
make run
```

On Windows, double-click:

```text
dev/ws-lab/open-ws-lab.cmd
```

This launcher starts both the local static server on `5177` and the local auth service on `8787`. If `server/users.json` does not exist, it copies `server/users.example.json` first.

Manual static server:

```bash
cd dev/ws-lab
python -m http.server 5177 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:5177/
```

Do not open `index.html` through `file://`. Browsers block ES modules in that mode, so roles, templates, scenarios, and modules cannot initialize.

## Static Deployment

WS Lab can be served by any static hosting service:

- Nginx / Caddy / Apache
- internal static file service
- object storage static website hosting
- any server that can return HTML, CSS, JS, and JSON files

Minimal packaging example:

```bash
mkdir -p /srv/ws-lab
cp -R index.html src styles modules vendor README.md README.en.md /srv/ws-lab/
```

Nginx example:

```nginx
server {
    listen 80;
    server_name ws-lab.internal.example.com;

    root /srv/ws-lab;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

For an HTTPS deployment, prefer serving WS Lab, WebSocket, Dev REST, and WS Lab auth through the same gateway. This avoids most CORS and mixed-content issues.

## Login Entry

Shared or public deployments should enable the independent WS Lab login service. It only protects the test bench experience; it is not part of the production AI Server user system, and credentials are not stored in the frontend.

Auth endpoints are served by the lightweight Node sidecar bundled in this directory:

- `POST /api/ws-lab-auth/login`
- `GET /api/ws-lab-auth/me`
- `POST /api/ws-lab-auth/logout`

The server sets an `HttpOnly + SameSite=Lax` cookie. The cookie is marked `Secure` on HTTPS requests and expires after 7 days by default.

The sidecar has no npm dependencies. It reads accounts from a JSON file and stores only `scrypt` password hashes. Generate password hashes with:

```bash
cd /srv/patchx-ws-lab
node server/hash-password.js --random PXLab@Ext-En
node server/hash-password.js --random PXLab@Ext-Ja
node server/hash-password.js --random PXLab@Internal
```

Copy the example file and paste the generated `password_hash` values into `server/users.json`:

```bash
cp server/users.example.json server/users.json
```

Example `server/users.json`. Do not commit plaintext passwords or real hashes to the repository. The `password` field is only for local maintainers to read; login verification uses `password_hash`:

```json
[
  {
    "username": "px_ext_en",
    "password": "replace_with_local_plaintext_password",
    "password_hash": "scrypt$32768$8$1$replace_with_generated_salt$replace_with_generated_hash",
    "display_name": "English External Tester",
    "audience": "external",
    "locale": "en",
    "endpoint_id": "sprite-en"
  },
  {
    "username": "px_ext_ja",
    "password": "replace_with_local_plaintext_password",
    "password_hash": "scrypt$32768$8$1$replace_with_generated_salt$replace_with_generated_hash",
    "display_name": "Japanese External Tester",
    "audience": "external",
    "locale": "ja",
    "endpoint_id": "sprite-ja"
  },
  {
    "username": "zhangsan",
    "password": "replace_with_local_plaintext_password",
    "password_hash": "scrypt$32768$8$1$replace_with_generated_salt$replace_with_generated_hash",
    "display_name": "Zhang San",
    "audience": "internal"
  }
]
```

Start the sidecar:

For local development, when you only want to open the login page, use the dev launcher without setting a session secret manually:

```bash
cd dev/ws-lab
cp server/users.example.json server/users.json
node server/start-local-auth.js
```

For production or shared deployments, set an explicit random secret:

```bash
export WS_LAB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)"
export WS_LAB_AUTH_USERS_FILE="/srv/patchx-ws-lab/server/users.json"
node server/ws-lab-auth-server.js
```

After pulling updates on a server, you can install or restart the sidecar with
the bundled script:

```bash
cd /srv/patchx-ws-lab
git pull --ff-only
sudo bash server/deploy-sidecar.sh
```

The script creates `/etc/patchx-ws-lab-auth.env`, installs/restarts
`patchx-ws-lab-auth.service`, and checks local `/api/ws-lab-auth/health`.

It listens on `127.0.0.1:8787` by default. In production, run it under systemd and proxy the same-origin `/api/ws-lab-auth/*` path to it through Caddy or Nginx.

Account conventions:

- External English tester: `px_ext_en`, locked to the English Sprite environment and auto-connects after login.
- External Japanese tester: `px_ext_ja`, locked to the Japanese Sprite environment and auto-connects after login.
- Internal users: use employee pinyin or company account prefix, for example `zhangsan`. Internal users enter the clean conversation page first and can open the full debug console through `调试台`.

When running locally on `127.0.0.1` / `localhost`, WS Lab requests `http://127.0.0.1:8787/api/ws-lab-auth` by default. If the sidecar is running, the login page is shown; if it is not running, WS Lab automatically enters local internal mode for lightweight development.

Current team entry:

```text
https://ws-lab.patch-x.cn/
```

This entry should serve static files, `/api/ws-lab-auth/*` login endpoints, and `/env/<env>/...` environment proxies from the same origin.

GitHub Pages static preview URL:

```text
https://zsts119.github.io/patchx-ws-lab/
```

GitHub Pages is a static HTTPS preview. It does not provide the same-origin login API or environment proxy. For team testing, use `https://ws-lab.patch-x.cn/`; if you need to test local `ws://` / `http://` services, run WS Lab locally at `http://127.0.0.1:5177/`.

## Target Environments

The top environment selector stores WebSocket and REST URLs as a pair. The default local values are:

- WebSocket: `ws://localhost:8460`
- Dev REST: `http://localhost:8410/api/v1/dev/ws-lab`

A `127.0.0.1` preset is also built in for local services that behave differently between localhost and loopback.

Built-in remote environments:

| Environment | WebSocket | Dev REST |
|-------------|-----------|----------|
| 小精灵生产环境 | `wss://ws-lab.patch-x.cn/env/prod/ws` | `https://ws-lab.patch-x.cn/env/prod/api/v1/dev/ws-lab` |
| 小精灵测试环境 | `wss://ws-lab.patch-x.cn/env/test/ws` | `https://ws-lab.patch-x.cn/env/test/api/v1/dev/ws-lab` |
| 小精灵日语环境 | `wss://ws-lab.patch-x.cn/env/ja/ws` | `https://ws-lab.patch-x.cn/env/ja/api/v1/dev/ws-lab` |
| 小精灵英语环境 | `wss://ws-lab.patch-x.cn/env/en/ws` | `https://ws-lab.patch-x.cn/env/en/api/v1/dev/ws-lab` |

You can also pass them through URL parameters:

```text
https://ws-lab.internal.example.com/?ws=wss%3A%2F%2Fai.example.com%2Fws&rest=https%3A%2F%2Fai.example.com%2Fapi%2Fv1%2Fdev%2Fws-lab&role=01
```

When the WS Lab page is served over HTTPS, browsers require secure targets:

- `wss://` for WebSocket
- `https://` for REST

If Dev REST is cross-origin, the target server must allow CORS. The recommended internal deployment is a same-origin reverse proxy.

The built-in remote Sprite environments use the HTTPS/WSS reverse proxy at `ws-lab.patch-x.cn` by default. Backend services may still expose plain `ws://` / `http://`; the proxy terminates TLS for browsers. If the proxy is unavailable, create a custom environment in Endpoint Manager as a temporary override.

Recommended backend mapping for `ws-lab.patch-x.cn`: Caddy owns the public HTTPS/WSS entrypoint and TLS termination, while the upstream targets use the direct service addresses.

| Environment | WS upstream | Dev REST upstream |
|-------------|-------------|-------------------|
| 小精灵生产环境 | `14.103.229.80:8460` | `14.103.229.80:8410` |
| 小精灵测试环境 | `14.103.222.77:7003` | `14.103.222.77:7103` |
| 小精灵日语环境 | `199.223.236.153:7002` | `199.223.236.153:7102` |
| 小精灵英语环境 | `199.223.236.153:7001` | `199.223.236.153:7101` |

When WS Lab opens a WebSocket, it automatically appends the current identity to the handshake URL:

```text
?device_id=<current device id>&user_id=<current user id>
```

If the configured WebSocket URL already has query parameters, WS Lab preserves them and only overwrites `device_id` and `user_id`. The expanded URL is not written back to the input field, so the visible address does not keep growing after repeated connections.

## Same-Origin Reverse Proxy

Recommended internal topology:

```text
Browser
  -> https://ws-lab.internal.example.com/                  static WS Lab
  -> https://ws-lab.internal.example.com/patchx-ws         proxy to AI Server WebSocket
  -> https://ws-lab.internal.example.com/api/v1/dev/ws-lab proxy to AI Server Dev REST
```

WebSocket proxy example:

```nginx
location /patchx-ws {
    proxy_pass http://ai-server:8460;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}

location /api/v1/dev/ws-lab {
    proxy_pass http://ai-server:8410/api/v1/dev/ws-lab;
    proxy_set_header Host $host;
}

location /api/ws-lab-auth {
    proxy_pass http://127.0.0.1:8787/api/ws-lab-auth;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Adjust paths and rewrites to match the actual WebSocket route exposed by your AI Server.

## Capability Fallback

The WebSocket main flow does not depend on Dev REST. Dev REST only powers diagnostics, logs, rounds, TTS generation, and scenario evidence.

WS Lab automatically classifies the selected environment:

- `full`: WebSocket, Dev REST, logs, rounds, TTS, and scenario evidence are available.
- `partial`: WebSocket and Dev REST are available, but some diagnostic capabilities are missing.
- `protocol-only`: Dev REST is missing or forbidden. WebSocket, Hello, text, audio, and protocol testing still work.
- `checking`: capability probing is in progress.

If `/api/v1/dev/ws-lab` is not deployed, diagnosis, logs, rounds, and scenario evidence are disabled or degraded with an explicit reason. The WebSocket protocol flow remains available.

## Main Workflow

1. Log in. External testers use the language-specific account; internal users use employee accounts.
2. Internal users may select or create an environment. External users are locked to the account-bound environment.
3. Internal users may choose role `01` to `06`; open `调试台` and the client drawer for random users or advanced Hello settings.
4. Click `连接` to open WebSocket and send Hello. External English/Japanese accounts auto-connect after login.
5. Type text in the bottom composer. Enter sends; Shift+Enter inserts a newline.
6. Click `全双工` for microphone input. Internal debug mode can also open advanced audio sources for generated speech streaming, WAV streaming, and silence diagnostics.
7. Internal debug mode can open `协议` for templates and `诊断` for overview, rounds, logs, and scenarios.

## AI Automation

Stable URL parameters:

- `ws`: WebSocket URL
- `rest`: Dev REST base URL
- `role`: `01` through `06`
- `autoConnect=1`: connect and send Hello after page load
- `scenario`: scenario ID
- `autorun=1`: run the selected scenario after page load
- `auth` / `authBase`: optional auth service override, for example `http://127.0.0.1:8787/api/ws-lab-auth`

If login is enabled, URL automation runs after a valid login. External tester accounts ignore scenario automation and keep the locked clean conversation flow; internal users keep the full automation surface.

Machine-readable status:

- `window.__WS_LAB_CAPABILITIES__`
- `document.documentElement.dataset.environmentCapability`
- `document.documentElement.dataset.scenarioStatus`

Scenario report states:

- `pass`: function and evidence passed.
- `fail`: functional assertion failed.
- `blocked`: required environment capability is unavailable.
- `degraded`: WebSocket flow passed, but logs or round evidence is missing.

Autorun example:

```text
https://ws-lab.internal.example.com/?ws=wss%3A%2F%2Fai.example.com%2Fws&rest=https%3A%2F%2Fai.example.com%2Fapi%2Fv1%2Fdev%2Fws-lab&role=02&autoConnect=1&scenario=role-text-smoke&autorun=1
```

## Module Authoring

Add modules under `modules/` and register them in `modules/registry.json`. JSON modules can declare actions and scenarios without touching core JavaScript.

```json
{
  "id": "my-feature",
  "name": "My Feature",
  "area": "Custom",
  "actions": [
    { "id": "my.action", "label": "My Action", "payload": { "type": "active_greet" } }
  ],
  "scenarios": [
    {
      "id": "my.scenario",
      "label": "My Scenario",
      "steps": [
        { "action": "send_json", "payload": { "type": "active_greet" } },
        { "action": "expect_binary", "timeout_ms": 12000 }
      ]
    }
  ]
}
```

JavaScript modules may export a registration function:

```js
export default function register(host) {
  host.registerAction({ id: "custom.ping", label: "Ping", payload: { type: "ping" } });
  host.registerScenario({
    id: "custom.no-goodbye",
    label: "No Goodbye",
    steps: [
      { action: "expect_no_ws", type: "goodbye", timeout_ms: 1000 }
    ]
  });
}
```

Supported scenario steps:

- `send_json`
- `send_text`
- `wait_ws`
- `expect_no_ws`
- `expect_binary`
- `set_audio_profile`
- `stream_silence`
- `log_summary`

## FAQ

**Why is the page blank or incomplete when opening `index.html` directly?**
Use a static server. Do not use `file://`; browsers block ES modules in that mode.

**Why can I connect, but diagnosis is unavailable?**
The target environment exposes WebSocket but does not expose Dev REST. Protocol testing still works; diagnostic evidence is degraded or disabled.

**Why does an HTTPS page fail to connect to `ws://` or `http://` targets?**
Browsers block mixed content. Use `wss://` and `https://`, or place everything behind a same-origin gateway.

**Why does cross-origin Dev REST fail?**
Enable CORS on the target AI Server, or proxy Dev REST through the same origin as WS Lab.

**Does full diagnosis require server-side Dev REST support?**
Yes. Without `/api/v1/dev/ws-lab`, WS Lab automatically falls back to partial or protocol-only mode.

**Why does the hosted page say the login service is unavailable?**
Make sure `server/ws-lab-auth-server.js` is running, and make sure the gateway proxies `/api/ws-lab-auth/*` to `127.0.0.1:8787`.
