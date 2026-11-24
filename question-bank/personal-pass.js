"use strict";
(() => {
    const $ = id => document.getElementById(id);
    const config = JSON.parse($("internal-config").textContent);
    const pass = new URLSearchParams(location.hash.slice(1)).get("pass");
    const status = $("internal-status");
    const form = $("personal-pass-form");
    const validCode = /^[A-Za-z0-9_-]{32}$/;
    const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(24)),
        byte => byte.toString(16).padStart(2, "0")).join("");

    form.hidden = Boolean(pass) || new URLSearchParams(location.hash.slice(1)).has("key");
    // A submit before the script loads must never put the pass into the query string.
    form.addEventListener("submit", event => {
        event.preventDefault();
        const value = $("personal-pass-input").value.trim();
        if (validCode.test(value)) location.hash = new URLSearchParams({pass: value});
        else status.textContent = "请输入完整的个人通行证。";
    });
    if (!pass) return;
    if (!validCode.test(pass)) {
        status.textContent = "个人通行证格式不正确。";
        return;
    }

    // Bearer capabilities are kept only in this browser. Never log them.
    const stateKey = "qbank-device:" + pass;
    let device;
    let session;
    let lastSeen = 0;
    let pending;
    let revoked = false;
    const takeover = $("personal-pass-takeover");
    const unlink = $("personal-pass-unlink");
    const exit = $("personal-pass-exit");

    async function request(path, {query, value} = {}) {
        const url = new URL(config.database + "/bankPersonalPasses/" + pass + "/" + path + ".json");
        if (query) url.search = new URLSearchParams(query);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(url, {
                method: value ? "PUT" : "GET",
                headers: value ? {"Content-Type": "application/json"} : undefined,
                body: value ? JSON.stringify(value) : undefined,
                cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal
            });
            if (response.status === 401 || response.status === 403) return null;
            if (!response.ok) throw new Error("个人通行证服务暂时不可用。");
            return await response.json();
        } catch (error) {
            if (error.name === "AbortError" || error instanceof TypeError) {
                throw new Error("连接题库授权数据库超时，请检查网络后重试。");
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function saveDevice(slot, proof) {
        localStorage.setItem(stateKey, JSON.stringify({slot, proof}));
    }

    async function enroll() {
        // Record the attempt before sending it so a lost response does not lose the device secret.
        const saved = JSON.parse(localStorage.getItem(stateKey) || "null");
        const proof = /^[a-f0-9]{48}$/.test(saved?.proof || "") ? saved.proof : randomSecret();
        for (const slot of new Set([saved?.slot, "1", "2"].filter(Boolean))) {
            saveDevice(slot, proof);
            const result = await request("devices/" + slot, {value: {proof, released: false}});
            if (result) {
                return {slot, proof};
            }
        }
        return null;
    }

    function lease(released = false, replace = false) {
        return request("lease", {value: {
            slot: device.slot, proof: device.proof, session,
            seenAt: {".sv": "timestamp"}, released, takeover: replace
        }});
    }

    async function authenticate(replace = false) {
        if (revoked) return null;
        if (pending) return pending;
        pending = (async () => {
            if (!device) device = await enroll();
            if (!device) {
                status.textContent = "无法绑定此浏览器。通行证可能失效，或已绑定两台浏览器。请先从旧浏览器解绑，或联系老师重置。";
                return null;
            }
            unlink.hidden = false;
            if (!session) {
                session = sessionStorage.getItem(stateKey) || randomSecret();
                sessionStorage.setItem(stateKey, session);
            }
            if (!await lease(false, replace)) {
                takeover.hidden = false;
                status.textContent = "当前无法登录：可能已有另一台设备在线，或通行证已失效。若要换设备，请选择切换。";
                return null;
            }
            const result = await request("delivery", {query: {
                orderBy: JSON.stringify("$key"), startAt: JSON.stringify(session)
            }});
            const grant = result?.["~"];
            if (!grant) {
                status.textContent = "题库权限已失效或版本已更新，请联系老师。";
                return null;
            }
            lastSeen = Date.now();
            takeover.hidden = true;
            return {...grant, expiresAt: lastSeen + 90000};
        })().finally(() => { pending = null; });
        return pending;
    }

    function backToGate() {
        const url = new URL(location.href);
        url.hash = "";
        location.replace(url);
    }

    takeover.addEventListener("click", async () => {
        takeover.disabled = true;
        try {
            if (await authenticate(true)) location.reload();
        } catch (error) {
            status.textContent = error.message;
        } finally { takeover.disabled = false; }
    });
    unlink.addEventListener("click", async () => {
        if (!device || !confirm("确定解绑当前浏览器？解绑后可在另一台浏览器使用通行证。")) return;
        try {
            if (session) await lease(true);
            if (!await request("devices/" + device.slot, {value: {proof: device.proof, released: true}})) {
                throw new Error("无法解绑当前浏览器，请联系老师。");
            }
            localStorage.removeItem(stateKey);
            sessionStorage.removeItem(stateKey);
            backToGate();
        } catch (error) { status.textContent = error.message; }
    });
    exit.addEventListener("click", async () => {
        revoked = true;
        try { if (device && session) await lease(true); }
        finally { backToGate(); }
    });
    function showDeviceTools() {
        document.documentElement.classList.add("bank-locked");
        $("internal-gate").hidden = false;
        status.textContent = "此浏览器已绑定。解绑可腾出名额；返回题库可继续学习。";
        $("personal-pass-resume").hidden = false;
    }
    $("personal-pass-menu")?.addEventListener("click", showDeviceTools);
    $("personal-pass-resume").addEventListener("click", () => {
        if (revoked) return location.reload();
        $("internal-gate").hidden = true;
        document.documentElement.classList.remove("bank-locked");
        $("personal-pass-resume").hidden = true;
    });
    $("personal-pass-tools").hidden = false;
    if ($("personal-pass-menu")) $("personal-pass-menu").hidden = false;
    window.qbankPersonalPass = {
        storageScope: pass,
        getGrant: () => authenticate(),
        refresh: () => Date.now() - lastSeen >= 90000 ? Promise.resolve(null) : authenticate(),
        // Verify the lease before requesting new protected images.
        verify: async () => !revoked && Boolean(await authenticate()),
        lock: () => { revoked = true; }
    };
})();
