export class WsAttemptCancelledError extends Error {
  constructor(attemptId, reason = "cancelled") {
    super(`WebSocket attempt ${attemptId || "<none>"} 已取消：${reason}`);
    this.name = "WsAttemptCancelledError";
    this.code = "WS_ATTEMPT_CANCELLED";
    this.attemptId = attemptId || 0;
    this.reason = reason;
  }
}

export function isWsAttemptCancelledError(error) {
  return error instanceof WsAttemptCancelledError || error?.code === "WS_ATTEMPT_CANCELLED";
}

export class WsClient {
  constructor(store, options = {}) {
    this.store = store;
    this.WebSocketClass = options.WebSocketClass || globalThis.WebSocket;
    this.setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
    this.connectionGeneration = 0;
    this.activeAttempt = null;
    this.socket = null;
    this.sessionId = "";
    this.onStateChange = () => {};
    this.onSession = () => {};
    this.onLifecycle = () => {};
    this.lastServerGoodbye = null;
    this.lastCloseEvent = null;
    this.lastDisconnectIntent = null;
  }

  get activeAttemptId() {
    return this.activeAttempt?.id || 0;
  }

  get readyState() {
    return this.socket?.readyState ?? this.WebSocketClass?.CLOSED ?? 3;
  }

  get isConnected() {
    return Boolean(
      this.activeAttempt
      && !this.activeAttempt.closing
      && this.readyState === (this.WebSocketClass?.OPEN ?? 1)
    );
  }

