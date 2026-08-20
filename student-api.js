(function createStudentApi(global) {
    'use strict';

    const settings = global.__STUDENT_API_CONFIG__ || {};
    const region = settings.region || 'asia-southeast1';
    let initialized = false;
    let functionsClient = null;

    function init() {
        if (initialized) return;
        if (!global.firebase || !firebase.apps.length || typeof firebase.functions !== 'function') {
            throw new Error('学生安全接口未正确加载，请刷新页面。');
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
        functionsClient = firebase.app().functions(region);
        initialized = true;
    }

    async function call(name, payload) {
        init();
        try {
            const result = await functionsClient.httpsCallable(name)(payload || {});
            return result.data;
        } catch (error) {
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
