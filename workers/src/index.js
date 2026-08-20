import {verifyAppCheck} from "./app-check.js";
import {dbDelete, dbGet, dbPatch, dbPut, dbTransaction} from "./firebase.js";
import {
  ApiError,
  hashKey,
  randomCode,
  randomId,
  randomToken,
  requestIp,
  requireCancelCode,
  requireId,
  requireString,
  requireStudentName,
  requireYear,
  secureEqual,
} from "./security.js";
import {calcHours, parseChinaDateTime, parseSlot} from "./time.js";

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
    throw new ApiError(412, "当前开放学年已经变化，请刷新页面后重试。", "YEAR_CHANGED");
  }
  return year;
}

async function verifyAccessCode(env, year, suppliedCode) {
  const supplied = requireString(suppliedCode, "预约口令", 128);
  const snapshot = await dbGet(env, `years/${year}/settings/accessCode`);
  const configured = snapshot.value;
  if (typeof configured !== "string" || configured.length < 4) {
    throw new ApiError(412, "当前学年尚未配置预约口令，请联系老师。", "ACCESS_CODE_NOT_CONFIGURED");
  }
  if (!await secureEqual(supplied, configured)) throw new ApiError(403, "预约口令错误。", "ACCESS_CODE_INVALID");
}

async function requireWhitelistedStudent(env, year, nickname) {
  const snapshot = await dbGet(env, `years/${year}/studentWhitelist`);
  if (!whitelistContains(snapshot.value, nickname)) throw new ApiError(403, "验证失败，请检查姓名或联系老师。", "STUDENT_NOT_ALLOWED");
}

async function enforceRateLimit(env, request, bucket, {limit = 10, windowMs = 10 * 60 * 1000, subject = "global"} = {}) {
  const identifier = await hashKey(`${bucket}|${requestIp(request)}|${subject}`);
  const result = await dbTransaction(env, `privateRuntime/rateLimits/${bucket}/${identifier}`, (current) => {
    const now = Date.now();
    const previous = current && typeof current === "object" ? current : null;
    if (!previous || !Number.isFinite(Number(previous.windowStartedAt)) || now - Number(previous.windowStartedAt) >= windowMs) {
      return {count: 1, windowStartedAt: now, lastSeenAt: now};
    }
    if (Number(previous.count || 0) >= limit) return;
    return {count: Number(previous.count || 0) + 1, windowStartedAt: Number(previous.windowStartedAt), lastSeenAt: now};
  });
  if (!result.committed) throw new ApiError(429, "操作过于频繁，请稍后重试。", "RATE_LIMITED");
}

// 大陆网络可能无法获取 Google reCAPTCHA。该兼容验证不是 App Check 的等价替代，
// 只作为网络兜底，并继续叠加预约口令、学生白名单、一次性挑战和服务端限流。
const CLIENT_CHALLENGE_DIFFICULTY = 3;
const CLIENT_CHALLENGE_TTL_MS = 2 * 60 * 1000;

async function createClientChallenge(env, request) {
  if (String(env.CLIENT_CHALLENGE_ENABLED || "false") !== "true") {
    throw new ApiError(503, "当前安全校验暂不可用，请稍后重试。", "CLIENT_CHALLENGE_DISABLED");
  }
  await enforceRateLimit(env, request, "clientChallenge", {limit: 12});
  const id = randomToken(18);
  const salt = randomToken(18);
  const expiresAt = Date.now() + CLIENT_CHALLENGE_TTL_MS;
  await dbPut(env, `privateRuntime/clientChallenges/${id}`, {
    salt,
    expiresAt,
    ipHash: await hashKey(requestIp(request)),
    createdAt: Date.now(),
  });
  return {id, salt, difficulty: CLIENT_CHALLENGE_DIFFICULTY, expiresAt};
}

