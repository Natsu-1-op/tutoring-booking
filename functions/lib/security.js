"use strict";

const crypto = require("crypto");
const {HttpsError} = require("firebase-functions/v2/https");

const STUDENT_NAME_PATTERN = /^[^.#$\/\[\]<>,\u0000-\u001F\u007F]{1,50}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const CANCEL_CODE_PATTERN = /^[A-Z2-9]{5}$/;

function requireString(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${field} 格式不合法。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} 格式不合法。`);
  }
  return normalized;
}

function requireStudentName(value) {
  const name = requireString(value, "姓名", 50);
  if (!STUDENT_NAME_PATTERN.test(name)) {
    throw new HttpsError("invalid-argument", "姓名格式不合法。");
  }
  return name;
}

function requireYear(value) {
  const year = requireString(String(value || ""), "学年", 4);
  if (!/^\d{4}$/.test(year)) {
    throw new HttpsError("invalid-argument", "学年格式不合法。");
  }
  return year;
}

function requireId(value, field = "标识") {
  const id = requireString(value, field, 100);
  if (!ID_PATTERN.test(id)) {
    throw new HttpsError("invalid-argument", `${field} 格式不合法。`);
  }
  return id;
}

function requireCancelCode(value) {
  const code = requireString(value, "取消凭证", 5).toUpperCase();
  if (!CANCEL_CODE_PATTERN.test(code)) {
    throw new HttpsError("invalid-argument", "取消凭证格式不合法。");
  }
  return code;
}

function secureEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return result;
}

function hashKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function requestIp(request) {
  const raw = request && request.rawRequest;
  if (!raw) return "unknown";
  const forwarded = raw.headers && raw.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 128);
  }
  return String(raw.ip || raw.socket && raw.socket.remoteAddress || "unknown").slice(0, 128);
}

async function enforceRateLimit(database, request, bucket, options = {}) {
  const limit = Number(options.limit || 10);
  const windowMs = Number(options.windowMs || 10 * 60 * 1000);
  const subject = String(options.subject || "global");
  const identifier = hashKey(`${bucket}|${requestIp(request)}|${subject}`);
  const ref = database.ref(`privateRuntime/rateLimits/${bucket}/${identifier}`);
  const now = Date.now();
  const result = await ref.transaction((current) => {
    const previous = current && typeof current === "object" ? current : null;
    if (!previous || !Number.isFinite(Number(previous.windowStartedAt)) || now - Number(previous.windowStartedAt) >= windowMs) {
      return {count: 1, windowStartedAt: now, lastSeenAt: now};
    }
    if (Number(previous.count || 0) >= limit) return;
    return {
      count: Number(previous.count || 0) + 1,
      windowStartedAt: Number(previous.windowStartedAt),
      lastSeenAt: now,
    };
  });
  if (!result.committed) {
    throw new HttpsError("resource-exhausted", "操作过于频繁，请稍后重试。", {reason: "RATE_LIMITED"});
  }
}

module.exports = {
  enforceRateLimit,
  hashKey,
  randomCode,
  randomToken,
  requireCancelCode,
  requireId,
  requireString,
  requireStudentName,
  requireYear,
  secureEqual,
};