  beginConnect(baseUrl, identity = {}) {
    if (!this.WebSocketClass) {
      throw new Error("当前环境不支持 WebSocket");
    }
    if (this.activeAttempt) {
      this.disconnect({
        attemptId: this.activeAttempt.id,
        silent: true,
        reason: "replace_connection"
      });
    }

    const attemptId = ++this.connectionGeneration;
    const url = buildConnectionUrl(baseUrl, identity);
    const socket = new this.WebSocketClass(url.toString());
    socket.binaryType = "arraybuffer";
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});

    const attempt = {
      id: attemptId,
      socket,
      url: url.toString(),
      timeout: null,
      settled: false,
      resolveReady,
      rejectReady,
      closing: false,
      sessionId: "",
      disconnectIntent: null,
      serverGoodbye: null,
      failure: null
    };
    this.activeAttempt = attempt;
    this.socket = socket;
    this.sessionId = "";
    this.lastServerGoodbye = null;
    this.lastCloseEvent = null;
    this.lastDisconnectIntent = null;
    this.onStateChange("connecting", attemptId);

    attempt.timeout = this.setTimeoutFn(() => {
      if (!this.isCurrentAttempt(attemptId, socket)) return;
      this.clearAttemptTimeout(attempt);
      const error = new Error("WebSocket 连接超时");
      attempt.failure = error;
      this.settleAttempt(attempt, "reject", error);
      this.store.add({
        direction: "system",
        type: "socket",
        error: error.message,
        connection_attempt_id: attemptId
      });
      this.onStateChange("error", attemptId);
      socket.close();
    }, 8000);

    socket.onopen = () => {
      if (!this.isCurrentAttempt(attemptId, socket)) return;
      this.clearAttemptTimeout(attempt);
      this.store.add({
        direction: "system",
        type: "socket",
        label: "已连接",
        payload: { url: attempt.url },
        connection_attempt_id: attemptId
      });
      this.onStateChange("connected", attemptId);
      this.settleAttempt(attempt, "resolve", attemptId);
    };

    socket.onerror = () => {
      if (!this.isCurrentAttempt(attemptId, socket)) return;
      this.clearAttemptTimeout(attempt);
      const error = new Error("WebSocket 连接异常");
      attempt.failure = error;
      this.store.add({
        direction: "system",
        type: "socket",
        error: error.message,
        connection_attempt_id: attemptId
      });
      this.onStateChange("error", attemptId);
      this.settleAttempt(attempt, "reject", error);
    };

    socket.onclose = (event) => {
      this.handleSocketClose(attempt, event);
    };

    socket.onmessage = async (messageEvent) => {
      if (!this.isCurrentAttempt(attemptId, socket)) return;
      const normalizedEvent = await this.normalizeMessage(messageEvent.data);
      if (!this.isCurrentAttempt(attemptId, socket)) return;
      const event = { ...normalizedEvent, connection_attempt_id: attemptId };
      if (event.payload?.type === "goodbye") {
        attempt.serverGoodbye = event;
        this.lastServerGoodbye = event;
        this.onLifecycle("goodbye", event);
      }
      this.store.add(event);
      if (event.payload?.type === "hello" && event.payload.session_id) {
        attempt.sessionId = event.payload.session_id;
        this.sessionId = attempt.sessionId;
        this.onSession(this.sessionId, attemptId);
      }
    };

    return Object.freeze({ attemptId, ready });
  }

  async connect(baseUrl, identity = {}) {
    const handle = this.beginConnect(baseUrl, identity);
    await handle.ready;
    return handle.attemptId;
  }

  disconnect(options = {}) {
    const attempt = this.activeAttempt;
    if (!attempt) return false;
    if (options.attemptId && options.attemptId !== attempt.id) return false;

    const intent = {
      userInitiated: Boolean(options.userInitiated),
      reason: options.reason || (options.userInitiated ? "user_disconnect" : "disconnect"),
      silent: Boolean(options.silent),
      at: new Date().toISOString(),
      connection_attempt_id: attempt.id
    };
    attempt.disconnectIntent = intent;
    attempt.closing = true;
    this.lastDisconnectIntent = intent;
    this.onLifecycle("disconnect", intent);
    this.connectionGeneration += 1;
    this.clearAttemptTimeout(attempt);
    this.settleAttempt(attempt, "reject", new WsAttemptCancelledError(attempt.id, intent.reason));

    attempt.socket.onopen = null;
    attempt.socket.onmessage = null;
    attempt.socket.onerror = null;
    if (intent.silent) {
      attempt.socket.onclose = null;
      this.releaseAttempt(attempt);
    }

    try {
      attempt.socket.close(1000, "ws-lab disconnect");
    } catch {
      if (!intent.silent) this.releaseAttempt(attempt);
    }

    if (intent.silent) {
      this.onStateChange("idle", attempt.id);
    }
    return true;
  }

  disconnectAttempt(attemptId, reason = "disconnect", options = {}) {
    return this.disconnect({ ...options, attemptId, reason });
  }

  sendJson(payload, options = {}) {
    const attempt = this.assertConnected(options);
    attempt.socket.send(JSON.stringify(payload));
    this.store.add({ direction: "client", payload, connection_attempt_id: attempt.id });
  }

  sendRaw(text, label = "raw", options = {}) {
    const attempt = this.assertConnected(options);
    attempt.socket.send(String(text));
    this.store.add({
      direction: "client",
      kind: "text",
      type: label,
      payload: String(text),
      connection_attempt_id: attempt.id
    });
  }

  sendBinary(bytes, label = "audio", options = {}) {
    const attempt = this.assertConnected(options);
    const payload = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    attempt.socket.send(payload);
    this.store.add({
      direction: "client",
      kind: "binary",
      type: label,
      bytes: payload.byteLength,
      payload: null,
      connection_attempt_id: attempt.id
    });
  }

  sendTextListen(text, sessionId = "", options = {}) {
    const payload = {
      type: "listen",
      mode: "manual",
      state: "detect",
      text
    };
    if (sessionId) {
      payload.session_id = sessionId;
    }
    this.sendJson(payload, options);
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

  assertConnected(options = {}) {
    const attemptId = typeof options === "number" ? options : Number(options?.attemptId || 0);
    const attempt = this.activeAttempt;
    if (attemptId && attempt?.id !== attemptId) {
      throw new WsAttemptCancelledError(attemptId, "stale_attempt");
    }
    if (!attempt || attempt.closing || attempt.socket.readyState !== (this.WebSocketClass?.OPEN ?? 1)) {
      throw new Error("WebSocket 尚未连接");
    }
    return attempt;
  }

  isCurrentAttempt(attemptId, socket) {
    return Boolean(
      this.activeAttempt
      && !this.activeAttempt.closing
      && this.activeAttempt.id === attemptId
      && this.activeAttempt.socket === socket
    );
  }

  clearAttemptTimeout(attempt) {
    if (!attempt?.timeout) return;
    this.clearTimeoutFn(attempt.timeout);
    attempt.timeout = null;
  }

  settleAttempt(attempt, action, value) {
    if (!attempt || attempt.settled) return false;
    attempt.settled = true;
    if (action === "resolve") {
      attempt.resolveReady(value);
    } else {
      attempt.rejectReady(value);
    }
    return true;
  }

  handleSocketClose(attempt, event = {}) {
    if (this.activeAttempt !== attempt || this.socket !== attempt.socket) return;
    this.clearAttemptTimeout(attempt);
    this.settleAttempt(attempt, "reject", new Error("WebSocket 在连接完成前关闭"));
    const intent = attempt.disconnectIntent;
    const closeInfo = {
      code: event.code,
      reason: event.reason,
      wasClean: Boolean(event.wasClean),
      userInitiated: Boolean(intent?.userInitiated),
      disconnectReason: intent?.reason || "",
      silent: Boolean(intent?.silent),
      session_id: attempt.sessionId || "",
      goodbye: attempt.serverGoodbye?.payload || null,
      connection_attempt_id: attempt.id
    };
    this.lastDisconnectIntent = intent;
    this.lastServerGoodbye = attempt.serverGoodbye;
    this.lastCloseEvent = closeInfo;
    this.onLifecycle("close", closeInfo);
    this.store.add({
      direction: "system",
      type: "socket",
      label: "已断开",
      payload: closeInfo,
      connection_attempt_id: attempt.id
    });
    const endedByServer = Boolean(attempt.serverGoodbye && !closeInfo.userInitiated);
    this.releaseAttempt(attempt);
    this.onStateChange(endedByServer ? "ended" : (attempt.failure ? "error" : (closeInfo.wasClean ? "idle" : "error")), attempt.id);
  }

  releaseAttempt(attempt) {
    if (this.activeAttempt !== attempt) return;
    this.activeAttempt = null;
    this.socket = null;
    this.sessionId = "";
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
