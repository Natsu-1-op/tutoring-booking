"use strict";
(async () => {
    const gate = document.getElementById("internal-gate");
    const status = document.getElementById("internal-status");
    const launch = new URLSearchParams(location.hash.slice(1));
    const secret = launch.get("key");
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return;

    const release = JSON.parse(document.getElementById("internal-config").textContent);
    const encoder = new TextEncoder();
    const fromBase64 = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0));
    let key;
    let bank;
    let cacheSize = 0;
    const cache = new Map();
    const limit = 16 * 1024 * 1024;
    status.textContent = "正在打开题库…";

    async function decrypt(path,signal) {
        const response = await fetch(new URL("content/" + release + "/" + path + ".bin", location.href), {signal});
        if (!response.ok) throw new Error("题库文件暂时无法读取。");
        const sealed = new Uint8Array(await response.arrayBuffer());
        if (sealed.length < 29) throw new Error("题库文件不完整。");
        return crypto.subtle.decrypt({
            name:"AES-GCM",iv:sealed.subarray(0,12),
            additionalData:encoder.encode("hust839:" + release + ":" + path),
        },key,sealed.subarray(12));
    }
    try {
        key = await crypto.subtle.importKey("raw",fromBase64(secret),{name:"AES-GCM"},false,["decrypt"]);
        const raw = await decrypt("index");
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
        const text = await new Response(stream).text();
        bank = JSON.parse(text);

        window.questionBankHash = id => "#" + new URLSearchParams({key:secret,q:id});
        window.questionBankId = () => new URLSearchParams(location.hash.slice(1)).get("q") || "";
        window.loadProtectedAsset = async (id,type,signal) => {
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
    } catch (error) {
        gate.hidden = false;
        document.documentElement.classList.add("bank-locked");
        status.textContent = error.name === "OperationError" ?
            "这个内部链接已失效或不完整。" : "题库暂时无法打开，请刷新重试。";
    }
})();
