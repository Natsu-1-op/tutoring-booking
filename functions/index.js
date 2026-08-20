"use strict";

const {initializeApp} = require("firebase-admin/app");
const {getDatabase, ServerValue} = require("firebase-admin/database");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {
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
} = require("./lib/security");
const {calcHours, parseChinaDateTime, parseSlot} = require("./lib/time");

initializeApp();
const database = getDatabase();
const REGION = "asia-southeast1";
const CALLABLE_OPTIONS = {
  region: REGION,
  enforceAppCheck: true,
  timeoutSeconds: 30,
  memory: "256MiB",
  maxInstances: 20,
};

function values(object) {
  return object && typeof object === "object" ? Object.values(object) : [];
}

function whitelistContains(whitelist, nickname) {
  return values(whitelist).some((entry) => entry === nickname || entry && typeof entry === "object" && entry.name === nickname && entry.enabled !== false);
}

async function requireActiveYear(inputYear) {
  const year = requireYear(inputYear);
  const snapshot = await database.ref("system/activeYear").get();
  const activeYear = String(snapshot.val() || "");
  if (!/^\d{4}$/.test(activeYear) || year !== activeYear) {
    throw new HttpsError("failed-precondition", "当前开放学年已经变化，请刷新页面后重试。", {reason: "YEAR_CHANGED"});
  }
  return year;
}

async function verifyAccessCode(year, suppliedCode) {
  const supplied = requireString(suppliedCode, "预约口令", 128);
  const snapshot = await database.ref(`years/${year}/settings/accessCode`).get();
  const configured = snapshot.val();
  if (typeof configured !== "string" || configured.length < 4) {
    throw new HttpsError("failed-precondition", "当前学年尚未配置预约口令，请联系老师。", {reason: "ACCESS_CODE_NOT_CONFIGURED"});
  }
  if (!secureEqual(supplied, configured)) {
    throw new HttpsError("permission-denied", "预约口令错误。", {reason: "ACCESS_CODE_INVALID"});
  }
}

async function requireWhitelistedStudent(year, nickname) {
  const snapshot = await database.ref(`years/${year}/studentWhitelist`).get();
  if (!whitelistContains(snapshot.val(), nickname)) {
    throw new HttpsError("permission-denied", "验证失败，请检查姓名或联系老师。", {reason: "STUDENT_NOT_ALLOWED"});
  }
}

function reservationLessonTimestamp(reservation, year) {
  const parsed = parseSlot(reservation && reservation.time, year);
  if (!parsed) return Number(reservation && reservation.timestamp || 0);
  return new Date(`${parsed.date}T${parsed.startTime}:00+08:00`).getTime();
}

function publicReservation(id, reservation) {
  return {
    id,
    nickname: String(reservation.nickname || ""),
    time: String(reservation.time || ""),
    status: String(reservation.status || "booked"),
    cancelCode: String(reservation.cancelCode || ""),
    timestamp: Number(reservation.timestamp || 0),
  };
}

async function cleanupExpiredSessions(path) {
  const snapshot = await database.ref(path).orderByChild("expiresAt").endAt(Date.now()).limitToFirst(25).get();
  if (!snapshot.exists()) return;
  const updates = {};
  snapshot.forEach((child) => {
    updates[child.key] = null;
  });
  await database.ref(path).update(updates);
}

