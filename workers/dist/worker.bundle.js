// tutoring-booking/workers/src/app-check.js
var jwksCache = null;
function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function parsePart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}
async function getKeys(forceRefresh = false) {
  if (!forceRefresh && jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch("https://firebaseappcheck.googleapis.com/v1/jwks");
  if (!response.ok) throw new Error(`App Check public key request failed: ${response.status}`);
  const body = await response.json();
  const keys = /* @__PURE__ */ new Map();
  for (const jwk of body.keys || []) {
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  jwksCache = { keys, expiresAt: Date.now() + 6 * 60 * 60 * 1e3 };
  return keys;
}
async function verifyAppCheck(request, env) {
  const token = request.headers.get("X-Firebase-AppCheck");
  if (!token) throw new Error("APP_CHECK_MISSING");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("APP_CHECK_INVALID");
  const header = parsePart(parts[0]);
  const payload = parsePart(parts[1]);
  if (header.alg !== "RS256" || header.typ !== "JWT" || !header.kid) throw new Error("APP_CHECK_INVALID");
  const projectNumber = String(env.FIREBASE_PROJECT_NUMBER || "");
  const expectedIssuer = `https://firebaseappcheck.googleapis.com/${projectNumber}`;
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Math.floor(Date.now() / 1e3);
  const expiresAt = Number(payload.exp);
  const issuedAt = Number(payload.iat);
  if (!projectNumber || payload.iss !== expectedIssuer || !audience.includes(`projects/${projectNumber}`) || !payload.sub || !Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || expiresAt <= now || issuedAt > now + 120) {
    throw new Error("APP_CHECK_INVALID");
  }
  if (env.FIREBASE_APP_ID && payload.sub !== env.FIREBASE_APP_ID) throw new Error("APP_CHECK_APP_MISMATCH");
  let keys = await getKeys();
  let key = keys.get(header.kid);
  if (!key) {
    keys = await getKeys(true);
    key = keys.get(header.kid);
    if (!key) throw new Error("APP_CHECK_KEY_UNKNOWN");
  }
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("APP_CHECK_INVALID");
  return payload.sub;
}

// tutoring-booking/workers/src/firebase.js
var accessTokenCache = null;
var signingKeyPromise = null;
function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function importServiceAccountKey(env) {
  const pem = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!body || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error("Cloudflare Worker \u5C1A\u672A\u914D\u7F6E Firebase \u670D\u52A1\u8D26\u53F7\u5BC6\u94A5\u3002");
  return crypto.subtle.importKey(
    "pkcs8",
    base64UrlDecode(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
async function getServiceAccountToken(env) {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 6e4) return accessTokenCache.value;
  if (!signingKeyPromise) signingKeyPromise = importServiceAccountKey(env);
  const key = await signingKeyPromise;
  const now = Math.floor(Date.now() / 1e3);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64UrlEncode(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64UrlEncode(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  if (!response.ok) throw new Error(`Google OAuth token request failed: ${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("Google OAuth response did not contain an access token.");
  accessTokenCache = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1e3 };
  return body.access_token;
}
function encodePath(path) {
  return String(path || "").split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}
function databaseUrl(env, path, query = {}) {
  const base = String(env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Cloudflare Worker \u5C1A\u672A\u914D\u7F6E FIREBASE_DATABASE_URL\u3002");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, JSON.stringify(value));
  const queryString = params.toString();
  return `${base}/${encodePath(path)}.json${queryString ? `?${queryString}` : ""}`;
}
async function requestDatabase(env, path, options = {}) {
  const token = await getServiceAccountToken(env);
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  if (options.body !== void 0) headers.set("content-type", "application/json");
  const response = await fetch(databaseUrl(env, path, options.query), {
    method: options.method || "GET",
    headers,
    body: options.body === void 0 ? void 0 : JSON.stringify(options.body)
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Realtime Database request failed: ${response.status}`);
    error.status = response.status;
    error.body = text.slice(0, 500);
    throw error;
  }
  return response;
}
async function dbGet(env, path, { query = {}, etag = false } = {}) {
  const response = await requestDatabase(env, path, { query, headers: etag ? { "X-Firebase-ETag": "true" } : {} });
  return { value: await response.json(), etag: response.headers.get("ETag") };
}
async function dbPut(env, path, value, { ifMatch = "" } = {}) {
  const headers = ifMatch ? { "if-match": ifMatch } : {};
  const response = await requestDatabase(env, path, { method: "PUT", body: value, headers });
  return response.json();
}
async function dbPatch(env, path, value) {
  const response = await requestDatabase(env, path, { method: "PATCH", body: value });
  return response.json();
}
async function dbDelete(env, path) {
  return dbPut(env, path, null);
}
async function dbTransaction(env, path, updater, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await dbGet(env, path, { etag: true });
    const next = await updater(current.value);
    if (next === void 0) return { committed: false, value: current.value };
    try {
      await dbPut(env, path, next, { ifMatch: current.etag || "null_etag" });
      return { committed: true, value: next };
    } catch (error) {
      if (error.status === 412) continue;
      throw error;
    }
  }
  return { committed: false, value: null };
}

// tutoring-booking/workers/src/security.js
var STUDENT_NAME_PATTERN = /^[^.#$\/\[\]<>,\u0000-\u001F\u007F]{1,50}$/;
var ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
var CANCEL_CODE_PATTERN = /^[A-Z2-9]{5}$/;
var ApiError = class extends Error {
  constructor(status, message, reason = "", details = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
};
function requireString(value, field, maxLength) {
  if (typeof value !== "string") throw new ApiError(400, `${field} \u683C\u5F0F\u4E0D\u5408\u6CD5\u3002`, "INVALID_ARGUMENT");
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, `${field} \u683C\u5F0F\u4E0D\u5408\u6CD5\u3002`, "INVALID_ARGUMENT");
  return normalized;
}
function requireStudentName(value) {
  const name = requireString(value, "\u59D3\u540D", 50);
  if (!STUDENT_NAME_PATTERN.test(name)) throw new ApiError(400, "\u59D3\u540D\u683C\u5F0F\u4E0D\u5408\u6CD5\u3002", "INVALID_ARGUMENT");
  return name;
}
function requireYear(value) {
  const year = requireString(String(value || ""), "\u5B66\u5E74", 4);
  if (!/^\d{4}$/.test(year)) throw new ApiError(400, "\u5B66\u5E74\u683C\u5F0F\u4E0D\u5408\u6CD5\u3002", "INVALID_ARGUMENT");
  return year;
}
function requireId(value, field = "\u6807\u8BC6") {
  const id = requireString(value, field, 100);
  if (!ID_PATTERN.test(id)) throw new ApiError(400, `${field} \u683C\u5F0F\u4E0D\u5408\u6CD5\u3002`, "INVALID_ARGUMENT");
  return id;
}
function requireCancelCode(value) {
  const code = requireString(value, "\u53D6\u6D88\u51ED\u8BC1", 5).toUpperCase();
  if (!CANCEL_CODE_PATTERN.test(code)) throw new ApiError(400, "\u53D6\u6D88\u51ED\u8BC1\u683C\u5F0F\u4E0D\u5408\u6CD5\u3002", "INVALID_ARGUMENT");
  return code;
}
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function hashKey(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
}
async function secureEqual(left, right) {
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(left))));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(right))));
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}
function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken(bytes = 32) {
  return base64Url(randomBytes(bytes));
}
function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}
function randomId() {
  return randomToken(18);
}
function requestIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim().slice(0, 128);
}

