import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import {calcHours, parseChinaDateTime, parseSlot} from "../src/time.js";
import {requireStudentName, secureEqual} from "../src/security.js";

const env = {
  FIREBASE_PROJECT_ID: "class-optic",
  FIREBASE_PROJECT_NUMBER: "859111669333",
  FIREBASE_APP_ID: "1:859111669333:web:ec5cea5bd22dc0c495dedc",
  FIREBASE_DATABASE_URL: "https://class-optic-default-rtdb.asia-southeast1.firebasedatabase.app",
  ALLOWED_ORIGINS: "http://localhost:4173",
  CLIENT_CHALLENGE_ENABLED: "true",
};

test("worker rejects requests without App Check or the mainland compatibility challenge", async () => {
  const response = await worker.fetch(new Request("https://worker.test/createBooking", {
    method: "POST",
    headers: {origin: "http://localhost:4173", "content-type": "application/json"},
    body: "{}",
  }), env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.reason, "CLIENT_CHALLENGE_MISSING");
});

test("worker restricts unknown origins", async () => {
  const response = await worker.fetch(new Request("https://worker.test/createBooking", {
    method: "POST",
    headers: {origin: "https://evil.example", "content-type": "application/json"},
    body: "{}",
  }), env);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.reason, "ORIGIN_NOT_ALLOWED");
});

test("worker handles CORS preflight", async () => {
  const response = await worker.fetch(new Request("https://worker.test/createBooking", {
    method: "OPTIONS",
    headers: {origin: "http://localhost:4173"},
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:4173");
});

test("worker reuses booking time rules", () => {
  assert.equal(calcHours("9:00-10:30"), 1.5);
  assert.equal(parseSlot("2/29 09:00-10:00", "2026"), null);
  assert.equal(parseSlot("2/29 09:00-10:00", "2028").hours, 1);
  assert.equal(parseChinaDateTime("2026-08-20T10:00"), Date.parse("2026-08-20T10:00:00+08:00"));
});

test("worker validates student names and compares secrets", async () => {
  assert.equal(requireStudentName("张三"), "张三");
  assert.throws(() => requireStudentName("bad/name"));
  assert.equal(await secureEqual("same", "same"), true);
  assert.equal(await secureEqual("same", "other"), false);
});
