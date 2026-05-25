export default function registerHeartbeatTools(host) {
  host.registerAction({
    id: "module.heartbeat.ping",
    label: "模块 · 心跳 Ping",
    area: "传输",
    payload: { type: "ping", source: "ws-lab-module" }
  });

  host.registerScenario({
    id: "module.expect-no-goodbye",
    label: "无异常断开",
    area: "传输",
    steps: [
      { action: "expect_no_ws", type: "goodbye", timeout_ms: 1500 }
    ]
  });

  host.emit({ message: "心跳工具已注册" });

  return {
    id: "heartbeat-tools",
    name: "心跳工具",
    area: "传输",
    version: "1.0.0",
    description: "用于传输链路检查的 JavaScript 模块示例。"
  };
}