async function verifyClientChallenge(env, request) {
  if (String(env.CLIENT_CHALLENGE_ENABLED || "false") !== "true") throw new Error("APP_CHECK_MISSING");
  const id = request.headers.get("X-Student-Challenge-Id");
  const nonce = request.headers.get("X-Student-Challenge-Nonce");
  if (!id || !/^[A-Za-z0-9_-]{10,100}$/.test(id) || !nonce || !/^\d{1,7}$/.test(nonce)) throw new Error("CLIENT_CHALLENGE_MISSING");
  await enforceRateLimit(env, request, "clientChallengeVerify", {limit: 30});
  const path = `privateRuntime/clientChallenges/${id}`;
  const snapshot = await dbGet(env, path);
  const challenge = snapshot.value;
  if (!challenge || Number(challenge.expiresAt || 0) <= Date.now() || challenge.usedAt) throw new Error("CLIENT_CHALLENGE_INVALID");
  if (challenge.ipHash !== await hashKey(requestIp(request))) throw new Error("CLIENT_CHALLENGE_INVALID");
  const digest = await hashKey(`${id}.${challenge.salt}.${nonce}`);
  if (!digest.startsWith("0".repeat(CLIENT_CHALLENGE_DIFFICULTY))) throw new Error("CLIENT_CHALLENGE_INVALID");
  const consumed = await dbTransaction(env, path, (current) => {
    if (!current || current.usedAt || Number(current.expiresAt || 0) <= Date.now()) return;
    return {...current, usedAt: Date.now()};
  });
  if (!consumed.committed) throw new Error("CLIENT_CHALLENGE_REPLAYED");
  await dbDelete(env, path).catch(() => null);
}

async function cleanupExpiredSessions(env, path) {
  const snapshot = await dbGet(env, path, {query: {orderBy: "expiresAt", endAt: Date.now(), limitToFirst: 25}});
  const updates = {};
  for (const key of Object.keys(snapshot.value || {})) updates[key] = null;
  if (Object.keys(updates).length) await dbPatch(env, path, updates);
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

async function createBooking(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const nickname = requireStudentName(data.nickname);
  const slotId = requireId(data.slotId, "时段");
  await enforceRateLimit(env, request, "createBookingGlobal", {limit: 30});
  await enforceRateLimit(env, request, "createBooking", {limit: 12, subject: await hashKey(nickname)});
  await verifyAccessCode(env, year, data.accessCode);
  await requireWhitelistedStudent(env, year, nickname);

  const deadlineSnapshot = await dbGet(env, `years/${year}/settings/deadline`);
  const deadlineMs = parseChinaDateTime(deadlineSnapshot.value);
  if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) throw new ApiError(412, "本轮预约已截止。", "BOOKING_CLOSED");

  const [slotSnapshot, existingSnapshot, hoursSnapshot] = await Promise.all([
    dbGet(env, `years/${year}/slots/${slotId}`),
    dbGet(env, `years/${year}/reservations`, {query: {orderBy: "nickname", equalTo: nickname}}),
    dbGet(env, `years/${year}/studentHours/${nickname}`),
  ]);
  const slot = slotSnapshot.value;
  const parsedSlot = parseSlot(slot && slot.time, year);
  if (!slot || slot.status === "hidden" || slot.reserved || !parsedSlot) throw new ApiError(409, "该时间段已不可预约，请刷新后重试。", "SLOT_UNAVAILABLE");

  const existing = existingSnapshot.value || {};
  const activeReservations = values(existing).filter((reservation) => reservation && reservation.status !== "canceled");
  const hasSameDay = activeReservations.some((reservation) => {
    const parsed = parseSlot(reservation.time, year);
    return parsed && parsed.date === parsedSlot.date;
  });
  if (hasSameDay && data.confirmSameDay !== true) {
    throw new ApiError(412, "当天已有其他预约，请确认后重试。", "SAME_DAY_CONFIRMATION_REQUIRED", {date: parsedSlot.date});
  }

  const usedHours = activeReservations.reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const totalHours = Number(hoursSnapshot.value);
  if (Number.isFinite(totalHours) && totalHours > 0 && usedHours + parsedSlot.hours > totalHours + 1e-9) {
    throw new ApiError(412, "剩余课时不足，无法预约该时段。", "INSUFFICIENT_HOURS", {slotHours: parsedSlot.hours, remainingHours: Math.max(0, totalHours - usedHours)});
  }

  const reservationId = randomId();
  const claim = await dbTransaction(env, `years/${year}/slots/${slotId}`, (current) => {
    if (!current || current.reserved || current.status === "hidden") return;
    const currentParsed = parseSlot(current.time, year);
    if (!currentParsed || currentParsed.formattedSlotText !== parsedSlot.formattedSlotText) return;
    return {...current, reserved: true, reservationId};
  });
  if (!claim.committed) throw new ApiError(409, "该时间段刚刚被其他同学预约。", "SLOT_UNAVAILABLE");

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
    slotSnapshot: {rawTime: parsedSlot.rawTime, date: parsedSlot.date, startTime: parsedSlot.startTime, endTime: parsedSlot.endTime, formattedSlotText: parsedSlot.formattedSlotText},
    timestamp: now,
  };
  try {
    await dbPatch(env, "", {
      [`years/${year}/reservations/${reservationId}`]: reservation,
      [`years/${year}/operationLog/${logId}`]: {action: `学生 [${nickname}] 预约成功: [${parsedSlot.formattedSlotText}]`, source: "student-api-worker", timestamp: now},
    });
  } catch (error) {
    await dbTransaction(env, `years/${year}/slots/${slotId}`, (current) => {
      if (!current || current.reservationId !== reservationId) return;
      const released = {...current, reserved: false};
      delete released.reservationId;
      return released;
    }).catch(() => null);
    console.error("Failed to persist reservation", error);
    throw new ApiError(500, "预约保存失败，请稍后重试。", "BOOKING_SAVE_FAILED");
  }
  return {nickname, time: parsedSlot.formattedSlotText, cancelCode, slotSnapshot: reservation.slotSnapshot, reservationId};
}

