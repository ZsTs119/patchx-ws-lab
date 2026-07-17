import test from "node:test";
import assert from "node:assert/strict";

import { getRoleLabel, ROLE_CODES, ROLE_OPTIONS } from "../src/core/identity-factory.js";
import {
  EXTERNAL_ROLE_STORAGE_PREFIX,
  LEGACY_EXTERNAL_ROLE_STORAGE_KEY,
  createFreshRoleIdentity,
  getExternalRoleStorageKey,
  isCurrentExternalRoleRecord,
  loadOrCreateExternalRoleRecord,
  normalizeExternalAccountKey,
  normalizeExternalRoleRecord,
  saveExternalRoleRecord
} from "../src/core/external-role-identity-store.js";

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class FailingStorage {
  getItem() {
    throw new Error("storage unavailable");
  }

  setItem() {
    throw new Error("storage unavailable");
  }

  removeItem() {
    throw new Error("storage unavailable");
  }
}

function uuid(seed = 1) {
  return `00000000-0000-4000-8000-${Number(seed).toString(16).padStart(12, "0").slice(-12)}`;
}

function makeIdentity(roleCode = "01", seed = 1) {
  const deviceSuffix = Number(seed).toString(16).padStart(12, "0").slice(-12).toUpperCase();
  const userSuffix = Number(seed).toString(16).padStart(8, "0").slice(-8);
  const macSuffix = Number(seed).toString(16).padStart(10, "0").slice(-10).match(/.{2}/g).join(":");
  return {
    roleCode,
    deviceId: `PX${roleCode}${deviceSuffix}`,
    userId: `ws-lab-user-${roleCode}-${userSuffix}`,
    traceId: uuid(seed),
    clientId: "web_test_client",
    deviceMac: `02:${macSuffix}`,
    clientIp: "127.0.0.1",
    deviceName: `WS Lab Role ${roleCode}`,
    token: "your-token1"
  };
}

function makeOptions(start = 1) {
  let next = start;
  return {
    createIdentityFn(roleCode) {
      return makeIdentity(roleCode, next++);
    },
    createUuidFn() {
      return uuid(next++);
    },
    now() {
      return new Date("2026-07-17T03:00:00.000Z");
    }
  };
}

function makeRecord(accountKey = "px_ext_ja", roleCode = "02", seed = 20) {
  return {
    schemaVersion: 2,
    recordId: uuid(seed + 1),
    accountKey,
    selectedRole: roleCode,
    identity: makeIdentity(roleCode, seed),
    updatedAt: "2026-07-17T03:00:00.000Z"
  };
}

test("role catalog has the locked six labels and one derived code source", () => {
  assert.deepEqual(ROLE_OPTIONS, [
    { code: "01", label: "小格" },
    { code: "02", label: "小梦" },
    { code: "03", label: "小燃" },
    { code: "04", label: "小忧" },
    { code: "05", label: "小慌" },
    { code: "06", label: "小安" }
  ]);
  assert.deepEqual(ROLE_CODES, ROLE_OPTIONS.map(({ code }) => code));
  assert.equal(getRoleLabel("03"), "小燃");
  assert.ok(Object.isFrozen(ROLE_OPTIONS));
  assert.ok(ROLE_OPTIONS.every(Object.isFrozen));
});

test("external account keys are normalized and isolated", () => {
  assert.equal(normalizeExternalAccountKey("  PX_EXT_JA  "), "px_ext_ja");
  assert.equal(
    getExternalRoleStorageKey("  PX_EXT_JA  "),
    `${EXTERNAL_ROLE_STORAGE_PREFIX}px_ext_ja`
  );
  assert.notEqual(getExternalRoleStorageKey("px_ext_en"), getExternalRoleStorageKey("px_ext_ja"));
  assert.notEqual(getExternalRoleStorageKey("px_ext_ja"), getExternalRoleStorageKey("px_ext_zh"));
  assert.throws(() => getExternalRoleStorageKey("   "), /账号|account/i);
});

test("first load creates and persists role 01, later loads reuse the same record", () => {
  const storage = new MemoryStorage();
  const options = makeOptions(1);

  const first = loadOrCreateExternalRoleRecord(storage, "px_ext_ja", options);
  assert.equal(first.created, true);
  assert.equal(first.persisted, true);
  assert.equal(first.record.selectedRole, "01");
  assert.equal(first.record.identity.roleCode, "01");
  assert.match(first.record.identity.deviceId, /^PX01[0-9A-F]{12}$/);

  const second = loadOrCreateExternalRoleRecord(storage, "PX_EXT_JA", makeOptions(50));
  assert.equal(second.created, false);
  assert.equal(second.persisted, true);
  assert.deepEqual(second.record, first.record);
});

test("three accounts keep independent records and legacy v1 is never migrated", () => {
  const legacyIdentity = makeIdentity("06", 99);
  const storage = new MemoryStorage([[LEGACY_EXTERNAL_ROLE_STORAGE_KEY, JSON.stringify(legacyIdentity)]]);

  const en = loadOrCreateExternalRoleRecord(storage, "px_ext_en", makeOptions(1)).record;
  const ja = loadOrCreateExternalRoleRecord(storage, "px_ext_ja", makeOptions(20)).record;
  const zh = loadOrCreateExternalRoleRecord(storage, "px_ext_zh", makeOptions(40)).record;

  assert.equal(storage.getItem(LEGACY_EXTERNAL_ROLE_STORAGE_KEY), null);
  assert.deepEqual([en.selectedRole, ja.selectedRole, zh.selectedRole], ["01", "01", "01"]);
  assert.equal(new Set([en.identity.deviceId, ja.identity.deviceId, zh.identity.deviceId]).size, 3);
  assert.deepEqual([en.accountKey, ja.accountKey, zh.accountKey], ["px_ext_en", "px_ext_ja", "px_ext_zh"]);
});

