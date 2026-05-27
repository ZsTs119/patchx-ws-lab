# PatchX WS Lab

[English](./README.en.md) | 简体中文

PatchX WS Lab 是 PatchX AI Server 的对话优先 WebSocket 测试台。它可以作为主仓库里的 `dev/ws-lab` 开发工具使用，也可以单独打包成静态站点部署到公司内网，让团队成员通过浏览器测试不同环境的 WS 协议、文本、音频、诊断和 AI 自动化场景。

## 定位

WS Lab 是一个纯静态前端包，不需要前端构建链。部署时只需要保留这些文件：

- 必需：`index.html`、`src/`、`styles/`、`modules/`、`vendor/`、`README.md`、`README.en.md`
- 可选：`open-ws-lab.cmd`、`open-ws-lab.ps1`，仅用于 Windows 本地快速打开
- 不需要：Go 服务端源码、主仓库其他文档、构建工具、日志文件、配置密钥

默认界面是登录后的纯净对话模式：顶部展示环境、身份、声音状态和连接按钮；中间展示客户端输入和服务端回复。内部人员可以进入完整调试台；外部测试人员只看到绑定语言环境的极简对话页。

## 快速开始

在主仓库内本地使用时，先启动 PatchX AI Server：

```bash
make run
```

Windows 推荐直接双击：

```text
dev/ws-lab/open-ws-lab.cmd
```

该脚本会同时启动本地静态服务 `5177` 和本地登录服务 `8787`。如果 `server/users.json` 不存在，会先从 `server/users.example.json` 复制一份。

手动启动静态服务：

```bash
cd dev/ws-lab
python -m http.server 5177 --bind 127.0.0.1
```

浏览器打开：

```text
http://127.0.0.1:5177/
```

不要直接用 `file://` 打开 `index.html`。浏览器会拦截 ES Module，角色、模板、场景和模块无法初始化。

## 静态部署

WS Lab 可以部署到任意静态托管服务：

- Nginx / Caddy / Apache
- 内网静态文件服务
- 对象存储静态网站
- 任意能返回 HTML、CSS、JS、JSON 的 Web 服务

最小部署步骤：

```bash
mkdir -p /srv/ws-lab
cp -R index.html src styles modules vendor README.md README.en.md /srv/ws-lab/
```

Nginx 示例：

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

如果公司内网要求 HTTPS，推荐把 WS Lab 和目标 AI Server 通过同一个网关暴露，减少 CORS 和混合内容问题。

## 登录入口

公开或团队共享部署建议开启 WS Lab 独立登录服务。它只保护测试台体验，不接入 AI Server 正式用户体系，也不把账号密码写进前端。

登录接口由本目录自带的轻量 Node sidecar 提供：

- `POST /api/ws-lab-auth/login`
- `GET /api/ws-lab-auth/me`
- `POST /api/ws-lab-auth/logout`

服务端会设置 `HttpOnly + SameSite=Lax` cookie；HTTPS 访问时 cookie 自动带 `Secure`。默认有效期 7 天。

sidecar 不需要 npm 依赖，账号从 JSON 文件读取，密码只保存 `scrypt` hash。生成密码 hash：

```bash
cd /srv/patchx-ws-lab
node server/hash-password.js --random PXLab@Ext-En
node server/hash-password.js --random PXLab@Ext-Ja
node server/hash-password.js --random PXLab@Internal
```

把输出的 `password_hash` 填入 `server/users.json`，可以先从示例复制：

```bash
cp server/users.example.json server/users.json
```

`server/users.json` 示例，仓库里不要提交明文密码或真实 hash。`password` 字段只给本地维护者查看，登录校验使用 `password_hash`：

```json
[
  {
    "username": "px_ext_en",
    "password": "replace_with_local_plaintext_password",
    "password_hash": "scrypt$32768$8$1$replace_with_generated_salt$replace_with_generated_hash",
    "display_name": "英语外部测试",
    "audience": "external",
    "locale": "en",
    "endpoint_id": "sprite-en"
  },
  {
    "username": "px_ext_ja",
    "password": "replace_with_local_plaintext_password",
    "password_hash": "scrypt$32768$8$1$replace_with_generated_salt$replace_with_generated_hash",
    "display_name": "日语外部测试",
    "audience": "external",
    "locale": "ja",
    "endpoint_id": "sprite-ja"
  },
  {
    "username": "zhangsan",
    "password": "replace_with_local_plaintext_password",
    "password_hash": "scrypt$32768$8$1$replace_with_generated_salt$replace_with_generated_hash",
    "display_name": "张三",
    "audience": "internal"
  }
]
```

启动 sidecar：

本地只想打开登录页时，可以用开发启动脚本，不需要手动设置 session secret：

```bash
cd dev/ws-lab
cp server/users.example.json server/users.json
node server/start-local-auth.js
```

生产或共享部署要显式设置随机密钥：

```bash
export WS_LAB_AUTH_SESSION_SECRET="$(openssl rand -hex 32)"
export WS_LAB_AUTH_USERS_FILE="/srv/patchx-ws-lab/server/users.json"
node server/ws-lab-auth-server.js
```

