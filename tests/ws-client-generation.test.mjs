import test from "node:test";
import assert from "node:assert/strict";

import { ProtocolStore } from "../src/core/protocol-store.js";
import { WsAttemptCancelledError, WsClient } from "../src/core/ws-client.js";

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback) {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  run(id) {
    const callback = this.tasks.get(id);
    if (!callback) return;
    this.tasks.delete(id);
    callback();
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "";
    this.sent = [];
    this.closeCalls = [];
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({ target: this });
  }

  fail() {
    this.onerror?.({ target: this });
  }

  receive(data) {
    return this.onmessage?.({ data, target: this });
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: code === 1000, target: this });
  }

  send(payload) {
    this.sent.push(payload);
  }
}

class MemoryStore {
  constructor() {
    this.events = [];
  }

  add(event) {
    this.events.push(event);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  FakeWebSocket.instances = [];
  const clock = new FakeClock();
  const store = new MemoryStore();
  const states = [];
  const sessions = [];
  const lifecycle = [];
  const client = new WsClient(store, {
    WebSocketClass: FakeWebSocket,
    setTimeoutFn: (callback) => clock.setTimeout(callback),
    clearTimeoutFn: (id) => clock.clearTimeout(id)
  });
  client.onStateChange = (...args) => states.push(args);
  client.onSession = (...args) => sessions.push(args);
  client.onLifecycle = (...args) => lifecycle.push(args);
  return { client, clock, store, states, sessions, lifecycle };
}

test("beginConnect returns an attempt handle and connect remains await-compatible", async () => {
  const { client } = createHarness();
  const handle = client.beginConnect("ws://example.test/ws", { deviceId: "PX01000000000001" });
  assert.equal(handle.attemptId, client.activeAttemptId);
  assert.equal(FakeWebSocket.instances.length, 1);
  FakeWebSocket.instances[0].open();
  assert.equal(await handle.ready, handle.attemptId);

  const connected = client.connect("ws://example.test/ws", { deviceId: "PX01000000000002" });
  FakeWebSocket.instances[1].open();
  assert.equal(await connected, client.activeAttemptId);
});

test("replacing an attempt cancels its ready promise and all stale callbacks", async () => {
  const { client, clock, states } = createHarness();
  const attemptA = client.beginConnect("ws://example.test/a");
  const socketA = FakeWebSocket.instances[0];
  const staleOpen = socketA.onopen;
  const staleError = socketA.onerror;
  const staleClose = socketA.onclose;
  const timeoutA = [...clock.tasks.keys()][0];
  const cancelledA = assert.rejects(attemptA.ready, WsAttemptCancelledError);

  const attemptB = client.beginConnect("ws://example.test/b");
  const socketB = FakeWebSocket.instances[1];
  assert.equal(socketA.onopen, null);
  assert.equal(socketA.onerror, null);
  assert.equal(socketA.onclose, null);
  assert.equal(socketA.onmessage, null);
  await cancelledA;

  staleOpen?.({ target: socketA });
  staleError?.({ target: socketA });
  staleClose?.({ code: 1006, reason: "late", wasClean: false, target: socketA });
  clock.run(timeoutA);
  assert.equal(socketB.closeCalls.length, 0);
  assert.equal(client.activeAttemptId, attemptB.attemptId);
  assert.deepEqual(states.map(([state]) => state), ["connecting", "idle", "connecting"]);

  socketB.open();
  await attemptB.ready;
  assert.equal(client.isConnected, true);
});

test("async message normalization rechecks ownership before store or session side effects", async () => {
  const { client, store, sessions } = createHarness();
  const attemptA = client.beginConnect("ws://example.test/a");
  const socketA = FakeWebSocket.instances[0];
  socketA.open();
  await attemptA.ready;
  const pending = deferred();
  client.normalizeMessage = () => pending.promise;
  const messageWork = socketA.receive("hello");

  const attemptB = client.beginConnect("ws://example.test/b");
  pending.resolve({ direction: "server", payload: { type: "hello", session_id: "stale-session" } });
  await messageWork;

  assert.equal(store.events.some((event) => event.payload?.session_id === "stale-session"), false);
  assert.equal(sessions.length, 0);
  assert.equal(client.activeAttemptId, attemptB.attemptId);
  client.disconnect({ attemptId: attemptB.attemptId, silent: true });
  await assert.rejects(attemptB.ready, WsAttemptCancelledError);
});

test("attempt-aware sends cannot target a replacement socket", async () => {
  const { client } = createHarness();
  const attemptA = client.beginConnect("ws://example.test/a");
  FakeWebSocket.instances[0].open();
  await attemptA.ready;

  const attemptB = client.beginConnect("ws://example.test/b");
  const socketB = FakeWebSocket.instances[1];
  socketB.open();
  await attemptB.ready;

  assert.throws(() => client.sendJson({ type: "hello" }, { attemptId: attemptA.attemptId }), WsAttemptCancelledError);
  assert.throws(() => client.sendRaw("old", "raw", { attemptId: attemptA.attemptId }), WsAttemptCancelledError);
  assert.throws(() => client.sendBinary(new Uint8Array([1]), "audio", { attemptId: attemptA.attemptId }), WsAttemptCancelledError);
  assert.equal(socketB.sent.length, 0);

  client.sendJson({ type: "hello" }, { attemptId: attemptB.attemptId });
  client.sendRaw("current", "raw", { attemptId: attemptB.attemptId });
  client.sendBinary(new Uint8Array([2]), "audio", { attemptId: attemptB.attemptId });
  assert.equal(socketB.sent.length, 3);
});

test("current Hello publishes attempt metadata and session ownership", async () => {
  const { client, store, sessions } = createHarness();
  const attempt = client.beginConnect("ws://example.test/ws");
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await attempt.ready;
  await socket.receive(JSON.stringify({ type: "hello", session_id: "session-b" }));

  assert.equal(client.sessionId, "session-b");
  assert.deepEqual(sessions, [["session-b", attempt.attemptId]]);
  const helloEvent = store.events.find((event) => event.payload?.type === "hello");
  assert.equal(helloEvent.connection_attempt_id, attempt.attemptId);
  assert.equal("connection_attempt_id" in helloEvent.payload, false);
});

test("ProtocolStore preserves local attempt metadata outside the protocol payload", () => {
  const store = new ProtocolStore();
  const event = store.add({
    direction: "server",
    payload: { type: "hello", session_id: "session-b" },
    connection_attempt_id: 7
  });

  assert.equal(event.connection_attempt_id, 7);
  assert.equal("connection_attempt_id" in event.payload, false);
});

test("stale disconnect is a no-op for the current attempt lifecycle metadata", async () => {
  const { client } = createHarness();
  const attemptA = client.beginConnect("ws://example.test/a");
  FakeWebSocket.instances[0].open();
  await attemptA.ready;
  const attemptB = client.beginConnect("ws://example.test/b");
  const socketB = FakeWebSocket.instances[1];
  socketB.open();
  await attemptB.ready;
  await socketB.receive(JSON.stringify({ type: "hello", session_id: "current-session" }));

  const before = {
    sessionId: client.sessionId,
    disconnectIntent: client.lastDisconnectIntent,
    goodbye: client.lastServerGoodbye,
    closeEvent: client.lastCloseEvent
  };
  assert.equal(client.disconnect({ attemptId: attemptA.attemptId, reason: "stale" }), false);
  assert.deepEqual(
    {
      sessionId: client.sessionId,
      disconnectIntent: client.lastDisconnectIntent,
      goodbye: client.lastServerGoodbye,
      closeEvent: client.lastCloseEvent
    },
    before
  );
  assert.equal(client.activeAttemptId, attemptB.attemptId);
  assert.equal(socketB.closeCalls.length, 0);
});

test("only the target timeout or disconnect can close an active socket", async () => {
  const { client, clock } = createHarness();
  const attemptA = client.beginConnect("ws://example.test/a");
  const timeoutA = [...clock.tasks.keys()][0];
  const cancelledA = assert.rejects(attemptA.ready, WsAttemptCancelledError);
  const attemptB = client.beginConnect("ws://example.test/b");
  const socketB = FakeWebSocket.instances[1];
  await cancelledA;

  clock.run(timeoutA);
  assert.equal(socketB.closeCalls.length, 0);
  assert.equal(client.disconnect({ attemptId: attemptA.attemptId, silent: true }), false);
  assert.equal(socketB.closeCalls.length, 0);
  assert.equal(client.disconnect({ attemptId: attemptB.attemptId, silent: true }), true);
  assert.equal(socketB.closeCalls.length, 1);
  await assert.rejects(attemptB.ready, WsAttemptCancelledError);
});