exports.createBooking = onCall(CALLABLE_OPTIONS, async (request) => {
  const data = request.data || {};
  const year = await requireActiveYear(data.year);
  const nickname = requireStudentName(data.nickname);
  const slotId = requireId(data.slotId, "时段");
  await enforceRateLimit(database, request, "createBookingGlobal", {limit: 30});
  await enforceRateLimit(database, request, "createBooking", {limit: 12, subject: hashKey(nickname)});
  await verifyAccessCode(year, data.accessCode);
  await requireWhitelistedStudent(year, nickname);

  const deadlineSnapshot = await database.ref(`years/${year}/settings/deadline`).get();
  const deadline = deadlineSnapshot.val();
  const deadlineMs = parseChinaDateTime(deadline);
  if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) {
    throw new HttpsError("failed-precondition", "本轮预约已截止。", {reason: "BOOKING_CLOSED"});
  }

  const [slotSnapshot, existingSnapshot, hoursSnapshot] = await Promise.all([
    database.ref(`years/${year}/slots/${slotId}`).get(),
    database.ref(`years/${year}/reservations`).orderByChild("nickname").equalTo(nickname).get(),
    database.ref(`years/${year}/studentHours/${nickname}`).get(),
  ]);
  const slot = slotSnapshot.val();
  const parsedSlot = parseSlot(slot && slot.time, year);
  if (!slot || slot.status === "hidden" || slot.reserved || !parsedSlot) {
    throw new HttpsError("already-exists", "该时间段已不可预约，请刷新后重试。", {reason: "SLOT_UNAVAILABLE"});
  }

  const existing = existingSnapshot.val() || {};
  const activeReservations = values(existing).filter((reservation) => reservation && reservation.status !== "canceled");
  const hasSameDay = activeReservations.some((reservation) => {
    const parsed = parseSlot(reservation.time, year);
    return parsed && parsed.date === parsedSlot.date;
  });
  if (hasSameDay && data.confirmSameDay !== true) {
    throw new HttpsError("failed-precondition", "当天已有其他预约，请确认后重试。", {
      reason: "SAME_DAY_CONFIRMATION_REQUIRED",
      date: parsedSlot.date,
    });
  }

  const usedHours = activeReservations.reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const totalHours = Number(hoursSnapshot.val());
  if (Number.isFinite(totalHours) && totalHours > 0 && usedHours + parsedSlot.hours > totalHours + 1e-9) {
    throw new HttpsError("failed-precondition", "剩余课时不足，无法预约该时段。", {
      reason: "INSUFFICIENT_HOURS",
      slotHours: parsedSlot.hours,
      remainingHours: Math.max(0, totalHours - usedHours),
    });
  }

  const reservationRef = database.ref(`years/${year}/reservations`).push();
  const reservationId = reservationRef.key;
  const slotRef = database.ref(`years/${year}/slots/${slotId}`);
  const claim = await slotRef.transaction((current) => {
    if (!current || current.reserved || current.status === "hidden") return;
    const currentParsed = parseSlot(current.time, year);
    if (!currentParsed || currentParsed.formattedSlotText !== parsedSlot.formattedSlotText) return;
    return {...current, reserved: true, reservationId};
  });
  if (!claim.committed) {
    throw new HttpsError("already-exists", "该时间段刚刚被其他同学预约。", {reason: "SLOT_UNAVAILABLE"});
  }

  const cancelCode = randomCode(5);
  const logRef = database.ref(`years/${year}/operationLog`).push();
  const reservation = {
    nickname,
    slotId,
    reservationId,
    time: parsedSlot.formattedSlotText,
    status: "booked",
    cancelCode,
    slotSnapshot: {
      rawTime: parsedSlot.rawTime,
      date: parsedSlot.date,
      startTime: parsedSlot.startTime,
      endTime: parsedSlot.endTime,
      formattedSlotText: parsedSlot.formattedSlotText,
    },
    timestamp: ServerValue.TIMESTAMP,
  };
  try {
    await database.ref().update({
      [`years/${year}/reservations/${reservationId}`]: reservation,
      [`years/${year}/operationLog/${logRef.key}`]: {
        action: `学生 [${nickname}] 预约成功: [${parsedSlot.formattedSlotText}]`,
        source: "student-api",
        timestamp: ServerValue.TIMESTAMP,
      },
    });
  } catch (error) {
    await slotRef.transaction((current) => {
      if (!current || current.reservationId !== reservationId) return;
      const released = {...current, reserved: false};
      delete released.reservationId;
      return released;
    }).catch(() => null);
    console.error("Failed to persist reservation", error);
    throw new HttpsError("internal", "预约保存失败，请稍后重试。", {reason: "BOOKING_SAVE_FAILED"});
  }
  return {nickname, time: parsedSlot.formattedSlotText, cancelCode, slotSnapshot: reservation.slotSnapshot};
});

