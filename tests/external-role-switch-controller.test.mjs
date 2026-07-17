import test from "node:test";
import assert from "node:assert/strict";

import {
  createExternalRoleSwitchController,
  isRuntimeOwnerCurrent
} from "../src/core/external-role-switch-controller.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeIdentity(roleCode = "01", seed = 1) {
  const hex12 = seed.toString(16).padStart(12, "0").slice(-12).toUpperCase();
  const hex8 = seed.toString(16).padStart(8, "0").slice(-8);
  return {
    roleCode,
    deviceId: `PX${roleCode}${hex12}`,
    userId: `ws-lab-user-${roleCode}-${hex8}`,
    traceId: `00000000-0000-4000-8000-${hex12.toLowerCase()}`,
    deviceMac: `02:00:00:00:00:${seed.toString(16).padStart(2, "0").slice(-2)}`,
    clientId: "web_test_client",
    clientIp: "127.0.0.1",
    deviceName: `WS Lab Role ${roleCode}`,
    token: "your-token1"
  };
}

function makeRecord(roleCode = "01", seed = 1, accountKey = "px_ext_ja") {
  return {
    schemaVersion: 2,
    recordId: `10000000-0000-4000-8000-${seed.toString(16).padStart(12, "0").slice(-12)}`,
    accountKey,
    selectedRole: roleCode,
    identity: makeIdentity(roleCode, seed),
    updatedAt: "2026-07-17T03:00:00.000Z"
  };
}

function createHarness(overrides = {}) {
  const events = [];
  const snapshots = [];
  let currentRecord = overrides.currentRecord || makeRecord("01", 1);
  let nextAttemptId = 10;
  const readyQueue = [];
  const helloQueue = [];

  const dependencies = {
    getProfile: () => ({ audience: "external", username: "px_ext_ja" }),
    getCurrentRecord: () => currentRecord,
    getIdentity: () => currentRecord?.identity,
    createFreshIdentity: (roleCode) => {
      events.push("create");
      return makeIdentity(roleCode, 20);
    },
    cancelAutoConnect: () => events.push("cancel_timer"),
    resetRuntime: (reason) => events.push(`reset:${reason}`),
    applyIdentity: (recordLike) => {
      events.push("apply");
      if (recordLike.recordId) currentRecord = recordLike;
    },
    persist: (accountKey, roleCode, identity) => {
      events.push("persist");
      currentRecord = { ...makeRecord(roleCode, 30, accountKey), identity };
      return { record: currentRecord, persisted: true, warning: "" };
    },
    beginConnect: () => {
      events.push("begin_connect");
      const pending = readyQueue.shift() || deferred();
      return { attemptId: nextAttemptId++, ready: pending.promise };
    },
    waitForHello: (attemptId) => {
      events.push(`wait_hello:${attemptId}`);
      const pending = helloQueue.shift() || deferred();
      return pending.promise;
    },
    disconnectAttempt: (attemptId, reason) => events.push(`disconnect:${attemptId}:${reason}`),
    onState: (snapshot) => snapshots.push(snapshot),
    ...overrides.dependencies
  };

  const controller = createExternalRoleSwitchController(dependencies);
  return {
    controller,
    dependencies,
    events,
    snapshots,
    readyQueue,
    helloQueue,
    get currentRecord() {
      return currentRecord;
    },
    setCurrentRecord(record) {
      currentRecord = record;
    }
  };
}

test("invalid audiences, accounts, roles, and the current role have no side effects", async () => {
  for (const getProfile of [
    () => null,
    () => ({ audience: "internal", username: "local" }),
    () => ({ audience: "external", username: "  " })
  ]) {
    const harness = createHarness({ dependencies: { getProfile } });
    const result = await harness.controller.switchTo("02");
    assert.equal(result.ok, false);
    assert.deepEqual(harness.events, []);
  }

  const invalidRole = createHarness();
  assert.equal((await invalidRole.controller.switchTo("99")).ok, false);
  assert.deepEqual(invalidRole.events, []);

  const sameRole = createHarness();
  assert.deepEqual(await sameRole.controller.switchTo("01"), { ok: true, noop: true });
  assert.deepEqual(sameRole.events, []);
});

