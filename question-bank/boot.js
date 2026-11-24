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

    const credentials = () => {
        const hash = new URLSearchParams(location.hash.slice(1));
        return JSON.stringify([hash.get("key"), hash.get("pass")]);
    };
    const initialCredentials = credentials();
    const hash = new URLSearchParams(location.hash.slice(1));
    addEventListener("hashchange", () => {
        if (credentials() !== initialCredentials) location.reload();
    });
    const passMode = hash.has("pass");
    const linkMode = hash.has("key");
    try { await load(files.personalPass); }
    catch {
        if (passMode) {
            status.textContent = "个人通行证组件无法加载，请刷新重试。";
            return;
        }
    }
    if (!linkMode && !passMode) {
        const email = document.getElementById("gate-use-email");
        const pass = document.getElementById("gate-use-pass");
        const passForm = document.getElementById("personal-pass-form");
        const preference = "qbank-email-entry";
        async function enterWithEmail() {
            email.disabled = true;
            status.textContent = "正在连接邮箱登录服务…";
            const sdk = "https://www.gstatic.com/firebasejs/8.10.1/firebase-";
            try {
                if (!window.firebase) await load(sdk + "app.js");
                await Promise.all([
                    window.firebase.auth || load(sdk + "auth.js"),
                    window.firebase.database || load(sdk + "database.js")
                ]);
                if (!window.qbankAccount) await load(files.account);
                if (!window.qbankAccount) throw new Error("account initialization failed");
                await load(files.access);
                try { sessionStorage.setItem(preference, "1"); } catch {}
                passForm.hidden = true;
                email.hidden = true;
                pass.hidden = false;
            } catch {
                status.textContent = "邮箱服务连接失败。可重试，或使用通行证进入。";
            } finally {
                email.disabled = false;
            }
        }
        email.hidden = false;
        email.addEventListener("click", enterWithEmail);
        pass.addEventListener("click", () => {
            try { sessionStorage.removeItem(preference); } catch {}
            location.reload();
        });
        let resumeEmail;
        try { resumeEmail = sessionStorage.getItem(preference); } catch {}
        if (resumeEmail) await enterWithEmail();
        return;
    }
    try {
        await load(files.access);
    } catch {
        status.textContent = "题库页面脚本加载失败，请刷新后重试。";
    }
})();
