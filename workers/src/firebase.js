let accessTokenCache = null;
let signingKeyPromise = null;

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

function parseJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

async function importServiceAccountKey(env) {
  const pem = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!body || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL) throw new Error("Cloudflare Worker 尚未配置 Firebase 服务账号密钥。");
  return crypto.subtle.importKey(
    "pkcs8",
    base64UrlDecode(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")),
    {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"},
    false,
    ["sign"],
  );
}

async function getServiceAccountToken(env) {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) return accessTokenCache.value;
  if (!signingKeyPromise) signingKeyPromise = importServiceAccountKey(env);
  const key = await signingKeyPromise;
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const claim = base64UrlEncode(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64UrlEncode(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion}),
  });
  if (!response.ok) throw new Error(`Google OAuth token request failed: ${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("Google OAuth response did not contain an access token.");
  accessTokenCache = {value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000};
  return body.access_token;
}

function encodePath(path) {
  return String(path || "").split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function databaseUrl(env, path, query = {}) {
  const base = String(env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Cloudflare Worker 尚未配置 FIREBASE_DATABASE_URL。");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, JSON.stringify(value));
  const queryString = params.toString();
  return `${base}/${encodePath(path)}.json${queryString ? `?${queryString}` : ""}`;
}

async function requestDatabase(env, path, options = {}) {
  const token = await getServiceAccountToken(env);
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(databaseUrl(env, path, options.query), {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

export async function dbGet(env, path, {query = {}, etag = false} = {}) {
  const response = await requestDatabase(env, path, {query, headers: etag ? {"X-Firebase-ETag": "true"} : {}});
  return {value: await response.json(), etag: response.headers.get("ETag")};
}

export async function dbPut(env, path, value, {ifMatch = ""} = {}) {
  const headers = ifMatch ? {"if-match": ifMatch} : {};
  const response = await requestDatabase(env, path, {method: "PUT", body: value, headers});
  return response.json();
}

export async function dbPatch(env, path, value) {
  const response = await requestDatabase(env, path, {method: "PATCH", body: value});
  return response.json();
}

export async function dbDelete(env, path) {
  return dbPut(env, path, null);
}

export async function dbTransaction(env, path, updater, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await dbGet(env, path, {etag: true});
    const next = await updater(current.value);
    if (next === undefined) return {committed: false, value: current.value};
    try {
      await dbPut(env, path, next, {ifMatch: current.etag || "null_etag"});
      return {committed: true, value: next};
    } catch (error) {
      if (error.status === 412) continue;
      throw error;
    }
  }
  return {committed: false, value: null};
}