服务器拉取更新后，也可以直接用仓库内脚本安装或重启 sidecar：

```bash
cd /srv/patchx-ws-lab
git pull --ff-only
sudo bash server/deploy-sidecar.sh
```

脚本会创建 `/etc/patchx-ws-lab-auth.env`、安装并重启 `patchx-ws-lab-auth.service`，并检查本机 `/api/ws-lab-auth/health`。

默认监听 `127.0.0.1:8787`，生产环境建议用 systemd 常驻，并由 Caddy/Nginx 反向代理到同域 `/api/ws-lab-auth/*`。

账号约定：

- 外部英语测试：`px_ext_en`，登录后锁定小精灵英语环境并自动连接。
- 外部日语测试：`px_ext_ja`，登录后锁定小精灵日语环境并自动连接。
- 内部人员：使用员工姓名拼音或公司账号前缀，例如 `zhangsan`；默认进入纯净对话页，可点击“调试台”进入完整测试台。

如果在本地 `127.0.0.1` / `localhost` 静态服务访问，WS Lab 默认请求 `http://127.0.0.1:8787/api/ws-lab-auth`。sidecar 运行时会显示登录页；sidecar 未运行时会自动进入本地内部模式，方便开发调试。

当前团队共享入口：

```text
https://ws-lab.patch-x.cn/
```

该入口应同时配置静态文件、`/api/ws-lab-auth/*` 登录接口和 `/env/<env>/...` 环境反代。

GitHub Pages 静态预览地址：

```text
https://zsts119.github.io/patchx-ws-lab/
```

GitHub Pages 是纯静态 HTTPS 页面，适合预览仓库文件，不承载同域登录接口和环境反代。团队测试请优先使用 `https://ws-lab.patch-x.cn/`；如果要连接本地 `ws://` / `http://` 服务，请改用本地静态服务 `http://127.0.0.1:5177/`。

## 访问不同环境

页面顶部的环境选择会成对管理 WS 和 REST 地址。本地访问时默认本机环境：

- WebSocket: `ws://localhost:8460`
- Dev REST: `http://localhost:8410/api/v1/dev/ws-lab`

内置环境里也保留了 `127.0.0.1` 选项，方便本机服务对 localhost 和 loopback 行为不一致时切换。

公开部署内置小精灵环境：

| 环境 | WebSocket | Dev REST |
|------|-----------|----------|
| 小精灵生产环境 | `wss://ws-lab.patch-x.cn/env/prod/ws` | `https://ws-lab.patch-x.cn/env/prod/api/v1/dev/ws-lab` |
| 小精灵测试环境 | `wss://ws-lab.patch-x.cn/env/test/ws` | `https://ws-lab.patch-x.cn/env/test/api/v1/dev/ws-lab` |
| 小精灵日语环境 | `wss://ws-lab.patch-x.cn/env/ja/ws` | `https://ws-lab.patch-x.cn/env/ja/api/v1/dev/ws-lab` |
| 小精灵英语环境 | `wss://ws-lab.patch-x.cn/env/en/ws` | `https://ws-lab.patch-x.cn/env/en/api/v1/dev/ws-lab` |

也可以通过 URL 参数直接指定：

```text
https://ws-lab.internal.example.com/?ws=wss%3A%2F%2Fai.example.com%2Fws&rest=https%3A%2F%2Fai.example.com%2Fapi%2Fv1%2Fdev%2Fws-lab&role=01
```

部署到 HTTPS 页面后，浏览器会阻止页面访问普通 `ws://` 或 `http://` 目标。此时需要使用：

- `wss://` WebSocket
- `https://` REST

如果 REST 诊断接口跨域，目标服务必须允许 CORS；更推荐用同域反向代理，把静态页、WS 和 REST 放在同一个域名下。

内置小精灵远端环境默认走 `ws-lab.patch-x.cn` 的 HTTPS/WSS 反向代理，后端服务仍可保持普通 `ws://` / `http://`。如果代理未部署或证书异常，可以在环境管理里新增自定义环境临时覆盖。

当前 `ws-lab.patch-x.cn` 推荐后端映射如下，Caddy 负责 HTTPS/WSS 入口和 TLS 终止，后端 upstream 使用服务直连地址：

| 环境 | WS upstream | Dev REST upstream |
|------|-------------|-------------------|
| 小精灵生产环境 | `14.103.229.80:8460` | `14.103.229.80:8410` |
| 小精灵测试环境 | `14.103.222.77:7003` | `14.103.222.77:7103` |
| 小精灵日语环境 | `199.223.236.153:7002` | `199.223.236.153:7102` |
| 小精灵英语环境 | `199.223.236.153:7001` | `199.223.236.153:7101` |

连接 WebSocket 时，WS Lab 会自动在握手 URL 上补齐当前身份：

```text
?device_id=<当前设备ID>&user_id=<当前用户ID>
```

如果原 WS URL 已经带有其他 query 参数，页面会保留它们，只覆盖 `device_id` 和 `user_id`。这些 query 不会回写到输入框，避免地址越连越长。

## 同域反向代理建议

公司共享部署推荐如下拓扑：