test("invalid schema, account, role, or JSON creates a fresh role 01 record", () => {
  const cases = [
    "{broken-json",
    JSON.stringify({ ...makeRecord("px_ext_ja"), schemaVersion: 1 }),
    JSON.stringify({ ...makeRecord("px_ext_en"), accountKey: "px_ext_en" }),
    JSON.stringify({ ...makeRecord("px_ext_ja"), selectedRole: "99" })
  ];

  for (const [index, raw] of cases.entries()) {
    const key = getExternalRoleStorageKey("px_ext_ja");
    const storage = new MemoryStorage([[key, raw]]);
    const result = loadOrCreateExternalRoleRecord(storage, "px_ext_ja", makeOptions(100 + index * 10));
    assert.equal(result.created, true);
    assert.equal(result.record.selectedRole, "01");
    assert.equal(result.record.accountKey, "px_ext_ja");
  }
});

test("valid role with damaged identity or metadata is regenerated for that role", () => {
  const base = makeRecord("px_ext_ja", "02", 200);
  const damaged = [
    { ...base, identity: { ...base.identity, roleCode: "01" } },
    { ...base, identity: { ...base.identity, deviceId: "px02abcdefabcdef" } },
    { ...base, identity: { ...base.identity, deviceId: "PX01ABCDEFABCDEF" } },
    { ...base, identity: { ...base.identity, userId: "ws-lab-user-01-00000001" } },
    { ...base, identity: { ...base.identity, deviceMac: "01:00:00:00:00:01" } },
    { ...base, identity: { ...base.identity, deviceMac: "00:00:00:00:00:01" } },
    { ...base, identity: { ...base.identity, traceId: "not-a-uuid" } },
    { ...base, recordId: "not-a-uuid" },
    { ...base, updatedAt: "not-a-date" }
  ];

  for (const [index, record] of damaged.entries()) {
    const key = getExternalRoleStorageKey("px_ext_ja");
    const storage = new MemoryStorage([[key, JSON.stringify(record)]]);
    const result = loadOrCreateExternalRoleRecord(storage, "px_ext_ja", makeOptions(300 + index * 10));
    assert.equal(result.created, true);
    assert.equal(result.record.selectedRole, "02");
    assert.equal(result.record.identity.roleCode, "02");
    assert.match(result.record.identity.deviceId, /^PX02[0-9A-F]{12}$/);
    assert.notEqual(result.record.identity.deviceId, base.identity.deviceId);
  }
});

test("strict normalization rejects cross-account and malformed records", () => {
  const record = makeRecord("px_ext_ja", "04", 400);
  assert.deepEqual(normalizeExternalRoleRecord(record, "PX_EXT_JA"), record);
  assert.equal(normalizeExternalRoleRecord(record, "px_ext_en"), null);
  assert.equal(normalizeExternalRoleRecord({ ...record, selectedRole: "07" }, "px_ext_ja"), null);
  assert.equal(
    normalizeExternalRoleRecord(
      { ...record, identity: { ...record.identity, deviceId: "PX04TOO-SHORT" } },
      "px_ext_ja"
    ),
    null
  );
});

test("storage failures return an in-memory record with an explicit warning", () => {
  const identity = makeIdentity("03", 500);
  const saved = saveExternalRoleRecord(new FailingStorage(), "px_ext_ja", "03", identity, makeOptions(510));
  assert.equal(saved.persisted, false);
  assert.deepEqual(saved.record.identity, identity);
  assert.match(saved.warning, /保存|storage/i);

  const loaded = loadOrCreateExternalRoleRecord(new FailingStorage(), "px_ext_ja", makeOptions(520));
  assert.equal(loaded.created, true);
  assert.equal(loaded.persisted, false);
  assert.equal(loaded.record.selectedRole, "01");
  assert.match(loaded.warning, /保存|storage/i);
});

test("fresh role identity requires every key field to differ and stops after three collisions", () => {
  const previous = makeIdentity("01", 600);
  const fresh = makeIdentity("02", 603);
  const sequence = [
    { ...makeIdentity("02", 601), deviceId: previous.deviceId },
    { ...makeIdentity("02", 602), deviceMac: previous.deviceMac },
    fresh
  ];
  let calls = 0;
  const result = createFreshRoleIdentity("02", previous, {
    createIdentityFn() {
      return sequence[calls++];
    }
  });
  assert.deepEqual(result, fresh);
  assert.equal(calls, 3);

  calls = 0;
  assert.throws(
    () => createFreshRoleIdentity("02", previous, {
      createIdentityFn() {
        calls += 1;
        return { ...makeIdentity("02", 700 + calls), traceId: previous.traceId };
      }
    }),
    /3|生成|identity/i
  );
  assert.equal(calls, 3);
});

test("current-record checks re-read storage and reject stale record ids", () => {
  const storage = new MemoryStorage();
  const first = saveExternalRoleRecord(
    storage,
    "px_ext_ja",
    "01",
    makeIdentity("01", 800),
    makeOptions(810)
  ).record;
  const second = saveExternalRoleRecord(
    storage,
    "px_ext_ja",
    "02",
    makeIdentity("02", 820),
    makeOptions(830)
  ).record;

  assert.equal(isCurrentExternalRoleRecord(storage, "px_ext_ja", first), false);
  assert.equal(isCurrentExternalRoleRecord(storage, "px_ext_ja", second), true);
  assert.equal(isCurrentExternalRoleRecord(new FailingStorage(), "px_ext_ja", second), false);
});
