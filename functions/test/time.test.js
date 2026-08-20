"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {calcHours, isValidCalendarDate, parseChinaDateTime, parseSlot} = require("../lib/time");

test("parseSlot normalizes supported slot text", () => {
  assert.deepEqual(parseSlot("2/9 0830-1000", "2028"), {
    rawTime: "2/9 08:30-10:00",
    date: "2028-02-09",
    startTime: "08:30",
    endTime: "10:00",
    formattedSlotText: "2/9 08:30-10:00",
    hours: 1.5,
  });
});

test("parseSlot rejects invalid dates and backwards ranges", () => {
  assert.equal(parseSlot("2/30 08:30-10:00", "2026"), null);
  assert.equal(parseSlot("3/2 10:00-08:30", "2026"), null);
  assert.equal(parseSlot("3/2 25:00-26:00", "2026"), null);
});

test("calendar validation handles leap years", () => {
  assert.equal(isValidCalendarDate(2, 29, 2028), true);
  assert.equal(isValidCalendarDate(2, 29, 2027), false);
});

test("calcHours accepts normalized and legacy compact formats", () => {
  assert.equal(calcHours("5/1 08:30-10:00"), 1.5);
  assert.equal(calcHours("0830-1000"), 1.5);
  assert.equal(calcHours("bad"), 0);
});

test("parseChinaDateTime interprets datetime-local values as UTC+8", () => {
  assert.equal(parseChinaDateTime("2026-08-20T17:30"), Date.parse("2026-08-20T17:30:00+08:00"));
  assert.equal(parseChinaDateTime("2026-08-20T09:30:00Z"), Date.parse("2026-08-20T09:30:00Z"));
  assert.equal(Number.isNaN(parseChinaDateTime("not-a-date")), true);
});
