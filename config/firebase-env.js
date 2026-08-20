// config/firebase-env.js
// Firebase Web 配置不是服务端密钥；复用本项目时必须替换为部署者自己的项目配置。课时费页面也复用这里的配置。
const firebaseConfig = {
  apiKey: "AIzaSyB6EbZElw7ahDN5rOK-keWlgr9JInVbnN4",
  authDomain: "class-optic.firebaseapp.com",
  projectId: "class-optic",
  storageBucket: "class-optic.firebasestorage.app",
  messagingSenderId: "859111669333",
  appId: "1:859111669333:web:ec5cea5bd22dc0c495dedc",
  databaseURL: "https://class-optic-default-rtdb.asia-southeast1.firebasedatabase.app" 
};

window.__FIREBASE_CONFIG__ = firebaseConfig;

// Firebase Console -> App Check -> Web 应用中创建 reCAPTCHA Enterprise/v3 密钥后填入。
// 学生写操作全部通过强制 App Check 的 Cloud Functions；缺少密钥时会明确阻止提交，不会退回匿名直写数据库。
window.__STUDENT_API_CONFIG__ = {
    region: "asia-southeast1",
    provider: "recaptcha-v3",
    appCheckSiteKey: "6LdpbY8tAAAAALSPaYpNJJ0NAouRj6tlD2ixCDGd"
};

// money.html 只需要读取配置并由教师认证模块初始化 Firebase，避免和它自己的 db 变量冲突。
if (!window.__SKIP_FIREBASE_ENV_INIT__) {
    firebase.initializeApp(firebaseConfig);
    const sharedDb = firebase.database();

    // 顶层解耦数据路径路由器：统一分发多学年分流指针
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

    // 保持旧页面通过全局变量访问数据库路由和转义函数。
    window.db = sharedDb;
    window.SystemRouter = SystemRouter;
}

// 全自动化安全 HTML 实体转义引擎，防止 XSS 注入
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
