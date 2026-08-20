"use strict";

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
  const values = match.slice(1).map((value) => Number.parseInt(value, 10));
  const [month, day, startHour, startMinute, endHour, endMinute] = values;
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
    hours: (endHour * 60 + endMinute - startHour * 60 - startMinute) / 60,
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
  // datetime-local 没有时区；系统面向中国境内使用，按 UTC+8 解释，避免 Functions 的 UTC 运行环境造成 8 小时偏移。
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    return new Date(`${normalized}+08:00`).getTime();
  }
  return new Date(normalized).getTime();
}

module.exports = {calcHours, isValidCalendarDate, parseChinaDateTime, parseSlot};