async function getBookingHistory(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const nickname = requireStudentName(data.nickname);
  const cancelCode = requireCancelCode(data.cancelCode);
  await enforceRateLimit(env, request, "getBookingHistoryGlobal", {limit: 30});
  await enforceRateLimit(env, request, "getBookingHistory", {limit: 8, subject: await hashKey(nickname)});
  const snapshot = await dbGet(env, `years/${year}/reservations`, {query: {orderBy: "nickname", equalTo: nickname}});
  const reservations = snapshot.value || {};
  const authenticated = (await Promise.all(values(reservations).map(async (reservation) => reservation && await secureEqual(String(reservation.cancelCode || "").toUpperCase(), cancelCode)))).some(Boolean);
  if (!authenticated) throw new ApiError(403, "姓名或凭证码错误。", "HISTORY_AUTH_FAILED");

  const list = Object.entries(reservations)
    .filter(([, reservation]) => reservation && reservation.nickname === nickname)
    .map(([id, reservation]) => ({...publicReservation(id, reservation), lessonTimestamp: reservationLessonTimestamp(reservation, year)}))
    .sort((left, right) => right.lessonTimestamp - left.lessonTimestamp)
    .map(({lessonTimestamp: _lessonTimestamp, ...reservation}) => reservation);
  const usedHours = list.filter((reservation) => reservation.status !== "canceled").reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const completedHours = list.filter((reservation) => reservation.status === "completed").reduce((total, reservation) => total + calcHours(reservation.time), 0);
  const totalHoursSnapshot = await dbGet(env, `years/${year}/studentHours/${nickname}`);
  const totalHoursValue = Number(totalHoursSnapshot.value);
  const totalHours = Number.isFinite(totalHoursValue) && totalHoursValue > 0 ? totalHoursValue : null;
  const sessionToken = randomToken();
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await cleanupExpiredSessions(env, "privateRuntime/historySessions");
  await dbPut(env, `privateRuntime/historySessions/${await hashKey(sessionToken)}`, {year, nickname, expiresAt, createdAt: Date.now()});
  return {reservations: list, sessionToken, expiresAt, summary: {completedHours, usedHours, totalHours, remainingHours: totalHours === null ? null : Math.max(0, totalHours - usedHours)}};
}

