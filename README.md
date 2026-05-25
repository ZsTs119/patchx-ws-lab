# PatchX WS Lab

[English](./README.en.md) | 简体中文

PatchX WS Lab 是 PatchX AI Server 的对话优先 WebSocket 测试台。它可以作为主仓库里的 `dev/ws-lab` 开发工具使用，也可以单独打包成静态站点部署到公司内网，让团队成员通过浏览器测试不同环境的 WS 协议、文本、音频、诊断和 AI 自动化场景。

## 定位

WS Lab 是一个纯静态前端包，不需要前端构建链。部署时只需要保留这些文件：

- 必需：`index.html`、`src/`、`styles/`、`modules/`、`vendor/`、`README.md`、`README.en.md`
- 可选：`open-ws-lab.cmd`、`open-ws-lab.ps1`，仅用于 Windows 本地快速打开
- 不需要：Go 服务端源码、主仓库其他文档、构建工具、日志文件、配置密钥

默认界面是纯净对话模式：顶部展示环境、身份摘要、音频摘要、诊断能力和连接按钮；中间展示客户端输入和服务端回复；客户端配置、协议工作台和诊断控制台都从二级抽屉或弹窗进入。

## 快速开始

在主仓库内本地使用时，先启动 PatchX AI Server：

```bash
make run
```

Windows 推荐直接双击：

```text
dev/ws-lab/open-ws-lab.cmd
```

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

公开 GitHub Pages 地址：

```text
https://zsts119.github.io/patchx-ws-lab/
```

GitHub Pages 是 HTTPS 页面，首次打开默认选择 `小精灵生产环境`。如果要连接本地 `ws://` / `http://` 服务，请改用本地静态服务 `http://127.0.0.1:5177/`。

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

1. 选择或新增环境。
2. 选择角色 `01` 到 `06`，必要时打开“客户端”抽屉生成随机用户。
3. 点击顶部“连接”，页面会建立 WebSocket 并发送当前 Hello。
4. 在底部输入文本，按 Enter 发送；Shift+Enter 换行。
5. 点击“音频”打开音频源面板，可使用全双工麦克风、生成语音推流、WAV 文件推流和静音诊断流。
6. 点击“协议”打开协议工作台，可发送内置协议模板或保存自定义模板。
7. 点击“诊断”查看总览、轮次、日志和场景；如果当前环境只支持协议模式，页面会说明不可用原因。

## AI 自动化

URL 参数：

- `ws`: WebSocket URL
- `rest`: Dev REST base URL
- `role`: `01` 到 `06`
- `autoConnect=1`: 页面加载后自动连接并发送 Hello
- `scenario`: 场景 ID
- `autorun=1`: 页面加载后自动运行场景

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
