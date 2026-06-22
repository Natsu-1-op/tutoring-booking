// config/firebase-env.js
const firebaseConfig = {
  apiKey: "AIzaSyB6EbZElw7ahDN5rOK-keWlgr9JInVbnN4",
  authDomain: "class-optic.firebaseapp.com",
  projectId: "class-optic",
  storageBucket: "class-optic.firebasestorage.app",
  messagingSenderId: "859111669333",
  appId: "1:859111669333:web:ec5cea5bd22dc0c495dedc",
  databaseURL: "https://class-optic-default-rtdb.asia-southeast1.firebasedatabase.app" 
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// 顶层解耦数据路径路由器：统一分发多学年分流指针
const SystemRouter = {
    activeYear: null,  
    activeName: "专业课辅导预约系统",
    
    system: () => db.ref('system'),
    yearsRoot: () => db.ref('years'),
    
    getSlotsRef: (year) => db.ref(`years/${year || SystemRouter.activeYear}/slots`),
    getReservationsRef: (year) => db.ref(`years/${year || SystemRouter.activeYear}/reservations`),
    getSettingsRef: (year) => db.ref(`years/${year || SystemRouter.activeYear}/settings`),
    getLocksRef: (year) => db.ref(`years/${year || SystemRouter.activeYear}/dailyLocks`),
    getLogsRef: (year) => db.ref(`years/${year || SystemRouter.activeYear}/operationLog`)
};

// 全自动化安全 HTML 实体转义引擎，防止 XSS 注入
function escapeHtml(unsafe) {
    return (unsafe || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
        .replace(/\//g, "&#x2F;");
}