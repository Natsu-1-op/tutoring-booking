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
        const claimResult = await claimRef.transaction(current => current == null ? reservationId : undefined, undefined, false);
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
            emergencyMode: true
        };
    }

    async function createBooking(payload) {
        try {
            return await call('createBooking', payload);
        } catch (error) {
            if (!settings.emergencyDirectBookingFallback || !isBackendUnavailable(error)) throw error;
            console.warn('安全后端当前不可达，切换到受限应急预约通道。', error);
            return createBookingEmergency(payload);
        }
    }

    global.StudentApi = Object.freeze({
        init,
        createBooking,
        getBookingHistory: payload => call('getBookingHistory', payload),
        cancelBooking: payload => call('cancelBooking', payload),
        startExam: payload => call('startExam', payload),
        submitExam: payload => call('submitExam', payload)
    });

    // 在学生页面开始读取 Firebase 数据前激活 App Check；这样日后即使同时对 Realtime Database 开启强制校验，公开排班也不会失效。
    if (settings.appCheckSiteKey) init();
})(window);