exports.getBookingHistory = onCall(CALLABLE_OPTIONS, async (request) => {
  const data = request.data || {};
  const year = await requireActiveYear(data.year);
  const nickname = requireStudentName(data.nickname);
  const cancelCode = requireCancelCode(data.cancelCode);
  await enforceRateLimit(database, request, "getBookingHistoryGlobal", {limit: 30});
  await enforceRateLimit(database, request, "getBookingHistory", {limit: 8, subject: hashKey(nickname)});
  const snapshot = await database.ref(`years/${year}/reservations`).orderByChild("nickname").equalTo(nickname).get();
  const reservations = snapshot.val() || {};
  const authenticated = values(reservations).some((reservation) => reservation && secureEqual(String(reservation.cancelCode || "").toUpperCase(), cancelCode));
  if (!authenticated) {
    throw new HttpsError("permission-denied", "姓名或凭证码错误。", {reason: "HISTORY_AUTH_FAILED"});
  }

  const list = Object.entries(reservations)
    .filter(([, reservation]) => reservation && reservation.nickname === nickname)
    .map(([id, reservation]) => ({...publicReservation(id, reservation), lessonTimestamp: reservationLessonTimestamp(reservation, year)}))
    .sort((left, right) => right.lessonTimestamp - left.lessonTimestamp)
    .map(({lessonTimestamp: _lessonTimestamp, ...reservation}) => reservation);
  const usedHours = list.filter((reservation) => reservation.status !== "canceled").reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const completedHours = list.filter((reservation) => reservation.status === "completed").reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const totalHoursSnapshot = await database.ref(`years/${year}/studentHours/${nickname}`).get();
  const totalHoursValue = Number(totalHoursSnapshot.val());
  const totalHours = Number.isFinite(totalHoursValue) && totalHoursValue > 0 ? totalHoursValue : null;

  const sessionToken = randomToken();
  const sessionHash = hashKey(sessionToken);
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await cleanupExpiredSessions("privateRuntime/historySessions");
  await database.ref(`privateRuntime/historySessions/${sessionHash}`).set({year, nickname, expiresAt, createdAt: ServerValue.TIMESTAMP});
  return {
    reservations: list,
    sessionToken,
    expiresAt,
    summary: {
      completedHours,
      usedHours,
      totalHours,
      remainingHours: totalHours === null ? null : Math.max(0, totalHours - usedHours),
    },
  };
});

exports.cancelBooking = onCall(CALLABLE_OPTIONS, async (request) => {
  const data = request.data || {};
  const year = await requireActiveYear(data.year);
  const reservationId = requireId(data.reservationId, "预约记录");
  const sessionToken = requireString(data.sessionToken, "查询会话", 200);
  await enforceRateLimit(database, request, "cancelBookingGlobal", {limit: 30});
  await enforceRateLimit(database, request, "cancelBooking", {limit: 10, subject: hashKey(reservationId)});
  const sessionRef = database.ref(`privateRuntime/historySessions/${hashKey(sessionToken)}`);
  const sessionSnapshot = await sessionRef.get();
  const session = sessionSnapshot.val();
  if (!session || session.year !== year || Number(session.expiresAt || 0) < Date.now()) {
    if (session) await sessionRef.remove().catch(() => null);
    throw new HttpsError("unauthenticated", "查询凭证已过期，请重新验证历史记录。", {reason: "HISTORY_SESSION_EXPIRED"});
  }

  const reservationRef = database.ref(`years/${year}/reservations/${reservationId}`);
  let original = null;
  const canceled = await reservationRef.transaction((current) => {
    if (!current || current.nickname !== session.nickname || !["booked", "confirmed"].includes(current.status)) return;
    original = current;
    return {...current, status: "canceled", canceledAt: ServerValue.TIMESTAMP};
  });
  if (!canceled.committed || !original) {
    throw new HttpsError("failed-precondition", "该预约已无法取消，请刷新历史记录。", {reason: "RESERVATION_NOT_CANCELABLE"});
  }

  let slotReleased = true;
  if (original.slotId) {
    try {
      const release = await database.ref(`years/${year}/slots/${original.slotId}`).transaction((current) => {
        if (!current || !current.reserved || current.reservationId !== reservationId) return;
        const next = {...current, reserved: false};
        delete next.reservationId;
        return next;
      });
      slotReleased = release.committed;
    } catch (error) {
      slotReleased = false;
      console.error("Failed to release canceled slot", error);
    }
  }
  const logRef = database.ref(`years/${year}/operationLog`).push();
  await logRef.set({
    action: `学生 [${original.nickname}] 自行取消了预约: [${original.time}]`,
    source: "student-api",
    slotReleased,
    timestamp: ServerValue.TIMESTAMP,
  }).catch((error) => console.error("Failed to write cancellation log", error));
  return {canceled: true, slotReleased};
});

