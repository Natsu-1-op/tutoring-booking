let jwksCache = null;

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parsePart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getKeys() {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch("https://firebaseappcheck.googleapis.com/v1/jwks");
  if (!response.ok) throw new Error(`App Check public key request failed: ${response.status}`);
  const body = await response.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]));
  }
  jwksCache = {keys, expiresAt: Date.now() + 6 * 60 * 60 * 1000};
  return keys;
}

export async function verifyAppCheck(request, env) {
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
  const now = Math.floor(Date.now() / 1000);
  if (!projectNumber || payload.iss !== expectedIssuer || !audience.includes(`projects/${projectNumber}`) || !payload.sub || Number(payload.exp) <= now || Number(payload.iat) > now + 120) {
    throw new Error("APP_CHECK_INVALID");
  }
  if (env.FIREBASE_APP_ID && payload.sub !== env.FIREBASE_APP_ID) throw new Error("APP_CHECK_APP_MISMATCH");
  const keys = await getKeys();
  const key = keys.get(header.kid);
  if (!key) {
    jwksCache = null;
    throw new Error("APP_CHECK_KEY_UNKNOWN");
  }
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("APP_CHECK_INVALID");
  return payload.sub;
}