// tutoring-booking/workers/src/time.js
function isValidCalendarDate(month, day, year) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (month === 2) {
    const leap = year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
    return day <= (leap ? 29 : 28);
  }
  if ([4, 6, 9, 11].includes(month)) return day <= 30;
  return true;
}
function parseSlot(rawText, targetYear) {
  if (typeof rawText !== "string" || !/^\d{4}$/.test(String(targetYear))) return null;
  const match = rawText.trim().match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):?(\d{2})-(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const values2 = match.slice(1).map((value) => Number.parseInt(value, 10));
  const [month, day, startHour, startMinute, endHour, endMinute] = values2;
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  if (endHour * 60 + endMinute <= startHour * 60 + startMinute) return null;
  if (!isValidCalendarDate(month, day, Number(targetYear))) return null;
  const pad = (value) => String(value).padStart(2, "0");
  return {
    rawTime: `${month}/${day} ${pad(startHour)}:${pad(startMinute)}-${pad(endHour)}:${pad(endMinute)}`,
    date: `${targetYear}-${pad(month)}-${pad(day)}`,
    startTime: `${pad(startHour)}:${pad(startMinute)}`,
    endTime: `${pad(endHour)}:${pad(endMinute)}`,
    formattedSlotText: `${month}/${day} ${pad(startHour)}:${pad(startMinute)}-${pad(endHour)}:${pad(endMinute)}`,
    hours: (endHour * 60 + endMinute - startHour * 60 - startMinute) / 60
  };
}
function calcHours(rawText) {
  if (typeof rawText !== "string") return 0;
  const match = rawText.trim().match(/^(?:\d{1,2}\/\d{1,2}\s+)?(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})$/);
  if (!match) return 0;
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map((value) => Number.parseInt(value, 10));
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return 0;
  const minutes = endHour * 60 + endMinute - startHour * 60 - startMinute;
  return minutes > 0 ? minutes / 60 : 0;
}
function parseChinaDateTime(value) {
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const normalized = value.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    return (/* @__PURE__ */ new Date(`${normalized}+08:00`)).getTime();
  }
  return new Date(normalized).getTime();
}

