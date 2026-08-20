(function createStudentApi(global) {
    'use strict';

    const settings = global.__STUDENT_API_CONFIG__ || {};
    let initialized = false;
    let apiBaseUrl = '';

    function init() {
        if (initialized) return;
        if (!global.firebase || !firebase.apps.length) {
            throw new Error('学生安全接口未正确加载，请刷新页面。');
        }
        if (!settings.apiBaseUrl) {
            throw new Error('学生安全接口尚未配置，请联系管理员。');
        }
        if (!settings.appCheckSiteKey) {
            throw new Error('学生安全接口尚未完成 App Check 配置，请联系管理员。');
        }
        if (typeof firebase.appCheck !== 'function') {
            throw new Error('App Check 组件未正确加载，请刷新页面。');
        }
        const provider = settings.provider === 'recaptcha-v3'
            ? new firebase.appCheck.ReCaptchaV3Provider(settings.appCheckSiteKey)
            : new firebase.appCheck.ReCaptchaEnterpriseProvider(settings.appCheckSiteKey);
        firebase.appCheck().activate(provider, true);
        apiBaseUrl = String(settings.apiBaseUrl).replace(/\/$/, '');
        initialized = true;
    }

    async function call(name, payload) {
        init();
        try {
            const appCheckToken = await firebase.appCheck().getToken(false);
            if (!appCheckToken || !appCheckToken.token) throw new Error('安全校验令牌获取失败，请刷新页面后重试。');
            const response = await fetch(`${apiBaseUrl}/${encodeURIComponent(name)}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'X-Firebase-AppCheck': appCheckToken.token
                },
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
