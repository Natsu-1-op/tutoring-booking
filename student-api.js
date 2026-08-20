(function createStudentApi(global) {
    'use strict';

    const settings = global.__STUDENT_API_CONFIG__ || {};
    let initialized = false;
    let apiBaseUrl = '';
    let appCheckEnabled = false;
    // 后端不可达时缓存标记：后续请求直接走直连通道，不再重复等待超时（学生无感知）
    let backendUnreachable = false;

    function withTimeout(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('网络繁忙，请稍后重试'));
            }, timeoutMs);
            promise.then(value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }, error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function init() {
        if (initialized) return;
        if (!global.firebase || !firebase.apps.length) {
            throw new Error('学生安全接口未正确加载，请刷新页面。');
        }
        if (!settings.apiBaseUrl) {
            throw new Error('学生安全接口尚未配置，请联系管理员。');
        }
        apiBaseUrl = String(settings.apiBaseUrl).replace(/\/$/, '');
        if (settings.appCheckSiteKey && typeof firebase.appCheck === 'function') {
            try {
                const provider = settings.provider === 'recaptcha-v3'
                    ? new firebase.appCheck.ReCaptchaV3Provider(settings.appCheckSiteKey)
                    : new firebase.appCheck.ReCaptchaEnterpriseProvider(settings.appCheckSiteKey);
                firebase.appCheck().activate(provider, true);
                appCheckEnabled = true;
            } catch (error) {
                // 大陆网络可能无法连接 reCAPTCHA；后续请求改用 Worker 一次性挑战。
                console.warn('App Check 初始化失败，将使用兼容验证：', error);
            }
        }
        // 大陆网络下先探测一次后端可达性：不可达则后续请求直接走直连通道，避免每次等待超时
        fetchWithTimeout(`${apiBaseUrl}/health`, { method: 'GET', cache: 'no-store' }, 1200)
            .then(response => { if (!response.ok) backendUnreachable = true; })
            .catch(() => { backendUnreachable = true; });
        initialized = true;
    }

    function bytesToHex(bytes) {
        return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...(options || {}), signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    function apiError(message, reason, details) {
        const error = new Error(message);
        error.reason = reason || '';
        error.details = details || {};
        return error;
    }

    function studentIndexKey(name) {
        return bytesToHex(new TextEncoder().encode(String(name || '')));
    }

    function randomCancelCode() {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(5);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
    }

    // 全角→半角归一化（大陆中文输入法全角字符会被格式校验误拒）
    function normalizeHalfWidth(value) {
        return String(value || '').replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
    }

    // ---- 本机预约记录（后端不可达时的历史/取消兜底）----
    const LOCAL_RESERVATIONS_KEY = 'tutoring_local_reservations_v1';

    function readLocalReservations() {
        try { return JSON.parse(localStorage.getItem(LOCAL_RESERVATIONS_KEY) || '[]'); } catch (e) { return []; }
    }

    function writeLocalReservations(list) {
        try { localStorage.setItem(LOCAL_RESERVATIONS_KEY, JSON.stringify(list.slice(-50))); } catch (e) {}
    }

    function rememberLocalReservation(record) {
        if (!record || !record.reservationId) return;
        const list = readLocalReservations();
        const index = list.findIndex(item => item.reservationId === record.reservationId);
        if (index >= 0) list[index] = { ...list[index], ...record };
        else list.push(record);
        writeLocalReservations(list);
    }

    function updateLocalReservationStatus(reservationId, status) {
        const list = readLocalReservations();
        const item = list.find(r => r.reservationId === reservationId);
        if (item) { item.status = status; writeLocalReservations(list); }
    }

    // ---- 考试直连会话（后端不可达时的兜底）----
    const LOCAL_EXAM_SESSIONS_KEY = 'tutoring_local_exam_sessions_v1';

    function readLocalExamSessions() {
        try { return JSON.parse(localStorage.getItem(LOCAL_EXAM_SESSIONS_KEY) || '[]'); } catch (e) { return []; }
    }

    function rememberEmergencyExamSession(record) {
        if (!record || !record.sessionId) return;
        const list = readLocalExamSessions();
        list.push(record);
        try { localStorage.setItem(LOCAL_EXAM_SESSIONS_KEY, JSON.stringify(list.slice(-10))); } catch (e) {}
    }

    function findEmergencyExamSession(sessionToken) {
        return readLocalExamSessions().find(item => item.sessionId === String(sessionToken || ''));
    }

    function removeEmergencyExamSession(sessionToken) {
        const list = readLocalExamSessions().filter(item => item.sessionId !== String(sessionToken || ''));
        try { localStorage.setItem(LOCAL_EXAM_SESSIONS_KEY, JSON.stringify(list)); } catch (e) {}
    }

    function calcHoursLocal(timeStr) {
        try {
            if (global.TimeParser && typeof global.TimeParser.calcHours === 'function') return global.TimeParser.calcHours(timeStr);
        } catch (e) {}
        const match = String(timeStr || '').match(/(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})/);
        if (!match) return 0;
        const diff = (Number(match[3]) * 60 + Number(match[4])) - (Number(match[1]) * 60 + Number(match[2]));
        return diff > 0 ? diff / 60 : 0;
    }

    async function getClientChallenge() {
        const response = await fetchWithTimeout(`${apiBaseUrl}/challenge`, { method: 'GET', cache: 'no-store' }, 2500);
        let body = null;
        try { body = await response.json(); } catch (error) {}
        if (!response.ok || !body || !body.data || !body.data.id || !body.data.salt) {
            throw new Error('网络繁忙，请稍后重试。');
        }
        const challenge = body.data;
        const difficulty = Math.max(1, Math.min(5, Number(challenge.difficulty) || 3));
        const prefix = '0'.repeat(difficulty);
        const encoder = new TextEncoder();
        for (let nonce = 0; nonce < 1000000; nonce += 1) {
            const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${challenge.id}.${challenge.salt}.${nonce}`));
            if (bytesToHex(digest).startsWith(prefix)) {
                return { id: String(challenge.id), nonce: String(nonce) };
            }
        }
        throw new Error('网络繁忙，请稍后重试。');
    }

    async function call(name, payload) {
        init();
        try {
            let appCheckToken = null;
            let challenge = null;
            if (appCheckEnabled && !backendUnreachable) {
                try {
                    // reCAPTCHA 在大陆可能一直等待网络响应，必须超时后进入兼容路径。
                    appCheckToken = await withTimeout(firebase.appCheck().getToken(false), 1500);
                    if (!appCheckToken || !appCheckToken.token) appCheckToken = null;
                } catch (error) {
                    console.warn('App Check 获取失败，将使用兼容验证：', error);
                }
            }
            if (!appCheckToken && settings.allowClientChallengeFallback === false) {
                throw new Error('网络繁忙，请稍后重试。');
            }
            if (!appCheckToken && !backendUnreachable) {
                challenge = await getClientChallenge();
            }
            const headers = { 'content-type': 'application/json' };
            if (appCheckToken) headers['X-Firebase-AppCheck'] = appCheckToken.token;
            else if (challenge) {
                headers['X-Student-Challenge-Id'] = challenge.id;
                headers['X-Student-Challenge-Nonce'] = challenge.nonce;
            } else if (backendUnreachable) {
                // 已确认后端不可达（大陆常态）：不再等待网络超时，立即走直连通道
                const unreachable = new Error('后端不可达');
                unreachable.reason = 'INTERNAL';
                throw unreachable;
            }
            const response = await fetchWithTimeout(`${apiBaseUrl}/${encodeURIComponent(name)}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload || {})
            }, 6000);
            let body = null;
            try { body = await response.json(); } catch (parseError) {}
            if (!response.ok || !body || body.error) {
                const serverError = body && body.error || {};
                const normalized = new Error(serverError.message || '网络繁忙，请稍后重试。');
                normalized.code = `http-${response.status}`;
                normalized.details = serverError.details || {};
                normalized.reason = serverError.reason || '';
                throw normalized;
            }
            // 后端恢复可达后清除缓存标记，回到主通道
            backendUnreachable = false;
            return body.data;
        } catch (error) {
            if (error && error.reason) throw error;
            const normalized = new Error(error && error.message ? String(error.message).replace(/^Firebase:\s*/i, '') : '网络繁忙，请稍后重试。');
            normalized.code = error && error.code || '';
            normalized.details = error && error.details || {};
            normalized.reason = normalized.details && normalized.details.reason || '';
            if (isBackendUnavailable(normalized)) backendUnreachable = true;
            throw normalized;
        }
    }

    function isBackendUnavailable(error) {
        const reason = String(error && error.reason || '');
        if (!reason) return true;
        return /^(APP_CHECK|CLIENT_CHALLENGE)_/.test(reason) || reason === 'INTERNAL';
    }

    async function createBookingEmergency(payload) {
        if (!settings.emergencyDirectBookingFallback) {
            throw apiError('预约服务连接失败，请稍后重试。', 'BACKEND_UNAVAILABLE');
        }
        if (!global.TimeParser || typeof global.TimeParser.parseRawText !== 'function') {
            throw apiError('页面组件尚未加载完成，请刷新后重试。', 'EMERGENCY_COMPONENT_MISSING');
        }

        const year = String(payload && payload.year || '');
        const nickname = String(payload && payload.nickname || '').trim();
        const accessCode = String(payload && payload.accessCode || '').trim();
        const slotId = String(payload && payload.slotId || '');
        const database = firebase.database();

        if (!/^\d{4}$/.test(year) || !nickname || !accessCode || !/^[A-Za-z0-9_-]{1,100}$/.test(slotId)) {
            throw apiError('预约信息格式不完整，请刷新页面后重新填写。', 'INVALID_ARGUMENT');
        }

        const activeYearSnapshot = await database.ref('system/activeYear').once('value');
        if (String(activeYearSnapshot.val() || '') !== year) {
            throw apiError('当前开放学年已经变化，请刷新页面后重试。', 'YEAR_CHANGED');
        }

        const [slotSnapshot, deadlineSnapshot] = await Promise.all([
            database.ref(`years/${year}/slots/${slotId}`).once('value'),
            database.ref(`years/${year}/settings/deadline`).once('value')
        ]);
        const slot = slotSnapshot.val();
        const parsedSlot = slot && global.TimeParser.parseRawText(slot.time, year);
        if (!slot || slot.status === 'hidden' || slot.reserved || !parsedSlot) {
            throw apiError('该时间段已不可预约，请刷新后重试。', 'SLOT_UNAVAILABLE');
        }
        const deadlineMs = deadlineSnapshot.val() ? new Date(deadlineSnapshot.val()).getTime() : NaN;
        if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) {
            throw apiError('本轮预约已截止。', 'BOOKING_CLOSED');
        }

        const reservationId = database.ref(`emergencyBookingRequests/${year}`).push().key;
        if (!reservationId) throw apiError('无法生成预约编号，请刷新后重试。', 'EMERGENCY_ID_FAILED');
        const cancelCode = randomCancelCode();
        const timestamp = Date.now();
        const slotSnapshotData = {
            rawTime: parsedSlot.rawTime,
            date: parsedSlot.date,
            startTime: parsedSlot.startTime,
            endTime: parsedSlot.endTime,
            formattedSlotText: parsedSlot.formattedSlotText
        };
        const requestData = {
            reservationId,
            year,
            nickname,
            studentKey: studentIndexKey(nickname),
            accessCode,
            slotId,
            time: parsedSlot.formattedSlotText,
            status: 'booked',
            cancelCode,
            timestamp,
            slotSnapshot: slotSnapshotData
        };

        try {
            await database.ref(`emergencyBookingRequests/${year}/${reservationId}`).set(requestData);
        } catch (error) {
            throw apiError('预约信息校验未通过，请核对姓名与口令后重试。', 'EMERGENCY_AUTH_FAILED');
        }

        const claimRef = database.ref(`emergencySlotClaims/${year}/${slotId}`);
        // 无条件尝试占位，成败由数据库规则权威裁决：
        // - 无占位/残留占位（对应预约已删除或已取消）→ 规则允许写入
        // - 有效占位（其他同学正在完成预约）→ 规则拒绝 → 提示已被约
        const claimResult = await claimRef.transaction(() => reservationId, undefined, false);
        if (!claimResult.committed || claimResult.snapshot.val() !== reservationId) {
            throw apiError('该时间段刚刚被其他同学预约，请刷新后重试。', 'SLOT_UNAVAILABLE');
        }

        const reservation = {
            nickname,
            slotId,
            reservationId,
            time: parsedSlot.formattedSlotText,
            status: 'booked',
            cancelCode,
            slotSnapshot: slotSnapshotData,
            timestamp
        };
        try {
            await database.ref(`years/${year}/reservations/${reservationId}`).set(reservation);
            const slotResult = await database.ref(`years/${year}/slots/${slotId}`).transaction(current => {
                if (!current || current.status === 'hidden' || current.reserved || current.time !== slot.time) return;
                return { ...current, reserved: true, reservationId };
            }, undefined, false);
            if (!slotResult.committed) {
                throw apiError('预约提交异常，请稍后刷新查看，或联系老师确认。', 'EMERGENCY_SLOT_SYNC_FAILED');
            }
            // 预约成功：清理自己的应急占位（规则允许预约已存在时删除；失败也无妨，取消/教师流程会兜底清理）
            await database.ref(`emergencySlotClaims/${year}/${slotId}`).remove().catch(() => null);
        } catch (error) {
            if (error && error.reason) throw error;
            throw apiError('预约保存未完成，请不要重复提交，稍后刷新查看或联系老师。', 'EMERGENCY_SAVE_FAILED');
        }

        return {
            nickname,
            time: parsedSlot.formattedSlotText,
            cancelCode,
            slotSnapshot: slotSnapshotData,
            reservationId,
            emergencyMode: true
        };
    }

    async function createBooking(payload) {
        let result;
        try {
            result = await call('createBooking', payload);
        } catch (error) {
            if (!settings.emergencyDirectBookingFallback || !isBackendUnavailable(error)) throw error;
            console.warn('后端当前不可达，切换到直连预约通道。', error);
            result = await createBookingEmergency(payload);
        }
        // 记录到本机（后端不可达时历史/取消兜底用）
        rememberLocalReservation({
            year: String(payload && payload.year || ''),
            reservationId: String(result && result.reservationId || ''),
            slotId: String(payload && payload.slotId || ''),
            nickname: String(result && result.nickname || ''),
            time: String(result && result.time || ''),
            cancelCode: String(result && result.cancelCode || ''),
            bookedAt: Date.now(),
            status: 'booked'
        });
        return result;
    }

    async function getBookingHistory(payload) {
        try {
            const response = await call('getBookingHistory', payload);
            // 成功后同步本机记录状态（教师端完成/取消等变更）
            (response.reservations || []).forEach(r => updateLocalReservationStatus(r.id, r.status));
            return response;
        } catch (error) {
            if (!isBackendUnavailable(error)) throw error;
            // 后端不可达：用本机记录兜底（只显示本人预约过的记录，凭证码验证后可见）
            const code = normalizeHalfWidth(String(payload && payload.cancelCode || '')).trim().toUpperCase();
            const name = String(payload && payload.nickname || '').trim();
            const year = String(payload && payload.year || '');
            // 云端墓碑过滤：教师删除的预约（本机无法感知云端删除，靠墓碑同步清理幽灵记录）
            let ghostRemoved = 0;
            let localList = readLocalReservations().filter(r => r.year === year && r.nickname === name);
            try {
                const tombSnap = await firebase.database().ref(`years/${year}/reservationTombstones`).once('value');
                const tombs = tombSnap.val() || {};
                const tombKeys = Object.keys(tombs);
                if (tombKeys.length) {
                    const before = localList.length;
                    localList = localList.filter(r => !(tombs[r.reservationId] && (r.status || 'booked') !== 'canceled'));
                    ghostRemoved = before - localList.length;
                    if (ghostRemoved > 0) {
                        const tombsSet = tombKeys.reduce((acc, k) => { acc[k] = true; return acc; }, {});
                        writeLocalReservations(readLocalReservations().filter(r => !(tombsSet[r.reservationId] && (r.status || 'booked') !== 'canceled')));
                    }
                }
            } catch (e) { /* 墓碑读取失败不影响兜底查询 */ }
            window.__localHistoryGhostRemoved = ghostRemoved;
            if (!localList.some(r => r.cancelCode === code)) {
                throw apiError('姓名或凭证码错误。', 'HISTORY_AUTH_FAILED');
            }
            const reservations = localList.map(r => ({
                id: r.reservationId,
                nickname: r.nickname,
                time: r.time,
                status: r.status || 'booked',
                cancelCode: r.cancelCode,
                timestamp: Number(r.bookedAt || 0)
            })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            const usedHours = reservations.filter(r => r.status !== 'canceled').reduce((sum, r) => sum + calcHoursLocal(r.time), 0);
            window.__localHistoryMode = true;
            return { reservations, sessionToken: '', expiresAt: 0, summary: { completedHours: 0, usedHours, totalHours: null, remainingHours: null } };
        }
    }

    // 凭证码直连取消：规则校验凭证后放行（大陆后端不可达时的兜底）
    async function cancelBookingEmergency(payload) {
        const year = String(payload.year || '');
        const reservationId = String(payload.reservationId || '');
        const nickname = String(payload.nickname || '').trim();
        const cancelCode = normalizeHalfWidth(String(payload.cancelCode || '')).trim().toUpperCase();
        const slotId = String(payload.slotId || '');
        if (!/^\d{4}$/.test(year) || !/^[A-Za-z0-9_-]{1,100}$/.test(reservationId) || !nickname ||
            !/^[A-Z0-9]{5}$/.test(cancelCode) || !/^[A-Za-z0-9_-]{1,100}$/.test(slotId)) {
            throw apiError('取消凭证格式不完整，请刷新后重试。', 'INVALID_ARGUMENT');
        }
        const database = firebase.database();
        const timestamp = Date.now();
        try {
            await database.ref(`emergencyCancelRequests/${year}/${reservationId}`).set({
                reservationId, year, nickname, cancelCode, slotId, timestamp
            });
        } catch (error) {
            // 规则拒绝：可能云端记录已被教师删除（幽灵记录），或凭证不匹配。
            // 客户端无法区分，统一标记候选，由界面提示用户选择是否清理本机记录。
            throw apiError('该预约无法取消：云端记录不存在或凭证有误。', 'EMERGENCY_CANCEL_AUTH_FAILED', { ghostCandidate: true });
        }
        // 标记取消（规则校验凭证后放行）
        const statusResult = await database.ref(`years/${year}/reservations/${reservationId}/status`).transaction(current => {
            if (!current || current === 'canceled') return;
            return 'canceled';
        }, undefined, false);
        if (!statusResult.committed) throw apiError('该预约已无法取消，请刷新后重试。', 'RESERVATION_NOT_CANCELABLE');
        // 释放排班（规则校验取消请求 + 预约已取消后放行）
        let slotReleased = false;
        try {
            const releaseResult = await database.ref(`years/${year}/slots/${slotId}/reserved`).transaction(current => {
                if (current !== true) return;
                return false;
            }, undefined, false);
            slotReleased = releaseResult.committed;
        } catch (error) {
            slotReleased = false;
        }
        // 清理占位与本机记录
        await database.ref(`emergencySlotClaims/${year}/${slotId}`).remove().catch(() => null);
        await database.ref(`emergencyCancelRequests/${year}/${reservationId}`).remove().catch(() => null);
        updateLocalReservationStatus(reservationId, 'canceled');
        return { canceled: true, slotReleased };
    }

    async function cancelBooking(payload) {
        const reservationId = String(payload && payload.reservationId || '');
        const year = String(payload && payload.year || '');
        if (payload && payload.sessionToken) {
            try {
                const result = await call('cancelBooking', payload);
                updateLocalReservationStatus(reservationId, 'canceled');
                return result;
            } catch (error) {
                if (!isBackendUnavailable(error)) throw error;
            }
        }
        // 后端不可达或无查询会话：凭证码直连取消（本机记录提供 resId/slotId/凭证）
        const local = readLocalReservations().find(r => r.reservationId === reservationId && r.year === year);
        if (!local) throw apiError('本机没有这条预约记录，无法直连取消。请稍后重试或联系老师。', 'LOCAL_RECORD_MISSING');
        return cancelBookingEmergency({
            year, reservationId, nickname: local.nickname, cancelCode: local.cancelCode, slotId: local.slotId
        });
    }

    // 考试直连通道：规则校验口令/名单/试卷登记/票据/时间窗后放行（大陆后端不可达时的兜底）
    async function startExamEmergency(payload) {
        const year = String(payload && payload.year || '');
        const studentName = String(payload && payload.studentName || '').trim();
        const examId = String(payload && payload.examId || '');
        const examTicket = String(payload && payload.examTicket || '');
        const accessCode = String(payload && payload.accessCode || '');
        if (!/^\d{4}$/.test(year) || !/^[A-Za-z0-9_-]{20,100}$/.test(examId) || !studentName ||
            examTicket.length < 32 || examTicket.length > 200 || !accessCode) {
            throw apiError('考试信息格式不完整，请重新导入试卷。', 'INVALID_ARGUMENT');
        }
        const sessionId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
        const timestamp = Date.now();
        const sessionData = {
            sessionId,
            year,
            studentName,
            studentKey: studentIndexKey(studentName),
            examId,
            paperTitle: String(payload && payload.paperTitle || ''),
            ticket: examTicket,
            accessCode,
            timestamp
        };
        try {
            await firebase.database().ref(`emergencyExamSessions/${year}/${sessionId}`).set(sessionData);
        } catch (error) {
            throw apiError('考试验证未通过（口令、名单或试卷登记不正确，或不在考试时段内），请重试或联系老师。', 'EMERGENCY_EXAM_AUTH_FAILED');
        }
        rememberEmergencyExamSession({ sessionId, year, examId, studentName });
        return { status: 'ready', sessionToken: sessionId, startTime: payload && payload.startTime, endTime: payload && payload.endTime };
    }

    // 考试直连交卷：规则校验会话后写入交卷锁（仅一次）
    async function submitExamEmergency(payload) {
        const sessionToken = String(payload && payload.sessionToken || '');
        const session = findEmergencyExamSession(sessionToken);
        if (!session) throw apiError('考试会话已失效，请保留答案并重新验证。', 'EXAM_SESSION_EXPIRED');
        const receiptId = `EX-${randomCancelCode()}-${randomCancelCode()}`;
        const submittedAt = Date.now();
        const database = firebase.database();
        try {
            await database.ref(`submittedExamLocks/${session.examId}/${session.studentName}`).set({
                status: 'submitted',
                receiptId,
                submittedAt,
                clientToken: sessionToken,
                createdAt: submittedAt,
                emergencySession: sessionToken,
                year: session.year
            });
        } catch (error) {
            throw apiError('该试卷已经交卷。', 'EXAM_ALREADY_SUBMITTED');
        }
        await database.ref(`emergencyExamSessions/${session.year}/${sessionToken}`).remove().catch(() => null);
        removeEmergencyExamSession(sessionToken);
        return { receiptId, submittedAt };
    }

    async function startExam(payload) {
        try {
            return await call('startExam', payload);
        } catch (error) {
            if (!isBackendUnavailable(error)) throw error;
            console.warn('后端当前不可达，切换到考试直连通道。', error);
            return startExamEmergency(payload);
        }
    }

    async function submitExam(payload) {
        try {
            return await call('submitExam', payload);
        } catch (error) {
            if (!isBackendUnavailable(error)) throw error;
            console.warn('后端当前不可达，切换到考试直连交卷。', error);
            return submitExamEmergency(payload);
        }
    }

    // 从本机预约记录中移除一条（用于清理"云端已删除"的幽灵记录）
    function removeLocalReservation(reservationId) {
        const list = readLocalReservations().filter(r => r.reservationId !== String(reservationId || ''));
        writeLocalReservations(list);
        return true;
    }

    global.StudentApi = Object.freeze({
        init,
        createBooking,
        getBookingHistory,
        cancelBooking,
        startExam,
        submitExam,
        removeLocalReservation
    });

    // 在学生页面开始读取 Firebase 数据前激活 App Check；这样日后即使同时对 Realtime Database 开启强制校验，公开排班也不会失效。
    if (settings.appCheckSiteKey) init();
})(window);
