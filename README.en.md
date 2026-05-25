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

For an HTTPS deployment, prefer serving WS Lab, WebSocket, and Dev REST through the same gateway. This avoids most CORS and mixed-content issues.

Public GitHub Pages URL:

```text
https://zsts119.github.io/patchx-ws-lab/
```

GitHub Pages is served over HTTPS. On first visit, WS Lab selects `小精灵生产环境` by default. If you need to test local `ws://` / `http://` services, run WS Lab locally at `http://127.0.0.1:5177/`.

## Target Environments

The top environment selector stores WebSocket and REST URLs as a pair. The default local values are:

- WebSocket: `ws://localhost:8460`
- Dev REST: `http://localhost:8410/api/v1/dev/ws-lab`

A `127.0.0.1` preset is also built in for local services that behave differently between localhost and loopback.

Built-in remote environments:

| Environment | WebSocket | Dev REST |
|-------------|-----------|----------|
| 小精灵生产环境 | `wss://ai-chat.patch-x.cn:8460` | `https://ai-chat.patch-x.cn:8460/api/v1/dev/ws-lab` |
| 小精灵测试环境 | `wss://121.43.112.101:19988` | `https://121.43.112.101:19988/api/v1/dev/ws-lab` |
| 小精灵日语环境 | `wss://121.43.112.101:19987` | `https://121.43.112.101:19987/api/v1/dev/ws-lab` |
| 小精灵英语环境 | `wss://199.223.236.153:19988` | `https://199.223.236.153:19988/api/v1/dev/ws-lab` |

You can also pass them through URL parameters:

```text
https://ws-lab.internal.example.com/?ws=wss%3A%2F%2Fai.example.com%2Fws&rest=https%3A%2F%2Fai.example.com%2Fapi%2Fv1%2Fdev%2Fws-lab&role=01
```

When the WS Lab page is served over HTTPS, browsers require secure targets:

- `wss://` for WebSocket
- `https://` for REST

If Dev REST is cross-origin, the target server must allow CORS. The recommended internal deployment is a same-origin reverse proxy.

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

1. Select or create an environment.
2. Select role `01` to `06`; open the client drawer if you need a random user or advanced Hello settings.
3. Click `连接` to open WebSocket and send Hello.
4. Type text in the bottom composer. Enter sends; Shift+Enter inserts a newline.
5. Open `音频` for duplex microphone, generated speech streaming, WAV streaming, and silence diagnostics.
6. Open `协议` for built-in or custom protocol templates.
7. Open `诊断` for overview, rounds, logs, and scenarios. If the environment is protocol-only, WS Lab explains which evidence is unavailable.

## AI Automation

Stable URL parameters:

- `ws`: WebSocket URL
- `rest`: Dev REST base URL
- `role`: `01` through `06`
- `autoConnect=1`: connect and send Hello after page load
- `scenario`: scenario ID
- `autorun=1`: run the selected scenario after page load

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
