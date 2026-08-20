const STUDENT_NAME_PATTERN = /^[^.#$\/\[\]<>,\u0000-\u001F\u007F]{1,50}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const CANCEL_CODE_PATTERN = /^[A-Z2-9]{5}$/;

export class ApiError extends Error {
  constructor(status, message, reason = "", details = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

export function requireString(value, field, maxLength) {
  if (typeof value !== "string") throw new ApiError(400, `${field} 格式不合法。`, "INVALID_ARGUMENT");
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, `${field} 格式不合法。`, "INVALID_ARGUMENT");
  return normalized;
}

export function requireStudentName(value) {
  const name = requireString(value, "姓名", 50);
  if (!STUDENT_NAME_PATTERN.test(name)) throw new ApiError(400, "姓名格式不合法。", "INVALID_ARGUMENT");
  return name;
}

export function requireYear(value) {
  const year = requireString(String(value || ""), "学年", 4);
  if (!/^\d{4}$/.test(year)) throw new ApiError(400, "学年格式不合法。", "INVALID_ARGUMENT");
  return year;
}

export function requireId(value, field = "标识") {
  const id = requireString(value, field, 100);
  if (!ID_PATTERN.test(id)) throw new ApiError(400, `${field} 格式不合法。`, "INVALID_ARGUMENT");
  return id;
}

export function requireCancelCode(value) {
  const code = requireString(value, "取消凭证", 5).toUpperCase();
  if (!CANCEL_CODE_PATTERN.test(code)) throw new ApiError(400, "取消凭证格式不合法。", "INVALID_ARGUMENT");
  return code;
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hashKey(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}

export async function secureEqual(left, right) {
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(left))));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(right))));
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}

export function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export function randomId() {
  return randomToken(18);
}

export function requestIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim().slice(0, 128);
}