test("successful switch follows the atomic order and waits for the exact Hello", async () => {
  const harness = createHarness();
  const ready = deferred();
  const hello = deferred();
  harness.readyQueue.push(ready);
  harness.helloQueue.push(hello);

  const switching = harness.controller.switchTo("02");
  await flush();
  assert.deepEqual(harness.events.slice(0, 6), [
    "create",
    "cancel_timer",
    "reset:role_switch",
    "apply",
    "persist",
    "begin_connect"
  ]);
  assert.equal(harness.controller.snapshot().status, "connecting");
  const attemptId = harness.controller.snapshot().attemptId;

  ready.resolve(attemptId);
  await flush();
  assert.equal(harness.controller.snapshot().status, "awaiting_hello");
  assert.equal(harness.events.at(-1), `wait_hello:${attemptId}`);

  hello.resolve("session-2");
  assert.deepEqual(await switching, { ok: true, record: harness.currentRecord, attemptId });
  assert.equal(harness.controller.snapshot().status, "connected");
  assert.equal(harness.controller.snapshot().recordId, harness.currentRecord.recordId);
});

test("generation failure leaves the old runtime and identity untouched", async () => {
  const oldRecord = makeRecord("01", 1);
  const harness = createHarness({
    currentRecord: oldRecord,
    dependencies: {
      createFreshIdentity() {
        throw new Error("random failed");
      }
    }
  });

  const result = await harness.controller.switchTo("02");
  assert.equal(result.ok, false);
  assert.equal(harness.currentRecord, oldRecord);
  assert.equal(harness.events.some((event) => event.startsWith("reset:")), false);
  assert.equal(harness.events.includes("persist"), false);
  assert.equal(harness.controller.snapshot().status, "error");
});

test("persist warnings keep the new identity and connection path", async () => {
  const ready = deferred();
  const hello = deferred();
  const harness = createHarness({
    dependencies: {
      persist(accountKey, roleCode, identity) {
        const record = { ...makeRecord(roleCode, 50, accountKey), identity };
        return { record, persisted: false, warning: "未保存" };
      },
      beginConnect() {
        return { attemptId: 50, ready: ready.promise };
      },
      waitForHello() {
        return hello.promise;
      }
    }
  });

  const switching = harness.controller.switchTo("03");
  await flush();
  assert.equal(harness.controller.snapshot().storageWarning, "未保存");
  ready.resolve(50);
  await flush();
  hello.resolve("session-3");
  assert.equal((await switching).ok, true);
  assert.equal(harness.controller.snapshot().selectedRole, "03");
});

test("connect failure preserves the committed record and retry reuses it", async () => {
  const firstReady = deferred();
  const retryReady = deferred();
  const retryHello = deferred();
  const harness = createHarness();
  harness.readyQueue.push(firstReady, retryReady);
  harness.helloQueue.push(retryHello);

  const switching = harness.controller.switchTo("02");
  await flush();
  const committedRecord = harness.currentRecord;
  firstReady.reject(new Error("offline"));
  assert.equal((await switching).ok, false);
  assert.equal(harness.controller.snapshot().status, "reconnect_error");
  assert.equal(harness.currentRecord, committedRecord);

  const createCallsBeforeRetry = harness.events.filter((event) => event === "create").length;
  const retrying = harness.controller.retryCurrentIdentity();
  await flush();
  const retryAttempt = harness.controller.snapshot().attemptId;
  retryReady.resolve(retryAttempt);
  await flush();
  retryHello.resolve("retry-session");
  assert.equal((await retrying).ok, true);
  assert.equal(harness.events.filter((event) => event === "create").length, createCallsBeforeRetry);
  assert.equal(harness.currentRecord, committedRecord);
});

