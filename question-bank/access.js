"use strict";
(async () => {
    const gate = document.getElementById("internal-gate");
    const status = document.getElementById("internal-status");
    const launch = new URLSearchParams(location.hash.slice(1));
    const token = launch.get("key");
    const config = JSON.parse(document.getElementById("internal-config").textContent);
    const encoder = new TextEncoder();
    const fromBase64 = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0));
    const grantURL = config.database + "/questionBankAccess/links/" + token + "/delivery.json";
    const cache = new Map();
    const limit = 16 * 1024 * 1024;
    const denied = "链接已到期或停用，请向管理员获取新链接。";
    const personalMode = launch.has("pass");
    const account = personalMode ? window.qbankPersonalPass : null;
    const linkMode = !personalMode && Boolean(token);
    let cacheSize = 0;
    let bank, key, expiresAt, pendingCheck, poll, deadline;
    let locked = false;

    async function fetchWithTimeout(url, read, options = {}, timeout = 10000) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const originalSignal = options.signal;
        if (originalSignal?.aborted) cancel();
        originalSignal?.addEventListener("abort", cancel, {once:true});
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            return await read(await fetch(url, {...options, signal:controller.signal}));
        } finally {
            clearTimeout(timer);
            originalSignal?.removeEventListener("abort", cancel);
        }
    }

    // 通行证模式：没有内部链接时走「个人通行证」通道
    if (!linkMode) {
        if (!account) {
            if (personalMode) return;
            status.textContent = "请使用个人通行证或限时链接进入题库。";
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
            let grant;
            try {
                grant = await fetchWithTimeout(grantURL, async response => {
                    if (response.status === 401 || response.status === 403) return null;
                    if (!response.ok) throw new Error("核验失败");
                    return await response.json();
                }, {cache:"no-store",referrerPolicy:"no-referrer"});
            } catch {
                throw new Error("题库授权数据库暂时无法连接。请运行网络检测，或稍后刷新重试。");
            }
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
        if (personalMode) {
            account.lock();
            document.getElementById("question-data").textContent = "";
            document.documentElement.classList.add("bank-locked");
            gate.hidden = false;
            status.textContent = "在线会话已结束。请刷新重新登录。";
            return;
        }
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
            if (locked) return;
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
        clearTimeout(deadline);
        const remaining = expiresAt - Date.now();
        deadline = setTimeout(() => {
            if (Date.now() >= expiresAt) closeBank();
            else armExpiry();
        }, Math.max(0,Math.min(remaining,12*60*60*1000)));
    }
    async function decrypt(path,signal) {
        if (locked || Date.now() >= expiresAt) throw new Error(linkMode ? denied : "题库权限已到期，请重新登录。");
        if (personalMode && path !== (config.indexPath || "index") && !await account.verify()) {
            closeBank();
            throw new Error("当前设备的在线会话已结束。");
        }
        let sealed;
        try {
            const url = new URL("content/" + config.release + "/" + path + ".bin", location.href);
            sealed = new Uint8Array(await fetchWithTimeout(url, async response => {
                if (!response.ok) throw new Error("题库文件读取失败");
                return await response.arrayBuffer();
            }, {signal}, 20000));
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new Error("题库文件下载失败或超时，请检查网站连接后重试。");
        }
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
            : new URLSearchParams(personalMode ? {pass:launch.get("pass"), q:id} : {q:id}));
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
        poll = setInterval(recheck,personalMode ? 25000 : 300000);
        document.addEventListener("visibilitychange",()=>{ if (!document.hidden) recheck(); });
    } catch (error) {
        gate.hidden = false;
        document.documentElement.classList.add("bank-locked");
        status.textContent = error.name === "OperationError"
            ? (linkMode ? "链接验证失败，请获取新链接。" : "密钥校验失败，请重新激活或联系管理员。")
            : error.message;
    }
})();