async function cancelBooking(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const reservationId = requireId(data.reservationId, "预约记录");
  const sessionToken = requireString(data.sessionToken, "查询会话", 200);
  await enforceRateLimit(env, request, "cancelBookingGlobal", {limit: 30});
  await enforceRateLimit(env, request, "cancelBooking", {limit: 10, subject: await hashKey(reservationId)});
  const sessionPath = `privateRuntime/historySessions/${await hashKey(sessionToken)}`;
  const sessionSnapshot = await dbGet(env, sessionPath);
  const session = sessionSnapshot.value;
  if (!session || session.year !== year || Number(session.expiresAt || 0) < Date.now()) {
    if (session) await dbDelete(env, sessionPath).catch(() => null);
    throw new ApiError(401, "查询凭证已过期，请重新验证历史记录。", "HISTORY_SESSION_EXPIRED");
  }
  const reservationPath = `years/${year}/reservations/${reservationId}`;
  let original = null;
  const canceled = await dbTransaction(env, reservationPath, (current) => {
    if (!current || current.nickname !== session.nickname || !["booked", "confirmed"].includes(current.status)) return;
    original = current;
    return {...current, status: "canceled", canceledAt: Date.now()};
  });
  if (!canceled.committed || !original) throw new ApiError(412, "该预约已无法取消，请刷新历史记录。", "RESERVATION_NOT_CANCELABLE");
  let slotReleased = true;
  if (original.slotId) {
    try {
      const release = await dbTransaction(env, `years/${year}/slots/${original.slotId}`, (current) => {
        if (!current || !current.reserved || current.reservationId !== reservationId) return;
        const next = {...current, reserved: false};
        delete next.reservationId;
        return next;
      });
      slotReleased = release.committed;
      // 清理应急预约占位，否则学生端 emergencyClaims 会永久显示"已满"
      await dbDelete(env, `emergencySlotClaims/${year}/${original.slotId}`).catch(() => null);
    } catch (error) {
      slotReleased = false;
      console.error("Failed to release canceled slot", error);
    }
  }
  await dbPut(env, `years/${year}/operationLog/${randomId()}`, {action: `学生 [${original.nickname}] 自行取消了预约: [${original.time}]`, source: "student-api-worker", slotReleased, timestamp: Date.now()}).catch((error) => console.error("Failed to write cancellation log", error));
  return {canceled: true, slotReleased};
}

function examPathPart(value) {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

async function startExam(env, request, data) {
  const year = await requireActiveYear(env, data.year);
  const studentName = requireStudentName(data.studentName);
  const paperTitle = requireString(data.paperTitle, "试卷名称", 200);
  const examId = requireId(data.examId, "试卷登记");
  const examTicket = requireString(data.examTicket, "试卷票据", 200);
  await enforceRateLimit(env, request, "startExamGlobal", {limit: 30});
  await enforceRateLimit(env, request, "startExam", {limit: 8, subject: await hashKey(`${examId}|${studentName}`)});
  await verifyAccessCode(env, year, data.accessCode);
  await requireWhitelistedStudent(env, year, studentName);
  const definitionSnapshot = await dbGet(env, `examDefinitions/${examId}`);
  const definition = definitionSnapshot.value;
  if (!definition || definition.active !== true || typeof definition.ticketHash !== "string" || !await secureEqual(await hashKey(examTicket), definition.ticketHash) || definition.paperTitle !== paperTitle) {
    throw new ApiError(403, "试卷未登记、已停用或安全票据无效。", "EXAM_NOT_REGISTERED");
  }
  const startAt = parseChinaDateTime(definition.startTime);
  const endAt = parseChinaDateTime(definition.endTime);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || endAt - startAt > 24 * 60 * 60 * 1000) throw new ApiError(400, "考试时间窗口不合法.", "INVALID_ARGUMENT");
  const lockPath = `submittedExamLocks/${examId}/${studentName}`;
  const lockSnapshot = await dbGet(env, lockPath);
  const lock = lockSnapshot.value;
  if (typeof lock === "number" || lock && lock.status === "submitted") return {status: "submitted", receiptId: lock && lock.receiptId || "历史记录", submittedAt: lock && lock.submittedAt || null};
  const now = Date.now();
  if (now < startAt) throw new ApiError(412, "考试尚未开始。", "EXAM_NOT_STARTED");
  if (now > endAt) throw new ApiError(412, "考试已经截止。", "EXAM_ENDED");
  const sessionToken = randomToken();
  const expiresAt = Math.min(endAt + 2 * 60 * 60 * 1000, now + 26 * 60 * 60 * 1000);
  await cleanupExpiredSessions(env, "privateRuntime/examSessions");
  await dbPut(env, `privateRuntime/examSessions/${await hashKey(sessionToken)}`, {year, examId, studentName, paperTitle, startAt, endAt, expiresAt, createdAt: now});
  return {status: "ready", sessionToken, expiresAt, startTime: definition.startTime, endTime: definition.endTime};
}

