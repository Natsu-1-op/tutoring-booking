// 复制为 config/firebase-env.js，再填写你自己的 Firebase Web 配置。
// 这个示例文件不包含任何项目凭据。
const firebaseConfig = {
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: "",
    databaseURL: ""
};

window.__FIREBASE_CONFIG__ = firebaseConfig;

window.__STUDENT_API_CONFIG__ = {
    apiBaseUrl: "https://your-worker.workers.dev",
    provider: "recaptcha-v3",
    appCheckSiteKey: "",
    allowClientChallengeFallback: true
};

if (!window.__SKIP_FIREBASE_ENV_INIT__) {
    firebase.initializeApp(firebaseConfig);
    const sharedDb = firebase.database();
    const SystemRouter = {
        activeYear: null,
        activeName: "专业课辅导预约系统",
        system: () => sharedDb.ref('system'),
        yearsRoot: () => sharedDb.ref('years'),
        getSlotsRef: (year) => sharedDb.ref(`years/${year || SystemRouter.activeYear}/slots`),
        getReservationsRef: (year) => sharedDb.ref(`years/${year || SystemRouter.activeYear}/reservations`),
        getSettingsRef: (year) => sharedDb.ref(`years/${year || SystemRouter.activeYear}/settings`),
        getLogsRef: (year) => sharedDb.ref(`years/${year || SystemRouter.activeYear}/operationLog`)
    };
    window.db = sharedDb;
    window.SystemRouter = SystemRouter;
}

function escapeHtml(unsafe) {
    return String(unsafe ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
        .replace(/\//g, "&#x2F;");
}
window.escapeHtml = escapeHtml;