// tutoring-booking/workers/src/index.js
function values(object) {
  return object && typeof object === "object" ? Object.values(object) : [];
}
function whitelistContains(whitelist, nickname) {
  return values(whitelist).some((entry) => entry === nickname || entry && typeof entry === "object" && entry.name === nickname && entry.enabled !== false);
}
async function requireActiveYear(env, inputYear) {
  const year = requireYear(inputYear);
  const snapshot = await dbGet(env, "system/activeYear");
  const activeYear = String(snapshot.value || "");
  if (!/^\d{4}$/.test(activeYear) || year !== activeYear) {
    throw new ApiError(412, "\u5F53\u524D\u5F00\u653E\u5B66\u5E74\u5DF2\u7ECF\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002", "YEAR_CHANGED");
  }
  return year;
}
async function verifyAccessCode(env, year, suppliedCode) {
  const supplied = requireString(suppliedCode, "\u9884\u7EA6\u53E3\u4EE4", 128);
  const snapshot = await dbGet(env, `years/${year}/settings/accessCode`);
  const configured = snapshot.value;
  if (typeof configured !== "string" || configured.length < 4) {
    throw new ApiError(412, "\u5F53\u524D\u5B66\u5E74\u5C1A\u672A\u914D\u7F6E\u9884\u7EA6\u53E3\u4EE4\uFF0C\u8BF7\u8054\u7CFB\u8001\u5E08\u3002", "ACCESS_CODE_NOT_CONFIGURED");
  }
  if (!await secureEqual(supplied, configured)) throw new ApiError(403, "\u9884\u7EA6\u53E3\u4EE4\u9519\u8BEF\u3002", "ACCESS_CODE_INVALID");
}
async function requireWhitelistedStudent(env, year, nickname) {
  const snapshot = await dbGet(env, `years/${year}/studentWhitelist`);
  if (!whitelistContains(snapshot.value, nickname)) throw new ApiError(403, "\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u59D3\u540D\u6216\u8054\u7CFB\u8001\u5E08\u3002", "STUDENT_NOT_ALLOWED");
}
async function enforceRateLimit(env, request, bucket, { limit = 10, windowMs = 10 * 60 * 1e3, subject = "global" } = {}) {
  const identifier = await hashKey(`${bucket}|${requestIp(request)}|${subject}`);
  const result = await dbTransaction(env, `privateRuntime/rateLimits/${bucket}/${identifier}`, (current) => {
    const now = Date.now();
    const previous = current && typeof current === "object" ? current : null;
    if (!previous || !Number.isFinite(Number(previous.windowStartedAt)) || now - Number(previous.windowStartedAt) >= windowMs) {
      return { count: 1, windowStartedAt: now, lastSeenAt: now };
    }
    if (Number(previous.count || 0) >= limit) return;
    return { count: Number(previous.count || 0) + 1, windowStartedAt: Number(previous.windowStartedAt), lastSeenAt: now };
  });
  if (!result.committed) throw new ApiError(429, "\u64CD\u4F5C\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", "RATE_LIMITED");
}
var CLIENT_CHALLENGE_DIFFICULTY = 3;
var CLIENT_CHALLENGE_TTL_MS = 2 * 60 * 1e3;
async function createClientChallenge(env, request) {
  if (String(env.CLIENT_CHALLENGE_ENABLED || "false") !== "true") {
    throw new ApiError(503, "\u5F53\u524D\u5B89\u5168\u6821\u9A8C\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", "CLIENT_CHALLENGE_DISABLED");
  }
  await enforceRateLimit(env, request, "clientChallenge", { limit: 12 });
  const id = randomToken(18);
  const salt = randomToken(18);
  const expiresAt = Date.now() + CLIENT_CHALLENGE_TTL_MS;
  await dbPut(env, `privateRuntime/clientChallenges/${id}`, {
    salt,
    expiresAt,
    ipHash: await hashKey(requestIp(request)),
    createdAt: Date.now()
  });
  return { id, salt, difficulty: CLIENT_CHALLENGE_DIFFICULTY, expiresAt };
}
async function verifyClientChallenge(env, request) {
  if (String(env.CLIENT_CHALLENGE_ENABLED || "false") !== "true") throw new Error("APP_CHECK_MISSING");
  const id = request.headers.get("X-Student-Challenge-Id");
  const nonce = request.headers.get("X-Student-Challenge-Nonce");
  if (!id || !/^[A-Za-z0-9_-]{10,100}$/.test(id) || !nonce || !/^\d{1,7}$/.test(nonce)) throw new Error("CLIENT_CHALLENGE_MISSING");
  await enforceRateLimit(env, request, "clientChallengeVerify", { limit: 30 });
  const path = `privateRuntime/clientChallenges/${id}`;
  const snapshot = await dbGet(env, path);
  const challenge = snapshot.value;
  if (!challenge || Number(challenge.expiresAt || 0) <= Date.now() || challenge.usedAt) throw new Error("CLIENT_CHALLENGE_INVALID");
  if (challenge.ipHash !== await hashKey(requestIp(request))) throw new Error("CLIENT_CHALLENGE_INVALID");
  const digest = await hashKey(`${id}.${challenge.salt}.${nonce}`);
  if (!digest.startsWith("0".repeat(CLIENT_CHALLENGE_DIFFICULTY))) throw new Error("CLIENT_CHALLENGE_INVALID");
  const consumed = await dbTransaction(env, path, (current) => {
    if (!current || current.usedAt || Number(current.expiresAt || 0) <= Date.now()) return;
    return { ...current, usedAt: Date.now() };
  });
  if (!consumed.committed) throw new Error("CLIENT_CHALLENGE_REPLAYED");
  await dbDelete(env, path).catch(() => null);
}
async function cleanupExpiredSessions(env, path) {
  const snapshot = await dbGet(env, path, { query: { orderBy: "expiresAt", endAt: Date.now(), limitToFirst: 25 } });
  const updates = {};
  for (const key of Object.keys(snapshot.value || {})) updates[key] = null;
  if (Object.keys(updates).length) await dbPatch(env, path, updates);
}
function reservationLessonTimestamp(reservation, year) {
  const parsed = parseSlot(reservation && reservation.time, year);
  if (!parsed) return Number(reservation && reservation.timestamp || 0);
  return (/* @__PURE__ */ new Date(`${parsed.date}T${parsed.startTime}:00+08:00`)).getTime();
}
function publicReservation(id, reservation) {
  return {
    id,
    nickname: String(reservation.nickname || ""),
    time: String(reservation.time || ""),
    status: String(reservation.status || "booked"),
    cancelCode: String(reservation.cancelCode || ""),
    timestamp: Number(reservation.timestamp || 0)
  };
}
async function createBooking(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const nickname = requireStudentName(data.nickname);
  const slotId = requireId(data.slotId, "\u65F6\u6BB5");
  await enforceRateLimit(env, request, "createBookingGlobal", { limit: 30 });
  await enforceRateLimit(env, request, "createBooking", { limit: 12, subject: await hashKey(nickname) });
  await verifyAccessCode(env, year, data.accessCode);
  await requireWhitelistedStudent(env, year, nickname);
  const deadlineSnapshot = await dbGet(env, `years/${year}/settings/deadline`);
  const deadlineMs = parseChinaDateTime(deadlineSnapshot.value);
  if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) throw new ApiError(412, "\u672C\u8F6E\u9884\u7EA6\u5DF2\u622A\u6B62\u3002", "BOOKING_CLOSED");
  const [slotSnapshot, existingSnapshot, hoursSnapshot] = await Promise.all([
    dbGet(env, `years/${year}/slots/${slotId}`),
    dbGet(env, `years/${year}/reservations`, { query: { orderBy: "nickname", equalTo: nickname } }),
    dbGet(env, `years/${year}/studentHours/${nickname}`)
  ]);
  const slot = slotSnapshot.value;
  const parsedSlot = parseSlot(slot && slot.time, year);
  if (!slot || slot.status === "hidden" || slot.reserved || !parsedSlot) throw new ApiError(409, "\u8BE5\u65F6\u95F4\u6BB5\u5DF2\u4E0D\u53EF\u9884\u7EA6\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002", "SLOT_UNAVAILABLE");
  const existing = existingSnapshot.value || {};
  const activeReservations = values(existing).filter((reservation2) => reservation2 && reservation2.status !== "canceled");
  const hasSameDay = activeReservations.some((reservation2) => {
    const parsed = parseSlot(reservation2.time, year);
    return parsed && parsed.date === parsedSlot.date;
  });
  if (hasSameDay && data.confirmSameDay !== true) {
    throw new ApiError(412, "\u5F53\u5929\u5DF2\u6709\u5176\u4ED6\u9884\u7EA6\uFF0C\u8BF7\u786E\u8BA4\u540E\u91CD\u8BD5\u3002", "SAME_DAY_CONFIRMATION_REQUIRED", { date: parsedSlot.date });
  }
  const usedHours = activeReservations.reduce((total, reservation2) => total + calcHours(reservation2.time), 0);
  const totalHours = Number(hoursSnapshot.value);
  if (Number.isFinite(totalHours) && totalHours > 0 && usedHours + parsedSlot.hours > totalHours + 1e-9) {
    throw new ApiError(412, "\u5269\u4F59\u8BFE\u65F6\u4E0D\u8DB3\uFF0C\u65E0\u6CD5\u9884\u7EA6\u8BE5\u65F6\u6BB5\u3002", "INSUFFICIENT_HOURS", { slotHours: parsedSlot.hours, remainingHours: Math.max(0, totalHours - usedHours) });
  }
  const reservationId = randomId();
  const claim = await dbTransaction(env, `years/${year}/slots/${slotId}`, (current) => {
    if (!current || current.reserved || current.status === "hidden") return;
    const currentParsed = parseSlot(current.time, year);
    if (!currentParsed || currentParsed.formattedSlotText !== parsedSlot.formattedSlotText) return;
    return { ...current, reserved: true, reservationId };
  });
  if (!claim.committed) throw new ApiError(409, "\u8BE5\u65F6\u95F4\u6BB5\u521A\u521A\u88AB\u5176\u4ED6\u540C\u5B66\u9884\u7EA6\u3002", "SLOT_UNAVAILABLE");
  const cancelCode = randomCode(5);
  const logId = randomId();
  const now = Date.now();
  const reservation = {
    nickname,
    slotId,
    reservationId,
    time: parsedSlot.formattedSlotText,
    status: "booked",
    cancelCode,
    slotSnapshot: { rawTime: parsedSlot.rawTime, date: parsedSlot.date, startTime: parsedSlot.startTime, endTime: parsedSlot.endTime, formattedSlotText: parsedSlot.formattedSlotText },
    timestamp: now
  };
  try {
    await dbPatch(env, "", {
      [`years/${year}/reservations/${reservationId}`]: reservation,
      [`years/${year}/operationLog/${logId}`]: { action: `\u5B66\u751F [${nickname}] \u9884\u7EA6\u6210\u529F: [${parsedSlot.formattedSlotText}]`, source: "student-api-worker", timestamp: now }
    });
  } catch (error) {
    await dbTransaction(env, `years/${year}/slots/${slotId}`, (current) => {
      if (!current || current.reservationId !== reservationId) return;
      const released = { ...current, reserved: false };
      delete released.reservationId;
      return released;
    }).catch(() => null);
    console.error("Failed to persist reservation", error);
    throw new ApiError(500, "\u9884\u7EA6\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", "BOOKING_SAVE_FAILED");
  }
  return { nickname, time: parsedSlot.formattedSlotText, cancelCode, slotSnapshot: reservation.slotSnapshot, reservationId };
}
async function getBookingHistory(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const nickname = requireStudentName(data.nickname);
  const cancelCode = requireCancelCode(data.cancelCode);
  await enforceRateLimit(env, request, "getBookingHistoryGlobal", { limit: 30 });
  await enforceRateLimit(env, request, "getBookingHistory", { limit: 8, subject: await hashKey(nickname) });
  const snapshot = await dbGet(env, `years/${year}/reservations`, { query: { orderBy: "nickname", equalTo: nickname } });
  const reservations = snapshot.value || {};
  const authenticated = (await Promise.all(values(reservations).map(async (reservation) => reservation && await secureEqual(String(reservation.cancelCode || "").toUpperCase(), cancelCode)))).some(Boolean);
  if (!authenticated) throw new ApiError(403, "\u59D3\u540D\u6216\u51ED\u8BC1\u7801\u9519\u8BEF\u3002", "HISTORY_AUTH_FAILED");
  const list = Object.entries(reservations).filter(([, reservation]) => reservation && reservation.nickname === nickname).map(([id, reservation]) => ({ ...publicReservation(id, reservation), lessonTimestamp: reservationLessonTimestamp(reservation, year) })).sort((left, right) => right.lessonTimestamp - left.lessonTimestamp).map(({ lessonTimestamp: _lessonTimestamp, ...reservation }) => reservation);
  const usedHours = list.filter((reservation) => reservation.status !== "canceled").reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const completedHours = list.filter((reservation) => reservation.status === "completed").reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const totalHoursSnapshot = await dbGet(env, `years/${year}/studentHours/${nickname}`);
  const totalHoursValue = Number(totalHoursSnapshot.value);
  const totalHours = Number.isFinite(totalHoursValue) && totalHoursValue > 0 ? totalHoursValue : null;
  const sessionToken = randomToken();
  const expiresAt = Date.now() + 15 * 60 * 1e3;
  await cleanupExpiredSessions(env, "privateRuntime/historySessions");
  await dbPut(env, `privateRuntime/historySessions/${await hashKey(sessionToken)}`, { year, nickname, expiresAt, createdAt: Date.now() });
  return { reservations: list, sessionToken, expiresAt, summary: { completedHours, usedHours, totalHours, remainingHours: totalHours === null ? null : Math.max(0, totalHours - usedHours) } };
}
async function cancelBooking(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const reservationId = requireId(data.reservationId, "\u9884\u7EA6\u8BB0\u5F55");
  const sessionToken = requireString(data.sessionToken, "\u67E5\u8BE2\u4F1A\u8BDD", 200);
  await enforceRateLimit(env, request, "cancelBookingGlobal", { limit: 30 });
  await enforceRateLimit(env, request, "cancelBooking", { limit: 10, subject: await hashKey(reservationId) });
  const sessionPath = `privateRuntime/historySessions/${await hashKey(sessionToken)}`;
  const sessionSnapshot = await dbGet(env, sessionPath);
  const session = sessionSnapshot.value;
  if (!session || session.year !== year || Number(session.expiresAt || 0) < Date.now()) {
    if (session) await dbDelete(env, sessionPath).catch(() => null);
    throw new ApiError(401, "\u67E5\u8BE2\u51ED\u8BC1\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u9A8C\u8BC1\u5386\u53F2\u8BB0\u5F55\u3002", "HISTORY_SESSION_EXPIRED");
  }
  const reservationPath = `years/${year}/reservations/${reservationId}`;
  let original = null;
  const canceled = await dbTransaction(env, reservationPath, (current) => {
    if (!current || current.nickname !== session.nickname || !["booked", "confirmed"].includes(current.status)) return;
    original = current;
    return { ...current, status: "canceled", canceledAt: Date.now() };
  });
  if (!canceled.committed || !original) throw new ApiError(412, "\u8BE5\u9884\u7EA6\u5DF2\u65E0\u6CD5\u53D6\u6D88\uFF0C\u8BF7\u5237\u65B0\u5386\u53F2\u8BB0\u5F55\u3002", "RESERVATION_NOT_CANCELABLE");
  let slotReleased = true;
  if (original.slotId) {
    try {
      const release = await dbTransaction(env, `years/${year}/slots/${original.slotId}`, (current) => {
        if (!current || !current.reserved || current.reservationId !== reservationId) return;
        const next = { ...current, reserved: false };
        delete next.reservationId;
        return next;
      });
      slotReleased = release.committed;
      await dbDelete(env, `emergencySlotClaims/${year}/${original.slotId}`).catch(() => null);
    } catch (error) {
      slotReleased = false;
      console.error("Failed to release canceled slot", error);
    }
  }
  await dbPut(env, `years/${year}/operationLog/${randomId()}`, { action: `\u5B66\u751F [${original.nickname}] \u81EA\u884C\u53D6\u6D88\u4E86\u9884\u7EA6: [${original.time}]`, source: "student-api-worker", slotReleased, timestamp: Date.now() }).catch((error) => console.error("Failed to write cancellation log", error));
  return { canceled: true, slotReleased };
}
async function startExam(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const studentName = requireStudentName(data.studentName);
  const paperTitle = requireString(data.paperTitle, "\u8BD5\u5377\u540D\u79F0", 200);
  const examId = requireId(data.examId, "\u8BD5\u5377\u767B\u8BB0");
  const examTicket = requireString(data.examTicket, "\u8BD5\u5377\u7968\u636E", 200);
  await enforceRateLimit(env, request, "startExamGlobal", { limit: 30 });
  await enforceRateLimit(env, request, "startExam", { limit: 8, subject: await hashKey(`${examId}|${studentName}`) });
  await verifyAccessCode(env, year, data.accessCode);
  await requireWhitelistedStudent(env, year, studentName);
  const definitionSnapshot = await dbGet(env, `examDefinitions/${examId}`);
  const definition = definitionSnapshot.value;
  if (!definition || definition.active !== true || typeof definition.ticketHash !== "string" || !await secureEqual(await hashKey(examTicket), definition.ticketHash) || definition.paperTitle !== paperTitle) {
    throw new ApiError(403, "\u8BD5\u5377\u672A\u767B\u8BB0\u3001\u5DF2\u505C\u7528\u6216\u5B89\u5168\u7968\u636E\u65E0\u6548\u3002", "EXAM_NOT_REGISTERED");
  }
  const startAt = parseChinaDateTime(definition.startTime);
  const endAt = parseChinaDateTime(definition.endTime);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 24 * 60 * 60 * 1e3) throw new ApiError(400, "\u8003\u8BD5\u65F6\u95F4\u7A97\u53E3\u4E0D\u5408\u6CD5.", "INVALID_ARGUMENT");
  const lockPath = `submittedExamLocks/${examId}/${studentName}`;
  const lockSnapshot = await dbGet(env, lockPath);
  const lock = lockSnapshot.value;
  if (typeof lock === "number" || lock && lock.status === "submitted") return { status: "submitted", receiptId: lock && lock.receiptId || "\u5386\u53F2\u8BB0\u5F55", submittedAt: lock && lock.submittedAt || null };
  const now = Date.now();
  if (now < startAt) throw new ApiError(412, "\u8003\u8BD5\u5C1A\u672A\u5F00\u59CB\u3002", "EXAM_NOT_STARTED");
  if (now > endAt) throw new ApiError(412, "\u8003\u8BD5\u5DF2\u7ECF\u622A\u6B62\u3002", "EXAM_ENDED");
  const sessionToken = randomToken();
  const expiresAt = Math.min(endAt + 2 * 60 * 60 * 1e3, now + 26 * 60 * 60 * 1e3);
  await cleanupExpiredSessions(env, "privateRuntime/examSessions");
  await dbPut(env, `privateRuntime/examSessions/${await hashKey(sessionToken)}`, { year, examId, studentName, paperTitle, startAt, endAt, expiresAt, createdAt: now });
  return { status: "ready", sessionToken, expiresAt, startTime: definition.startTime, endTime: definition.endTime };
}
async function submitExam(env, request, data) {
  const sessionToken = requireString(data.sessionToken, "\u8003\u8BD5\u4F1A\u8BDD", 200);
  await enforceRateLimit(env, request, "submitExamGlobal", { limit: 30 });
  const sessionPath = `privateRuntime/examSessions/${await hashKey(sessionToken)}`;
  const sessionSnapshot = await dbGet(env, sessionPath);
  const session = sessionSnapshot.value;
  if (!session || Number(session.expiresAt || 0) < Date.now()) {
    if (session) await dbDelete(env, sessionPath).catch(() => null);
    throw new ApiError(401, "\u8003\u8BD5\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF0C\u8BF7\u4FDD\u7559\u7B54\u6848\u5E76\u91CD\u65B0\u9A8C\u8BC1\u3002", "EXAM_SESSION_EXPIRED");
  }
  await enforceRateLimit(env, request, "submitExam", { limit: 5, subject: await hashKey(`${session.examId}|${session.studentName}`) });
  const lockPath = `submittedExamLocks/${session.examId}/${session.studentName}`;
  const receiptId = `EX-${randomCode(6)}-${randomCode(6)}`;
  const submittedAt = Date.now();
  const sessionHash = await hashKey(sessionToken);
  const result = await dbTransaction(env, lockPath, (current) => {
    if (typeof current === "number" || current && current.status === "submitted") return;
    return { status: "submitted", receiptId, submittedAt, createdAt: Number(session.createdAt || submittedAt), sessionHash };
  });
  if (!result.committed) {
    const existing = result.value;
    throw new ApiError(409, "\u8BE5\u8BD5\u5377\u5DF2\u7ECF\u4EA4\u5377\u3002", "EXAM_ALREADY_SUBMITTED", { receiptId: existing && existing.receiptId || "\u5386\u53F2\u8BB0\u5F55", submittedAt: existing && existing.submittedAt || null });
  }
  await dbDelete(env, sessionPath).catch(() => null);
  return { receiptId, submittedAt };
}
function originFor(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (origin && allowed.length && !allowed.includes(origin)) return null;
  return origin || allowed[0] || "*";
}
function jsonResponse(body, status, request, env) {
  const origin = originFor(request, env);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = "content-type, x-firebase-appcheck, x-student-challenge-id, x-student-challenge-nonce";
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}
var index_default = {
  async fetch(request, env) {
    const origin = originFor(request, env);
    if (!origin) return jsonResponse({ error: { message: "\u8BF7\u6C42\u6765\u6E90\u4E0D\u88AB\u5141\u8BB8\u3002", reason: "ORIGIN_NOT_ALLOWED" } }, 403, request, env);
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname.endsWith("/health")) return jsonResponse({ ok: true, service: "tutoring-booking-api" }, 200, request, env);
    if (request.method === "GET" && pathname.endsWith("/challenge")) {
      try {
        return jsonResponse({ data: await createClientChallenge(env, request) }, 200, request, env);
      } catch (error) {
        if (error instanceof ApiError) return jsonResponse({ error: { message: error.message, reason: error.reason, details: error.details } }, error.status, request, env);
        console.error(error);
        return jsonResponse({ error: { message: "\u5B89\u5168\u6821\u9A8C\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", reason: "CLIENT_CHALLENGE_FAILED" } }, 503, request, env);
      }
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, x-firebase-appcheck, x-student-challenge-id, x-student-challenge-nonce", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400", vary: "Origin" } });
    if (request.method !== "POST") return jsonResponse({ error: { message: "\u53EA\u652F\u6301 POST \u8BF7\u6C42\u3002", reason: "METHOD_NOT_ALLOWED" } }, 405, request, env);
    try {
      const data = await request.json();
      if (request.headers.get("X-Firebase-AppCheck")) await verifyAppCheck(request, env);
      else await verifyClientChallenge(env, request);
      const name = pathname.split("/").filter(Boolean).pop();
      let result;
      if (name === "createBooking") result = await createBooking(env, request, data || {});
      else if (name === "getBookingHistory") result = await getBookingHistory(env, request, data || {});
      else if (name === "cancelBooking") result = await cancelBooking(env, request, data || {});
      else if (name === "startExam") result = await startExam(env, request, data || {});
      else if (name === "submitExam") result = await submitExam(env, request, data || {});
      else return jsonResponse({ error: { message: "\u63A5\u53E3\u4E0D\u5B58\u5728\u3002", reason: "NOT_FOUND" } }, 404, request, env);
      return jsonResponse({ data: result }, 200, request, env);
    } catch (error) {
      if (error instanceof ApiError) return jsonResponse({ error: { message: error.message, reason: error.reason, details: error.details } }, error.status, request, env);
      if (/^(APP_CHECK|CLIENT_CHALLENGE)_/.test(String(error && error.message))) return jsonResponse({ error: { message: "\u5B89\u5168\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002", reason: error.message } }, 403, request, env);
      console.error(error);
      return jsonResponse({ error: { message: "\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", reason: "INTERNAL" } }, 500, request, env);
    }
  }
};
export {
  index_default as default
};
