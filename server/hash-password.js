#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const DEFAULT_N = 32768;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEY_LENGTH = 64;

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const passwordArg = valueAfter(args, "--password");
  const randomPrefix = valueAfter(args, "--random");

  if (args.includes("--help") || (!passwordArg && !randomPrefix)) {
    printHelp();
    return;
  }

  const password = passwordArg || createPassword(randomPrefix);
  const hash = await createScryptHash(password);

  if (randomPrefix) {
    console.log(`password: ${password}`);
  }
  console.log(`password_hash: ${hash}`);
}

function valueAfter(args, key) {
  const index = args.indexOf(key);
  if (index === -1) return "";
  return String(args[index + 1] || "");
}

function createPassword(prefix) {
  const random = crypto.randomBytes(6).toString("base64url");
  return `${prefix}-${random}`;
}

function createScryptHash(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, DEFAULT_KEY_LENGTH, {
      N: DEFAULT_N,
      r: DEFAULT_R,
      p: DEFAULT_P,
      maxmem: 64 * 1024 * 1024
    }, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve([
        "scrypt",
        DEFAULT_N,
        DEFAULT_R,
        DEFAULT_P,
        salt.toString("base64url"),
        key.toString("base64url")
      ].join("$"));
    });
  });
}

function printHelp() {
  console.log([
    "Usage:",
    "  node server/hash-password.js --random PXLab@Ext-En",
    "  node server/hash-password.js --password \"your-password\"",
    "",
    "The output password_hash can be copied into server/users.json."
  ].join("\n"));
}
