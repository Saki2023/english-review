"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function usersFile(dataDir) {
  return path.join(dataDir, "users.json");
}

function loadUsers(dataDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(usersFile(dataDir), "utf8"));
    return { schema: 1, users: Array.isArray(saved.users) ? saved.users : [] };
  } catch (_) {
    return { schema: 1, users: [] };
  }
}

function saveUsers(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = usersFile(dataDir);
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function validPassword(password, salt, expected) {
  const actual = Buffer.from(passwordHash(password, salt), "hex");
  const target = Buffer.from(String(expected || ""), "hex");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validateCredentials(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw Object.assign(new Error("用户名需为 3 至 32 位字母、数字、下划线、点或短横线"), { statusCode: 400 });
  }
  if (password.length < 8 || password.length > 128) {
    throw Object.assign(new Error("密码长度需为 8 至 128 位"), { statusCode: 400 });
  }
  return { username, password };
}

function createUser(store, credentials, requestedRole) {
  const { username, password } = validateCredentials(credentials);
  const usernameKey = normalizeUsername(username);
  if (store.users.some(item => normalizeUsername(item.usernameKey || item.username) === usernameKey)) {
    throw Object.assign(new Error("用户名已存在"), { statusCode: 409 });
  }
  if (requestedRole && !["admin", "member"].includes(requestedRole)) {
    throw Object.assign(new Error("账号权限只能是 admin 或 member"), { statusCode: 400 });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: crypto.randomUUID(),
    username,
    usernameKey,
    passwordSalt: salt,
    passwordHash: passwordHash(password, salt),
    role: store.users.length === 0 ? "admin" : (requestedRole || "member"),
    createdAt: new Date().toISOString()
  };
  store.users.push(user);
  return user;
}

module.exports = {
  createUser,
  loadUsers,
  normalizeUsername,
  publicUser,
  saveUsers,
  validPassword,
  validateCredentials
};
