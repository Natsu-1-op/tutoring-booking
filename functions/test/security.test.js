"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashKey,
  randomCode,
  randomToken,
  requireCancelCode,
  requireId,
  requireStudentName,
  secureEqual,
} = require("../lib/security");

test("student identifiers reject paths and markup", () => {
  assert.equal(requireStudentName(" 张三 "), "张三");
  assert.throws(() => requireStudentName("../张三"));
  assert.throws(() => requireStudentName("<script>"));
  assert.throws(() => requireId("bad/path", "时段"));
});

test("cancel codes are normalized and validated", () => {
  assert.equal(requireCancelCode("ab2cd"), "AB2CD");
  assert.throws(() => requireCancelCode("A1BCD"));
  assert.throws(() => requireCancelCode("ABCD"));
});

test("tokens and receipt codes use the expected alphabets", () => {
  assert.match(randomCode(12), /^[A-HJ-NP-Z2-9]{12}$/);
  assert.match(randomToken(), /^[A-Za-z0-9_-]{40,}$/);
});

test("constant-time comparison and hashes are deterministic", () => {
  assert.equal(secureEqual("same", "same"), true);
  assert.equal(secureEqual("same", "different"), false);
  assert.equal(hashKey("ticket"), hashKey("ticket"));
  assert.notEqual(hashKey("ticket"), hashKey("other"));
});