function examPathPart(value) {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

exports.startExam = onCall(CALLABLE_OPTIONS, async (request) => {
  const data = request.data || {};
  const year = await requireActiveYear(data.year);
  const studentName = requireStudentName(data.studentName);
  const paperTitle = requireString(data.paperTitle, "试卷名称", 200);
  const examId = requireId(data.examId, "试卷登记");
  const examTicket = requireString(data.examTicket, "试卷票据", 200);
  await enforceRateLimit(database, request, "startExamGlobal", {limit: 30});
  await enforceRateLimit(database, request, "startExam", {limit: 8, subject: hashKey(`${examId}|${studentName}`)});
  await verifyAccessCode(year, data.accessCode);
  await requireWhitelistedStudent(year, studentName);
  const definitionSnapshot = await database.ref(`examDefinitions/${examId}`).get();
  const definition = definitionSnapshot.val();
  if (!definition || definition.active !== true || typeof definition.ticketHash !== "string" || !secureEqual(hashKey(examTicket), definition.ticketHash) || definition.paperTitle !== paperTitle) {
    throw new HttpsError("permission-denied", "试卷未登记、已停用或安全票据无效。", {reason: "EXAM_NOT_REGISTERED"});
  }
  const startAt = parseChinaDateTime(definition.startTime);
  const endAt = parseChinaDateTime(definition.endTime);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 24 * 60 * 60 * 1000) {
    throw new HttpsError("invalid-argument", "考试时间窗口不合法。");
  }
  const lockRef = database.ref(`submittedExamLocks/${examPathPart(examId)}/${examPathPart(studentName)}`);
  const lockSnapshot = await lockRef.get();
  const lock = lockSnapshot.val();
  if (typeof lock === "number" || lock && lock.status === "submitted") {
    return {
      status: "submitted",
      receiptId: lock && lock.receiptId || "历史记录",
      submittedAt: lock && lock.submittedAt || null,
    };
  }

  const now = Date.now();
  if (now < startAt) throw new HttpsError("failed-precondition", "考试尚未开始。", {reason: "EXAM_NOT_STARTED"});
  if (now > endAt) throw new HttpsError("failed-precondition", "考试已经截止。", {reason: "EXAM_ENDED"});

  const sessionToken = randomToken();
  const sessionHash = hashKey(sessionToken);
  const expiresAt = Math.min(endAt + 2 * 60 * 60 * 1000, now + 26 * 60 * 60 * 1000);
  await cleanupExpiredSessions("privateRuntime/examSessions");
  await database.ref(`privateRuntime/examSessions/${sessionHash}`).set({
    year,
    examId,
    studentName,
    paperTitle,
    startAt,
    endAt,
    expiresAt,
    createdAt: ServerValue.TIMESTAMP,
  });
  return {
    status: "ready",
    sessionToken,
    expiresAt,
    startTime: definition.startTime,
    endTime: definition.endTime,
  };
});

exports.submitExam = onCall(CALLABLE_OPTIONS, async (request) => {
  const data = request.data || {};
  const sessionToken = requireString(data.sessionToken, "考试会话", 200);
  await enforceRateLimit(database, request, "submitExamGlobal", {limit: 30});
  const sessionRef = database.ref(`privateRuntime/examSessions/${hashKey(sessionToken)}`);
  const sessionSnapshot = await sessionRef.get();
  const session = sessionSnapshot.val();
  if (!session || Number(session.expiresAt || 0) < Date.now()) {
    if (session) await sessionRef.remove().catch(() => null);
    throw new HttpsError("unauthenticated", "考试会话已失效，请保留答案并重新验证。", {reason: "EXAM_SESSION_EXPIRED"});
  }
  await enforceRateLimit(database, request, "submitExam", {limit: 5, subject: hashKey(`${session.examId}|${session.studentName}`)});
  const lockRef = database.ref(`submittedExamLocks/${examPathPart(session.examId)}/${examPathPart(session.studentName)}`);
  const receiptId = `EX-${randomCode(6)}-${randomCode(6)}`;
  const submittedAt = Date.now();
  const result = await lockRef.transaction((current) => {
    if (typeof current === "number" || current && current.status === "submitted") return;
    return {
      status: "submitted",
      receiptId,
      submittedAt,
      createdAt: Number(session.createdAt || submittedAt),
      sessionHash: hashKey(sessionToken),
    };
  });
  if (!result.committed) {
    const existing = result.snapshot.val();
    throw new HttpsError("already-exists", "该试卷已经交卷。", {
      reason: "EXAM_ALREADY_SUBMITTED",
      receiptId: existing && existing.receiptId || "历史记录",
      submittedAt: existing && existing.submittedAt || null,
    });
  }
  await sessionRef.remove().catch(() => null);
  return {receiptId, submittedAt};
});
