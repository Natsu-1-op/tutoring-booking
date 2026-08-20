(function createStudentApi(global) {
    'use strict';

    const settings = global.__STUDENT_API_CONFIG__ || {};
    let initialized = false;
    let apiBaseUrl = '';
    let appCheckEnabled = false;

    function withTimeout(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('安全校验服务连接超时'));
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

    async function getClientChallenge() {
        const response = await fetch(`${apiBaseUrl}/challenge`, { method: 'GET', cache: 'no-store' });
        let body = null;
        try { body = await response.json(); } catch (error) {}
        if (!response.ok || !body || !body.data || !body.data.id || !body.data.salt) {
            throw new Error('兼容安全校验服务暂时不可用，请刷新页面重试。');
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
        throw new Error('兼容安全校验未完成，请刷新页面重试。');
    }

    async function call(name, payload) {
        init();
        try {
            let appCheckToken = null;
            if (appCheckEnabled) {
                try {
                    // reCAPTCHA 在大陆可能一直等待网络响应，必须超时后进入兼容路径。
                    appCheckToken = await withTimeout(firebase.appCheck().getToken(false), 3500);
                    if (!appCheckToken || !appCheckToken.token) appCheckToken = null;
                } catch (error) {
                    console.warn('App Check 获取失败，将使用兼容验证：', error);
                }
            }
            if (!appCheckToken && settings.allowClientChallengeFallback === false) {
                throw new Error('安全校验令牌获取失败，请刷新页面后重试。');
            }
            const challenge = appCheckToken ? null : await getClientChallenge();
            const headers = { 'content-type': 'application/json' };
            if (appCheckToken) headers['X-Firebase-AppCheck'] = appCheckToken.token;
            else {
                headers['X-Student-Challenge-Id'] = challenge.id;
                headers['X-Student-Challenge-Nonce'] = challenge.nonce;
            }
            const response = await fetch(`${apiBaseUrl}/${encodeURIComponent(name)}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload || {})
            });
            let body = null;
            try { body = await response.json(); } catch (parseError) {}
            if (!response.ok || !body || body.error) {
                const serverError = body && body.error || {};
                const normalized = new Error(serverError.message || '服务暂时不可用，请稍后重试。');
                normalized.code = `http-${response.status}`;
                normalized.details = serverError.details || {};
                normalized.reason = serverError.reason || '';
                throw normalized;
            }
            return body.data;
        } catch (error) {
            if (error && error.reason) throw error;
            const normalized = new Error(error && error.message ? String(error.message).replace(/^Firebase:\s*/i, '') : '服务暂时不可用，请稍后重试。');
            normalized.code = error && error.code || '';
            normalized.details = error && error.details || {};
            normalized.reason = normalized.details && normalized.details.reason || '';
            throw normalized;
        }
    }

    global.StudentApi = Object.freeze({
        init,
        createBooking: payload => call('createBooking', payload),
        getBookingHistory: payload => call('getBookingHistory', payload),
        cancelBooking: payload => call('cancelBooking', payload),
        startExam: payload => call('startExam', payload),
        submitExam: payload => call('submitExam', payload)
    });

    // 在学生页面开始读取 Firebase 数据前激活 App Check；这样日后即使同时对 Realtime Database 开启强制校验，公开排班也不会失效。
    if (settings.appCheckSiteKey) init();
})(window);