```text
浏览器
  -> https://ws-lab.internal.example.com/              静态 WS Lab
  -> https://ws-lab.internal.example.com/patchx-ws     反代到 AI Server WebSocket
  -> https://ws-lab.internal.example.com/api/v1/dev/ws-lab  反代到 AI Server Dev REST
```

Nginx WebSocket 反代需要保留升级头：

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

实际路径要按服务端 WS 路由调整。如果服务端只接受根路径连接，需要在网关里做对应 rewrite。

## 环境能力分层

WS 主流程不依赖 Dev REST。Dev REST 只提供诊断、日志、轮次、TTS 和场景证据增强能力。

WS Lab 会自动探测当前环境，并显示：

- `完整诊断`: WS、Dev REST、日志、轮次、TTS、场景证据可用。
- `部分诊断`: WS 和 Dev REST 可用，但日志、轮次、TTS 或证据能力部分缺失。
- `仅协议模式`: Dev REST 不可用或无权限，仍可连接 WS、发送 Hello、文本、音频和协议消息。
- `检查中`: 正在探测环境能力。

如果目标环境没有部署 `/api/v1/dev/ws-lab`，诊断、日志、轮次和场景证据会降级或禁用，但连接、Hello、文本、WAV、麦克风和协议调试仍然可用。

## 主流程使用

1. 登录：外部测试人员选择对应账号，内部人员使用员工账号。
2. 内部人员可选择或新增环境；外部测试人员环境由账号锁定。
3. 内部人员可选择角色 `01` 到 `06`，必要时进入“调试台”打开“客户端”抽屉生成随机用户。
4. 点击顶部“连接”，页面会建立 WebSocket 并发送当前 Hello；外部英语/日语账号会自动连接。
5. 在底部输入文本，按 Enter 发送；Shift+Enter 换行。
6. 点击“全双工”使用麦克风；内部调试台还可以打开音频源面板使用生成语音推流、WAV 文件推流和静音诊断流。
7. 内部调试台可打开“协议”发送模板消息，也可打开“诊断”查看总览、轮次、日志和场景。

## AI 自动化

URL 参数：

- `ws`: WebSocket URL
- `rest`: Dev REST base URL
- `role`: `01` 到 `06`
- `autoConnect=1`: 页面加载后自动连接并发送 Hello
- `scenario`: 场景 ID
- `autorun=1`: 页面加载后自动运行场景
- `auth` / `authBase`: 可选，覆盖登录服务地址，例如 `http://127.0.0.1:8787/api/ws-lab-auth`

如果部署启用了登录，URL 自动化会在登录完成后执行。外部测试账号会忽略场景自动化，只保留绑定环境的纯净对话主流程；内部人员仍可使用完整自动化。

机器可读状态：

- `window.__WS_LAB_CAPABILITIES__`
- `document.documentElement.dataset.environmentCapability`
- `document.documentElement.dataset.scenarioStatus`

场景报告状态：

- `pass`: 功能和证据都通过。
- `fail`: 功能断言失败。
- `blocked`: 环境缺少必需能力，测试无法执行。
- `degraded`: WS 主流程通过，但缺少日志或轮次证据。

自动运行示例：

```text
https://ws-lab.internal.example.com/?ws=wss%3A%2F%2Fai.example.com%2Fws&rest=https%3A%2F%2Fai.example.com%2Fapi%2Fv1%2Fdev%2Fws-lab&role=02&autoConnect=1&scenario=role-text-smoke&autorun=1
```

## 模块和场景扩展

新增模块放在 `modules/` 下，并在 `modules/registry.json` 注册。JSON 模块可以声明动作和场景，不需要修改核心 JS。

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

JavaScript 模块可以导出注册函数：

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

当前支持的场景步骤：

- `send_json`
- `send_text`
- `wait_ws`
- `expect_no_ws`
- `expect_binary`
- `set_audio_profile`
- `stream_silence`
- `log_summary`

## 常见问题

**为什么打开 `index.html` 是空白或功能缺失？**
不要用 `file://` 打开。请用静态服务访问，例如 `http://127.0.0.1:5177/`。

**为什么诊断不可用，但连接能成功？**
目标环境只提供 WS，未部署或未开放 Dev REST。WS 主流程可继续使用，日志、轮次和场景证据会进入降级状态。

**为什么 HTTPS 页面访问本地 `ws://` 或 `http://` 失败？**
浏览器阻止混合内容。HTTPS 页面必须访问 `wss://` 和 `https://`，或通过同域反向代理转发。

**为什么跨域 REST 失败？**
目标 AI Server 需要允许 CORS，或把 REST 通过同域网关反代到 WS Lab 域名下。

**完整诊断是否要求服务端合入 Dev REST 代码？**
是。没有 `/api/v1/dev/ws-lab` 时，WS Lab 会自动进入仅协议或部分诊断模式，不影响 WS 协议测试。

**为什么线上页面显示登录服务不可用？**
确认 `server/ws-lab-auth-server.js` sidecar 正在运行，并且网关把 `/api/ws-lab-auth/*` 反向代理到 `127.0.0.1:8787`。