test("cancel before commit keeps the old record; cancel after commit closes only its attempt", async () => {
  const identityPending = deferred();
  const oldRecord = makeRecord("01", 1);
  const preparing = createHarness({
    currentRecord: oldRecord,
    dependencies: { createFreshIdentity: () => identityPending.promise }
  });
  const preparingSwitch = preparing.controller.switchTo("02");
  await flush();
  preparing.controller.cancel("user_cancel");
  identityPending.resolve(makeIdentity("02", 2));
  assert.equal((await preparingSwitch).cancelled, true);
  assert.equal(preparing.currentRecord, oldRecord);
  assert.equal(preparing.controller.snapshot().status, "idle");

  const ready = deferred();
  const committed = createHarness();
  committed.readyQueue.push(ready);
  const committedSwitch = committed.controller.switchTo("02");
  await flush();
  const attemptId = committed.controller.snapshot().attemptId;
  const newRecord = committed.currentRecord;
  committed.controller.cancel("user_cancel");
  ready.reject(new Error("cancelled downstream"));
  assert.equal((await committedSwitch).cancelled, true);
  assert.equal(committed.currentRecord, newRecord);
  assert.equal(committed.controller.snapshot().status, "cancelled_disconnected");
  assert.ok(committed.events.includes(`disconnect:${attemptId}:user_cancel`));
});

test("invalidate suppresses late async state and storage adoption is passive", async () => {
  const ready = deferred();
  const harness = createHarness();
  harness.readyQueue.push(ready);
  const switching = harness.controller.switchTo("02");
  await flush();
  const snapshotCount = harness.snapshots.length;
  harness.controller.invalidate("auth_logout");
  ready.resolve(10);
  assert.equal((await switching).cancelled, true);
  assert.equal(harness.snapshots.length, snapshotCount + 1);

  const adopted = makeRecord("05", 90);
  const applyEventsBefore = harness.events.filter((event) => event === "apply").length;
  assert.equal(harness.controller.adoptExternalRecord(adopted).adopted, true);
  assert.equal(harness.controller.snapshot().selectedRole, "05");
  assert.equal(harness.events.filter((event) => event === "apply").length, applyEventsBefore + 1);
  assert.equal(harness.events.filter((event) => event === "begin_connect").length, 1);
  assert.deepEqual(harness.controller.adoptExternalRecord(adopted), { adopted: false, noop: true });
});

test("Hello failure disconnects only its attempt and exposes reconnect_error", async () => {
  const ready = deferred();
  const hello = deferred();
  const harness = createHarness();
  harness.readyQueue.push(ready);
  harness.helloQueue.push(hello);
  const switching = harness.controller.switchTo("02");
  await flush();
  const attemptId = harness.controller.snapshot().attemptId;
  ready.resolve(attemptId);
  await flush();
  hello.reject(Object.assign(new Error("hello timeout"), { code: "HELLO_TIMEOUT" }));
  assert.equal((await switching).ok, false);
  assert.ok(harness.events.includes(`disconnect:${attemptId}:hello_timeout`));
  assert.equal(harness.controller.snapshot().status, "reconnect_error");
});

test("runtime owner comparison rejects queued callbacks after epoch, account, or profile changes", () => {
  const owner = { runtimeEpoch: 4, accountKey: "px_ext_ja", profileKey: "ja|external" };
  assert.equal(isRuntimeOwnerCurrent(owner, { ...owner }), true);
  assert.equal(isRuntimeOwnerCurrent(owner, { ...owner, runtimeEpoch: 5 }), false);
  assert.equal(isRuntimeOwnerCurrent(owner, { ...owner, accountKey: "px_ext_en" }), false);
  assert.equal(isRuntimeOwnerCurrent(owner, { ...owner, profileKey: "en|external" }), false);
});
