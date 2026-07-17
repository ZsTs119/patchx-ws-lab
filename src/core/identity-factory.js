export const ROLE_OPTIONS = Object.freeze([
  Object.freeze({ code: "01", label: "小格" }),
  Object.freeze({ code: "02", label: "小梦" }),
  Object.freeze({ code: "03", label: "小燃" }),
  Object.freeze({ code: "04", label: "小忧" }),
  Object.freeze({ code: "05", label: "小慌" }),
  Object.freeze({ code: "06", label: "小安" })
]);

export const ROLE_CODES = Object.freeze(ROLE_OPTIONS.map(({ code }) => code));

export function getRoleLabel(roleCode = "01") {
  return ROLE_OPTIONS.find(({ code }) => code === roleCode)?.label || ROLE_OPTIONS[0].label;
}

export function createIdentity(roleCode = "01") {
  const normalizedRole = ROLE_CODES.includes(roleCode) ? roleCode : "01";
  return {
    roleCode: normalizedRole,
    deviceId: createDeviceId(normalizedRole),
    userId: `ws-lab-user-${normalizedRole}-${shortId(8)}`,
    traceId: createUuid(),
    clientId: "web_test_client",
    deviceMac: createMac(),
    clientIp: "127.0.0.1",
    deviceName: `WS Lab Role ${normalizedRole}`,
    token: "your-token1"
  };
}

export function createDeviceId(roleCode = "01") {
  const normalizedRole = ROLE_CODES.includes(roleCode) ? roleCode : "01";
  return `PX${normalizedRole}${shortId(12).toUpperCase()}`;
}

export function inferRoleFromDeviceId(deviceId = "") {
  const code = String(deviceId).slice(2, 4);
  return ROLE_CODES.includes(code) ? code : "01";
}

export function createUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) => {
    const value = Number(char) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(char) / 4)));
    return value.toString(16);
  });
}

function createMac() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function shortId(length) {
  const alphabet = "0123456789abcdef";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
