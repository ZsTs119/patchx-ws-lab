#!/usr/bin/env node
"use strict";

const path = require("node:path");

process.env.WS_LAB_AUTH_HOST ||= "127.0.0.1";
process.env.WS_LAB_AUTH_PORT ||= "8787";
process.env.WS_LAB_AUTH_USERS_FILE ||= path.join(__dirname, "users.json");
process.env.WS_LAB_AUTH_SESSION_SECRET ||=
  "local-dev-only-ws-lab-auth-secret-change-before-production";

console.log("[ws-lab-auth] local dev mode");
console.log("[ws-lab-auth] do not use start-local-auth.js in production");

require("./ws-lab-auth-server.js");
