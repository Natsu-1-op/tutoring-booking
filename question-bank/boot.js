"use strict";
(async () => {
    const files = document.currentScript.dataset;
    const status = document.getElementById("internal-status");
    function load(src, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            const timer = setTimeout(() => finish(new Error("script timeout")), timeout);
            function finish(error) {
                clearTimeout(timer);
                script.onload = script.onerror = null;
                if (error) {
                    script.remove();
                    reject(error);
                } else resolve();
            }
            script.onload = () => finish();
            script.onerror = () => finish(new Error("script unavailable"));
            script.src = src;
            document.head.append(script);
        });
    }

    const linkToken = () => new URLSearchParams(location.hash.slice(1)).get("key");
    const token = linkToken();
    addEventListener("hashchange", () => {
        if (linkToken() !== token) location.reload();
    });
    const linkMode = Boolean(token);
    if (!linkMode) {
        status.textContent = "正在连接邮箱登录服务…";
        const sdk = "https://www.gstatic.com/firebasejs/8.10.1/firebase-";
        try {
            // Auth 和 Database 都依赖 firebase-app。
            await load(sdk + "app.js");
            await Promise.all([load(sdk + "auth.js"), load(sdk + "database.js")]);
            await load(files.account);
            if (!window.qbankAccount) throw new Error("account initialization failed");
        } catch {
            status.textContent = "邮箱登录组件加载失败。可运行网络检测，或向老师索取有效的题库内部链接。";
            return;
        }
    }
    try {
        await load(files.access);
    } catch {
        status.textContent = "题库页面脚本加载失败，请刷新后重试。";
    }
})();
