"use strict";
(async () => {
    const gate = document.getElementById("internal-gate");
    const status = document.getElementById("internal-status");
    const launch = new URLSearchParams(location.hash.slice(1));
    const token = launch.get("key");
    addEventListener("hashchange", () => {
        if (new URLSearchParams(location.hash.slice(1)).get("key") !== token) location.reload();
    });
    const config = JSON.parse(document.getElementById("internal-config").textContent);
    const encoder = new TextEncoder();
    const fromBase64 = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0));
    const grantURL = config.database + "/questionBankAccess/links/" + token + "/delivery.json";
    const cache = new Map();
    const limit = 16 * 1024 * 1024;
    const denied = "链接已到期或停用，请向管理员获取新链接。";
    const account = window.qbankAccount;
    const linkMode = Boolean(token);
    let cacheSize = 0;
    let bank, key, expiresAt, pendingCheck, poll, deadline;
    let locked = false;

    // 账号模式：没有内部链接时走「邮箱账号 + 激活码」通道
    if (!linkMode) {
        if (!account) {
            status.textContent = "题库加载失败，请刷新页面或联系管理员。";
            return;
        }
    } else if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
        status.textContent = "这个内部链接已失效，请向管理员获取新链接。";
        return;
    } else {
        status.textContent = "正在验证内部链接…";
    }

    async function validateLink() {
        if (pendingCheck) return pendingCheck;
        pendingCheck = (async () => {
            const response = await fetch(grantURL,{cache:"no-store",referrerPolicy:"no-referrer"});
            if (response.status === 401 || response.status === 403) return null;
            if (!response.ok) throw new Error("暂时无法核验链接，请稍后刷新。");
            const grant = await response.json();
            if (!grant || grant.release !== config.release || grant.revoked || !/^[A-Za-z0-9_-]{43}$/.test(grant.key)) return null;
            return grant;
        })().finally(()=>{pendingCheck = null;});
        return pendingCheck;
    }

    // 账号模式每次核验都向数据库重新确认登录态、激活状态与到期时间
    async function validateAccount(force) {
        return force ? account.refresh() : account.getGrant();
    }

    function closeBank() {
        locked = true;
        clearTimeout(deadline);
        clearInterval(poll);
        if (!linkMode) {
            location.reload();
            return;
        }
        const target = new URL(location.href);
        target.hash = "";
        target.searchParams.set("expired","1");
        location.replace(target.href);
    }
    async function recheck() {
        if (locked) return;
        try {
            const grant = linkMode ? await validateLink() : await validateAccount(true);
            if (!grant) closeBank();
            else if (grant.expiresAt !== expiresAt) {
                expiresAt = grant.expiresAt;
                armExpiry();
            }
        } catch {
            if (Date.now() >= expiresAt) closeBank();
        }
    }
    function armExpiry() {
        const remaining = expiresAt - Date.now();
        deadline = setTimeout(() => {
            if (Date.now() >= expiresAt) closeBank();
            else armExpiry();
        }, Math.max(0,Math.min(remaining,12*60*60*1000)));
    }
    async function decrypt(path,signal) {
        if (locked || Date.now() >= expiresAt) throw new Error(linkMode ? denied : "题库权限已到期，请重新激活。");
        const response = await fetch(new URL("content/" + config.release + "/" + path + ".bin", location.href), {signal});
        if (!response.ok) throw new Error("题库文件暂时无法读取。");
        const sealed = new Uint8Array(await response.arrayBuffer());
        if (sealed.length < 29) throw new Error("题库文件不完整。");
        return crypto.subtle.decrypt({
            name:"AES-GCM",iv:sealed.subarray(0,12),
            additionalData:encoder.encode("hust839:" + config.release + ":" + path),
        },key,sealed.subarray(12));
    }
    try {
        let grant;
        if (linkMode) {
            grant = await validateLink();
            if (!grant) { status.textContent = denied; return; }
        } else {
            grant = await validateAccount(false);
            // 无权限的具体原因由账号模块在门禁界面提示，这里保留其文案
            if (!grant) return;
        }
        expiresAt = grant.expiresAt;
        key = await crypto.subtle.importKey("raw",fromBase64(grant.key),{name:"AES-GCM"},false,["decrypt"]);
        const raw = await decrypt(config.indexPath || "index");
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
        const text = await new Response(stream).text();
        bank = JSON.parse(text);
        // 链接模式保留 key 参数以便刷新；账号模式的定位参数只带题目 id
        window.questionBankHash = id => "#" + (linkMode
            ? new URLSearchParams({key:token,q:id})
            : new URLSearchParams({q:id}));
        window.questionBankId = () => new URLSearchParams(location.hash.slice(1)).get("q") || "";
        window.loadProtectedAsset = async (id,type,signal) => {
            if (locked || Date.now() >= expiresAt) throw new Error(linkMode ? denied : "题库权限已到期，请重新激活。");
            const path = bank.assetPaths[id];
            if (!path) throw new Error("这道题的图片暂时不可用。");
            let blob = cache.get(id);
            if (blob) cache.delete(id);
            else {
                blob = new Blob([await decrypt(path,signal)],{type});
                if (signal?.aborted) throw new DOMException("Request cancelled","AbortError");
                if (!cache.has(id)) cacheSize += blob.size;
            }
            cache.set(id,blob);
            while (cacheSize > limit && cache.size) {
                const oldest = cache.keys().next().value;
                cacheSize -= cache.get(oldest).size;
                cache.delete(oldest);
            }
            return URL.createObjectURL(blob);
        };
        document.getElementById("question-data").textContent = text;
        gate.hidden = true;
        document.documentElement.classList.remove("bank-locked");
        window.startQuestionBank();
        armExpiry();
        poll = setInterval(recheck,60000);
        document.addEventListener("visibilitychange",()=>{ if (!document.hidden) recheck(); });
    } catch (error) {
        gate.hidden = false;
        document.documentElement.classList.add("bank-locked");
        status.textContent = error.name === "OperationError"
            ? (linkMode ? "链接验证失败，请获取新链接。" : "密钥校验失败，请重新激活或联系管理员。")
            : error.message;
    }
})();
