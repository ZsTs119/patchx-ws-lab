#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { URL } = require("node:url");

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_COOKIE_NAME = "px_ws_lab_session";
const DEFAULT_SESSION_DAYS = 7;
const MAX_BODY_BYTES = 8 * 1024;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;

const config = {
  host: process.env.WS_LAB_AUTH_HOST || DEFAULT_HOST,
  port: Number(process.env.WS_LAB_AUTH_PORT || DEFAULT_PORT),
  usersFile: process.env.WS_LAB_AUTH_USERS_FILE || path.join(__dirname, "users.json"),
  sessionSecret: process.env.WS_LAB_AUTH_SESSION_SECRET || "",
  cookieName: process.env.WS_LAB_AUTH_COOKIE_NAME || DEFAULT_COOKIE_NAME,
  sessionDays: Number(process.env.WS_LAB_AUTH_SESSION_DAYS || DEFAULT_SESSION_DAYS),
  allowedOrigins: parseCsv(process.env.WS_LAB_AUTH_ALLOWED_ORIGINS || "")
};

const loginAttempts = new Map();

main().catch((error) => {
  console.error(`[ws-lab-auth] ${error.message}`);
  process.exit(1);
});

async function main() {
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error("WS_LAB_AUTH_SESSION_SECRET is required and should be at least 32 characters");
  }
  await loadUsers();
  const server = http.createServer(handleRequest);
  server.listen(config.port, config.host, () => {
    console.log(`[ws-lab-auth] listening on http://${config.host}:${config.port}`);
    console.log(`[ws-lab-auth] users file: ${config.usersFile}`);
  });
}

async function handleRequest(req, res) {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (!url.pathname.startsWith("/api/ws-lab-auth")) {
      sendJson(req, res, 404, { code: 404, message: "not found" });
      return;
    }

    const route = url.pathname.replace(/^\/api\/ws-lab-auth\/?/, "/");
    if (req.method === "GET" && route === "/health") {
      sendJson(req, res, 200, { code: 200, data: { ok: true, auth_enabled: true } });
      return;
    }
    if (req.method === "GET" && route === "/me") {
      await handleMe(req, res);
      return;
    }
    if (req.method === "POST" && route === "/login") {
      await handleLogin(req, res);
      return;
    }
    if (req.method === "POST" && route === "/logout") {
      handleLogout(req, res);
      return;
    }
    sendJson(req, res, 404, { code: 404, message: "not found" });
  } catch (error) {
    console.error(`[ws-lab-auth] request failed: ${error.stack || error.message}`);
    sendJson(req, res, 500, { code: 500, message: "WS Lab auth service error" });
  }
}

async function handleMe(req, res) {
  const users = await loadUsers();
  const claims = verifySession(readCookie(req, config.cookieName));
  const user = claims ? users.get(claims.username) : null;
  if (!user) {
    sendJson(req, res, 200, { code: 200, data: { auth_enabled: true, authenticated: false } });
    return;
  }
  sendJson(req, res, 200, {
    code: 200,
    data: {
      auth_enabled: true,
      authenticated: true,
      user: publicUser(user)
    }
  });
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  if (!body) {
    sendJson(req, res, 400, { code: 400, message: "请求体不是合法 JSON" });
    return;
  }
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const rateKey = `${clientIp(req)}:${username || "-"}`;
  if (isRateLimited(rateKey)) {
    sendJson(req, res, 429, { code: 429, message: "登录尝试过于频繁，请稍后再试" });
    return;
  }

  const users = await loadUsers();
  const user = users.get(username);
  const ok = user && await verifyPassword(password, user.password_hash);
  if (!ok) {
    recordFailedLogin(rateKey);
    sendJson(req, res, 401, { code: 401, message: "账号或密码错误" });
    return;
  }

  clearLoginAttempts(rateKey);
  const now = Math.floor(Date.now() / 1000);
  const expires = now + config.sessionDays * 24 * 60 * 60;
  const token = signSession({ username, issued_at: now, expires });
  setSessionCookie(req, res, token, expires - now);
  sendJson(req, res, 200, {
    code: 200,
    data: {
      auth_enabled: true,
      authenticated: true,
      user: publicUser(user)
    }
  });
}

function handleLogout(req, res) {
  clearSessionCookie(req, res);
  sendJson(req, res, 200, { code: 200, data: { authenticated: false } });
}

async function loadUsers() {
  const raw = await fs.readFile(config.usersFile, "utf8");
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) {
    throw new Error("WS Lab users file must be a JSON array");
  }
  const map = new Map();
  for (const item of users) {
    const user = normalizeUser(item);
    if (!user.username || !user.password_hash) {
      throw new Error("Each WS Lab user requires username and password_hash");
    }
    map.set(user.username, user);
  }
  return map;
}

function normalizeUser(item) {
  const username = normalizeUsername(item.username);
  const audience = String(item.audience || "internal").toLowerCase() === "external" ? "external" : "internal";
  return {
    username,
    password_hash: String(item.password_hash || ""),
    display_name: String(item.display_name || item.displayName || username).trim(),
    audience,
    locale: String(item.locale || "").toLowerCase(),
    endpoint_id: String(item.endpoint_id || item.endpointId || "").trim(),
    locked_endpoint: audience === "external" || Boolean(item.locked_endpoint || item.lockedEndpoint),
    auto_connect: audience === "external" || Boolean(item.auto_connect || item.autoConnect)
  };
}

function publicUser(user) {
  return {
    username: user.username,
    display_name: user.display_name,
    audience: user.audience,
    locale: user.locale,
    endpoint_id: user.endpoint_id,
    locked_endpoint: user.locked_endpoint,
    auto_connect: user.auto_connect
  };
}

async function verifyPassword(password, encoded) {
  const parsed = parseScryptHash(encoded);
  if (!parsed) return false;
  const derived = await scrypt(password, parsed.salt, parsed.key.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: 64 * 1024 * 1024
  });
  return timingSafeEqual(derived, parsed.key);
}

function parseScryptHash(encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  if (!N || !r || !p || salt.length < 16 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

function signSession(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(parts[0]).digest("base64url");
  if (!timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!claims.username || !claims.expires || Math.floor(Date.now() / 1000) > claims.expires) return null;
    return { username: normalizeUsername(claims.username), expires: Number(claims.expires) };
  } catch {
    return null;
  }
}

function setSessionCookie(req, res, value, maxAge) {
  const secure = isSecureRequest(req);
  const cookie = [
    `${config.cookieName}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, maxAge)}`,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
  res.setHeader("Set-Cookie", cookie);
}

function clearSessionCookie(req, res) {
  const secure = isSecureRequest(req);
  const cookie = [
    `${config.cookieName}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
  res.setHeader("Set-Cookie", cookie);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const item of header.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(req, res, status, payload) {
  applyCors(req, res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(req, origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isAllowedOrigin(req, origin) {
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.allowedOrigins.includes("*")) return true;
  try {
    const url = new URL(origin);
    const host = req.headers.host || "";
    const forwardedProto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
    if (`${url.protocol}//${url.host}` === `${forwardedProto}://${host}`) return true;
    return isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function isSecureRequest(req) {
  return req.socket.encrypted ||
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" ||
    String(req.headers["x-forwarded-ssl"] || "").toLowerCase() === "on";
}

function isRateLimited(key) {
  const item = loginAttempts.get(key);
  if (!item) return false;
  if (Date.now() - item.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return item.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const item = loginAttempts.get(key);
  if (!item || now - item.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  item.count += 1;
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function parseCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function timingSafeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function scrypt(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