async function submitExam(env, request, data) {
  const sessionToken = requireString(data.sessionToken, "考试会话", 200);
  await enforceRateLimit(env, request, "submitExamGlobal", {limit: 30});
  const sessionPath = `privateRuntime/examSessions/${await hashKey(sessionToken)}`;
  const sessionSnapshot = await dbGet(env, sessionPath);
  const session = sessionSnapshot.value;
  if (!session || Number(session.expiresAt || 0) < Date.now()) {
    if (session) await dbDelete(env, sessionPath).catch(() => null);
    throw new ApiError(401, "考试会话已失效，请保留答案并重新验证。", "EXAM_SESSION_EXPIRED");
  }
  await enforceRateLimit(env, request, "submitExam", {limit: 5, subject: await hashKey(`${session.examId}|${session.studentName}`)});
  const lockPath = `submittedExamLocks/${session.examId}/${session.studentName}`;
  const receiptId = `EX-${randomCode(6)}-${randomCode(6)}`;
  const submittedAt = Date.now();
  const sessionHash = await hashKey(sessionToken);
  const result = await dbTransaction(env, lockPath, (current) => {
    if (typeof current === "number" || current && current.status === "submitted") return;
    return {status: "submitted", receiptId, submittedAt, createdAt: Number(session.createdAt || submittedAt), sessionHash};
  });
  if (!result.committed) {
    const existing = result.value;
    throw new ApiError(409, "该试卷已经交卷。", "EXAM_ALREADY_SUBMITTED", {receiptId: existing && existing.receiptId || "历史记录", submittedAt: existing && existing.submittedAt || null});
  }
  await dbDelete(env, sessionPath).catch(() => null);
  return {receiptId, submittedAt};
}

function originFor(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (origin && allowed.length && !allowed.includes(origin)) return null;
  return origin || allowed[0] || "*";
}

function jsonResponse(body, status, request, env) {
  const origin = originFor(request, env);
  const headers = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"};
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = "content-type, x-firebase-appcheck, x-student-challenge-id, x-student-challenge-nonce";
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), {status, headers});
}

export default {
  async fetch(request, env) {
    const origin = originFor(request, env);
    if (!origin) return jsonResponse({error: {message: "请求来源不被允许。", reason: "ORIGIN_NOT_ALLOWED"}}, 403, request, env);
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname.endsWith("/health")) return jsonResponse({ok: true, service: "tutoring-booking-api"}, 200, request, env);
    if (request.method === "GET" && pathname.endsWith("/challenge")) {
      try {
        return jsonResponse({data: await createClientChallenge(env, request)}, 200, request, env);
      } catch (error) {
        if (error instanceof ApiError) return jsonResponse({error: {message: error.message, reason: error.reason, details: error.details}}, error.status, request, env);
        console.error(error);
        return jsonResponse({error: {message: "安全校验服务暂时不可用，请稍后重试。", reason: "CLIENT_CHALLENGE_FAILED"}}, 503, request, env);
      }
    }
    if (request.method === "OPTIONS") return new Response(null, {status: 204, headers: {"access-control-allow-origin": origin, "access-control-allow-headers": "content-type, x-firebase-appcheck, x-student-challenge-id, x-student-challenge-nonce", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400", vary: "Origin"}});
    if (request.method !== "POST") return jsonResponse({error: {message: "只支持 POST 请求。", reason: "METHOD_NOT_ALLOWED"}}, 405, request, env);
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
      else return jsonResponse({error: {message: "接口不存在。", reason: "NOT_FOUND"}}, 404, request, env);
      return jsonResponse({data: result}, 200, request, env);
    } catch (error) {
      if (error instanceof ApiError) return jsonResponse({error: {message: error.message, reason: error.reason, details: error.details}}, error.status, request, env);
      if (/^(APP_CHECK|CLIENT_CHALLENGE)_/.test(String(error && error.message))) return jsonResponse({error: {message: "安全校验失败，请刷新页面后重试。", reason: error.message}}, 403, request, env);
      console.error(error);
      return jsonResponse({error: {message: "服务暂时不可用，请稍后重试。", reason: "INTERNAL"}}, 500, request, env);
    }
  },
};
