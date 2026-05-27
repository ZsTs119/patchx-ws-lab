export class WsClient {
  constructor(store) {
    this.store = store;
    this.socket = null;
    this.sessionId = "";
    this.onStateChange = () => {};
    this.onSession = () => {};
  }

  get readyState() {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  get isConnected() {
    return this.readyState === WebSocket.OPEN;
  }

  async connect(baseUrl, identity = {}) {
    if (this.socket && this.readyState !== WebSocket.CLOSED) {
      this.disconnect();
    }

    const url = buildConnectionUrl(baseUrl, identity);
    this.onStateChange("connecting");

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url.toString());
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      const timeout = window.setTimeout(() => {
        reject(new Error("WebSocket 连接超时"));
        socket.close();
      }, 8000);

      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.store.add({ direction: "system", type: "socket", label: "已连接", payload: { url: url.toString() } });
        this.onStateChange("connected");
        resolve();
      };

      socket.onerror = () => {
        window.clearTimeout(timeout);
        this.store.add({ direction: "system", type: "socket", error: "WebSocket 连接异常" });
        this.onStateChange("error");
        reject(new Error("WebSocket 连接异常"));
      };

      socket.onclose = (event) => {
        window.clearTimeout(timeout);
        this.store.add({
          direction: "system",
          type: "socket",
          label: "已断开",
          payload: { code: event.code, reason: event.reason }
        });
        this.onStateChange(event.wasClean ? "idle" : "error");
      };

      socket.onmessage = async (messageEvent) => {
        const event = await this.normalizeMessage(messageEvent.data);
        this.store.add(event);
        if (event.payload?.type === "hello" && event.payload.session_id) {
          this.sessionId = event.payload.session_id;
          this.onSession(this.sessionId);
        }
      };
    });
  }

  disconnect(options = {}) {
    if (this.socket) {
      if (options.silent) {
        this.socket.onclose = null;
        this.socket.onerror = null;
      }
      this.socket.close(1000, "ws-lab disconnect");
      this.socket = null;
    }
    this.sessionId = "";
    this.onStateChange("idle");
  }

  sendJson(payload) {
    this.assertConnected();
    this.socket.send(JSON.stringify(payload));
    this.store.add({ direction: "client", payload });
  }

  sendRaw(text, label = "raw") {
    this.assertConnected();
    this.socket.send(String(text));
    this.store.add({ direction: "client", kind: "text", type: label, payload: String(text) });
  }

  sendBinary(bytes, label = "audio") {
    this.assertConnected();
    const payload = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.socket.send(payload);
    this.store.add({ direction: "client", kind: "binary", type: label, bytes: payload.byteLength, payload: null });
  }

  sendTextListen(text, sessionId = "") {
    const payload = {
      type: "listen",
      mode: "manual",
      state: "detect",
      text
    };
    if (sessionId) {
      payload.session_id = sessionId;
    }
    this.sendJson(payload);
    return payload;
  }

  async normalizeMessage(data) {
    if (data instanceof ArrayBuffer) {
      return { direction: "server", kind: "binary", type: "audio", payload: data, bytes: data.byteLength };
    }
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      return { direction: "server", kind: "binary", type: "audio", payload: buffer, bytes: buffer.byteLength };
    }
    if (typeof data === "string") {
      try {
        return { direction: "server", payload: JSON.parse(data) };
      } catch {
        return { direction: "server", kind: "text", payload: data };
      }
    }
    return { direction: "server", kind: "text", payload: String(data) };
  }

  assertConnected() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 尚未连接");
    }
  }
}

function buildConnectionUrl(baseUrl, identity = {}) {
  const url = new URL(baseUrl);
  const normalized = typeof identity === "string" ? { deviceId: identity } : identity || {};
  const deviceId = normalized.deviceId || normalized.device_id || "";
  const userId = normalized.userId || normalized.user_id || "";
  if (deviceId) url.searchParams.set("device_id", deviceId);
  if (userId) url.searchParams.set("user_id", userId);
  return url;
}
