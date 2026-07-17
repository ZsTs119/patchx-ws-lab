import { createIdentity, createUuid, ROLE_CODES } from "./identity-factory.js?v=20260717-external-role2";

export const EXTERNAL_ROLE_STORAGE_PREFIX = "patchx-ws-lab-external-device-identity-v2:";
export const LEGACY_EXTERNAL_ROLE_STORAGE_KEY = "patchx-ws-lab-external-device-identity-v1";

const DEVICE_ID_PATTERN = /^PX(01|02|03|04|05|06)[0-9A-F]{12}$/;
const USER_ID_PATTERN = /^ws-lab-user-(01|02|03|04|05|06)-[0-9a-f]{8}$/;
const MAC_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_IDENTITY_ATTEMPTS = 3;

export class ExternalRoleIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalRoleIdentityError";
  }
}

export function normalizeExternalAccountKey(username) {
  return String(username || "").trim().toLowerCase();
}

export function getExternalRoleStorageKey(username) {
  const accountKey = normalizeExternalAccountKey(username);
  if (!accountKey) {
    throw new ExternalRoleIdentityError("外部测试账号不能为空");
  }
  return `${EXTERNAL_ROLE_STORAGE_PREFIX}${encodeURIComponent(accountKey)}`;
}

export function normalizeExternalRoleRecord(value, username) {
  const accountKey = normalizeExternalAccountKey(username);
  if (!accountKey || !value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schemaVersion !== 2 || value.accountKey !== accountKey) return null;

  const selectedRole = String(value.selectedRole || "");
  if (!ROLE_CODES.includes(selectedRole)) return null;
  if (!isUuid(value.recordId) || !isValidTimestamp(value.updatedAt)) return null;

  const identity = normalizeIdentity(value.identity, selectedRole);
  if (!identity) return null;

  return {
    schemaVersion: 2,
    recordId: String(value.recordId),
    accountKey,
    selectedRole,
    identity,
    updatedAt: String(value.updatedAt)
  };
}

export function loadOrCreateExternalRoleRecord(storage, username, options = {}) {
  const accountKey = normalizeExternalAccountKey(username);
  const key = getExternalRoleStorageKey(accountKey);
  let raw = null;
  let warning = "";

  try {
    storage?.removeItem?.(LEGACY_EXTERNAL_ROLE_STORAGE_KEY);
  } catch {
    // Legacy cleanup is best-effort. The v1 value is never used as a source.
  }

  try {
    raw = storage?.getItem?.(key) ?? null;
  } catch {
    warning = storageWarning();
  }

  const parsed = parseStoredValue(raw);
  const normalized = normalizeExternalRoleRecord(parsed, accountKey);
  if (normalized) {
    return {
      record: normalized,
      created: false,
      repaired: false,
      persisted: true,
      warning
    };
  }

  const selectedRole = canPreserveSelectedRole(parsed, accountKey)
    ? parsed.selectedRole
    : "01";
  const identity = createFreshRoleIdentity(selectedRole, null, options);
  const saved = saveExternalRoleRecord(storage, accountKey, selectedRole, identity, options);

  return {
    ...saved,
    created: true,
    repaired: raw !== null,
    warning: joinWarnings(warning, saved.warning)
  };
}

export function saveExternalRoleRecord(storage, username, roleCode, identity, options = {}) {
  const accountKey = normalizeExternalAccountKey(username);
  const key = getExternalRoleStorageKey(accountKey);
  const selectedRole = normalizeRoleCode(roleCode);
  const normalizedIdentity = normalizeIdentity(identity, selectedRole);
  if (!normalizedIdentity) {
    throw new ExternalRoleIdentityError(`角色 ${selectedRole} 的身份格式无效`);
  }

  const createUuidFn = options.createUuidFn || createUuid;
  const now = options.now || (() => new Date());
  const record = {
    schemaVersion: 2,
    recordId: String(createUuidFn()),
    accountKey,
    selectedRole,
    identity: normalizedIdentity,
    updatedAt: toIsoString(now())
  };

  if (!isUuid(record.recordId) || !isValidTimestamp(record.updatedAt)) {
    throw new ExternalRoleIdentityError("无法创建合法的外部角色记录元数据");
  }

  try {
    storage?.setItem?.(key, JSON.stringify(record));
    return { record, persisted: true, warning: "" };
  } catch {
    return { record, persisted: false, warning: storageWarning() };
  }
}

export function createFreshRoleIdentity(roleCode, previousIdentity, options = {}) {
  const selectedRole = normalizeRoleCode(roleCode);
  const createIdentityFn = options.createIdentityFn || createIdentity;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_MAX_IDENTITY_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = normalizeIdentity(createIdentityFn(selectedRole), selectedRole);
    if (candidate && identityKeyFieldsDiffer(candidate, previousIdentity)) {
      return candidate;
    }
  }

  throw new ExternalRoleIdentityError(`连续 ${maxAttempts} 次无法生成完整且不同的新身份`);
}

export function isCurrentExternalRoleRecord(storage, username, candidate) {
  const candidateRecordId = String(candidate?.recordId || "");
  if (!candidateRecordId) return false;

  try {
    const raw = storage?.getItem?.(getExternalRoleStorageKey(username));
    const current = normalizeExternalRoleRecord(parseStoredValue(raw), username);
    return Boolean(current && current.recordId === candidateRecordId);
  } catch {
    return false;
  }
}

function normalizeRoleCode(roleCode) {
  const normalized = String(roleCode || "");
  if (!ROLE_CODES.includes(normalized)) {
    throw new ExternalRoleIdentityError(`非法角色码：${normalized || "<empty>"}`);
  }
  return normalized;
}

function normalizeIdentity(value, selectedRole) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const roleCode = String(value.roleCode || "");
  const deviceId = String(value.deviceId || "").trim();
  const userId = String(value.userId || "").trim();
  const traceId = String(value.traceId || "").trim();
  const deviceMac = String(value.deviceMac || "").trim().toLowerCase();
  const deviceRole = deviceId.match(DEVICE_ID_PATTERN)?.[1] || "";
  const userRole = userId.match(USER_ID_PATTERN)?.[1] || "";

  if (roleCode !== selectedRole || deviceRole !== selectedRole || userRole !== selectedRole) return null;
  if (!isUuid(traceId) || !isLocallyAdministeredUnicastMac(deviceMac)) return null;

  return {
    roleCode: selectedRole,
    deviceId,
    userId,
    traceId,
    clientId: nonEmptyOr(value.clientId, "web_test_client"),
    deviceMac,
    clientIp: nonEmptyOr(value.clientIp, "127.0.0.1"),
    deviceName: nonEmptyOr(value.deviceName, `WS Lab Role ${selectedRole}`),
    token: nonEmptyOr(value.token, "your-token1")
  };
}

function identityKeyFieldsDiffer(candidate, previousIdentity) {
  if (!previousIdentity) return true;
  return candidate.deviceId !== String(previousIdentity.deviceId || "")
    && candidate.userId !== String(previousIdentity.userId || "")
    && candidate.deviceMac.toLowerCase() !== String(previousIdentity.deviceMac || "").toLowerCase()
    && candidate.traceId.toLowerCase() !== String(previousIdentity.traceId || "").toLowerCase();
}

function canPreserveSelectedRole(value, accountKey) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.schemaVersion === 2
      && value.accountKey === accountKey
      && ROLE_CODES.includes(String(value.selectedRole || ""))
  );
}

function parseStoredValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

function isValidTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function isLocallyAdministeredUnicastMac(value) {
  if (!MAC_PATTERN.test(value)) return false;
  const firstByte = Number.parseInt(value.slice(0, 2), 16);
  return (firstByte & 0x01) === 0 && (firstByte & 0x02) === 0x02;
}

function nonEmptyOr(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function storageWarning() {
  return "角色已切换，但浏览器未能保存；刷新后会重置";
}

function joinWarnings(...values) {
  return [...new Set(values.filter(Boolean))].join("；");
}
