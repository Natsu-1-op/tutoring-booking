"use strict";
/**
 * 839 题库 · 个人做题记忆
 * 本地优先：每次操作立刻写入 localStorage，保证零延迟；
 * 登录后防抖同步到 users/{uid}/bankMemory，换设备登录同一邮箱自动合并。
 * 数据结构：{ [编号]: { state:"mastered"|"wrong"|"", star:true|false, note:string, updatedAt:number } }
 */
(() => {
    const STORE = "hust839-bank-memory";
    const SYNC_DELAY = 900;
    const PUSH_DELAY = 400;

    const memory = new Map();
    const pending = new Set();
    const listeners = new Set();
    let user = null;
    let db = null;
    let timer = 0;
    let flushTimer = 0;
    let syncing = false;
    let available = true;

    try {
        const raw = localStorage.getItem(STORE);
        const parsed = raw ? JSON.parse(raw) : {};
        for (const [id, entry] of Object.entries(parsed || {})) {
            if (!entry || typeof entry !== "object") continue;
            memory.set(id, normalizeEntry(entry));
        }
    } catch {
        try { localStorage.removeItem(STORE); } catch { /* 隐私模式下忽略 */ }
    }

    function normalizeEntry(entry) {
        const state = entry.state === "mastered" || entry.state === "wrong" ? entry.state : "";
        return {
            state,
            star: entry.star === true,
            note: typeof entry.note === "string" ? entry.note.slice(0, 4000) : "",
            updatedAt: Number(entry.updatedAt) || 0,
        };
    }

    function blank() {
        return { state: "", star: false, note: "", updatedAt: 0 };
    }

    function entry(id) {
        return memory.get(id) || blank();
    }

    function isEmpty(value) {
        return !value.state && !value.star && !value.note.trim();
    }

    function persist() {
        if (!available) return;
        try {
            const plain = {};
            for (const [id, value] of memory) {
                if (!isEmpty(value)) plain[id] = value;
            }
            if (Object.keys(plain).length) localStorage.setItem(STORE, JSON.stringify(plain));
            else localStorage.removeItem(STORE);
        } catch {
            available = false;
        }
    }

    function emit() {
        for (const callback of listeners) {
            try { callback(); } catch (error) { console.error(error); }
        }
    }

    function write(id, patch) {
        const next = Object.assign(entry(id), patch, { updatedAt: Date.now() });
        if (isEmpty(next)) memory.delete(id);
        else memory.set(id, next);
        persist();
        pending.add(id);
        if (currentUid()) schedulePush();
        return next;
    }

    function schedulePush() {
        clearTimeout(timer);
        timer = setTimeout(push, SYNC_DELAY);
    }

    function service() {
        if (db) return db;
        const root = window.firebase;
        if (!root || !root.database) return null;
        if (!root.apps || !root.apps.length) return null;
        db = root.database();
        return db;
    }

    function currentUid() {
        const auth = window.firebase?.auth;
        if (!auth) return "";
        try {
            const instance = auth();
            return instance.currentUser?.uid || "";
        } catch {
            return "";
        }
    }

    async function push() {
        const ids = [...pending];
        if (!ids.length || syncing) return;
        const uid = currentUid();
        const database = uid ? service() : null;
        if (!uid || !database) return;
        syncing = true;
        const payload = {};
        for (const id of ids) {
            const value = memory.get(id);
            payload[id] = value ? value : null;
            pending.delete(id);
        }
        try {
            await database.ref("users/" + uid + "/bankMemory").update(payload);
            setStatus("");
        } catch (error) {
            // 失败回填，等下次触发再试
            for (const id of ids) pending.add(id);
            setStatus("云端同步失败：" + (error.message || "网络异常"), "warn");
        } finally {
            syncing = false;
            if (pending.size) schedulePush();
        }
    }

    function flush() {
        clearTimeout(timer);
        if (!pending.size) return;
        if (currentUid()) {
            push();
            return;
        }
        // 未登录（内部链接模式）只保留本机记录
        pending.clear();
    }

    async function pull() {
        const uid = currentUid();
        const database = uid ? service() : null;
        if (!uid || !database) {
            setStatus("未登录，记忆只保存在本机浏览器。", "warn");
            return;
        }
        let cloud;
        try {
            const snapshot = await database.ref("users/" + uid + "/bankMemory").once("value");
            cloud = snapshot.val() || {};
        } catch (error) {
            setStatus("云端记忆读取失败：" + (error.message || "网络异常"), "warn");
            return;
        }
        const merged = new Map();
        const upload = {};
        const ids = new Set([...Object.keys(cloud), ...memory.keys()]);
        for (const id of ids) {
            const remote = cloud[id] ? normalizeEntry(cloud[id]) : null;
            const local = memory.get(id) || null;
            if (remote && local) {
                // 逐题取较新的一份；本地更新则回传
                if (local.updatedAt >= remote.updatedAt) {
                    merged.set(id, local);
                    if (local.updatedAt > remote.updatedAt) upload[id] = local;
                } else {
                    merged.set(id, remote);
                }
            } else if (remote) {
                merged.set(id, remote);
            } else if (local) {
                merged.set(id, local);
                upload[id] = local;
            }
        }
        memory.clear();
        for (const [id, value] of merged) {
            if (!isEmpty(value)) memory.set(id, value);
        }
        persist();
        if (Object.keys(upload).length) {
            try {
                await database.ref("users/" + uid + "/bankMemory").update(upload);
            } catch (error) {
                setStatus("本机记忆上传失败：" + (error.message || "网络异常"), "warn");
            }
        }
        setStatus(memory.size ? "已同步 " + memory.size + " 条本机记忆。" : "");
        emit();
        if (typeof window.qbankRefresh === "function") window.qbankRefresh();
    }

    function setStatus(text, kind) {
        for (const node of document.querySelectorAll("[data-memory-status]")) {
            node.textContent = text;
            if (kind) node.dataset.kind = kind;
            else delete node.dataset.kind;
        }
    }

    function match(id, value) {
        const current = entry(id);
        if (value === "mastered") return current.state === "mastered";
        if (value === "wrong") return current.state === "wrong";
        if (value === "star") return current.star === true;
        if (value === "note") return Boolean(current.note.trim());
        if (value === "unmarked") return isEmpty(current);
        return true;
    }

    function decorate(button, id) {
        const current = entry(id);
        if (current.state === "wrong" || current.star || current.state === "mastered") {
            const dot = document.createElement("span");
            dot.className = "mem-dot" + (current.state === "wrong" ? "" : current.state === "mastered" ? " mastered" : " star");
            dot.title = current.state === "wrong" ? "错题" : current.state === "mastered" ? "已掌握" : "已收藏";
            button.append(dot);
        }
    }

    const LABELS = [
        { key: "mastered", text: "已掌握", title: "标记为已掌握" },
        { key: "wrong", text: "错题待重做", title: "标记为错题，加入待重做" },
    ];

    function mount(marks, question) {
        const id = question["编号"];
        const panel = document.createElement("section");
        panel.className = "study-panel";
        const head = document.createElement("h3");
        head.append(document.createTextNode("我的做题记忆"));
        panel.append(head);

        const actions = document.createElement("div");
        actions.className = "memory-actions";
        const buttons = new Map();
        for (const item of LABELS) {
            const node = document.createElement("button");
            node.type = "button";
            node.dataset.state = item.key;
            node.textContent = item.text;
            node.title = item.title;
            node.setAttribute("aria-pressed", String(entry(id).state === item.key));
            node.addEventListener("click", () => {
                const next = entry(id).state === item.key ? "" : item.key;
                write(id, { state: next });
                paint();
                afterChange();
            });
            buttons.set(item.key, node);
            actions.append(node);
        }
        const star = document.createElement("button");
        star.type = "button";
        star.dataset.star = "1";
        star.textContent = "收藏";
        star.title = "收藏这道题";
        star.setAttribute("aria-pressed", String(entry(id).star));
        star.addEventListener("click", () => {
            write(id, { star: !entry(id).star });
            paint();
            afterChange();
        });
        actions.append(star);

        const area = document.createElement("textarea");
        area.placeholder = "写下思路、错因或要记住的结论（自动保存）";
        area.maxLength = 4000;
        area.value = entry(id).note;
        area.setAttribute("aria-label", "个人做题笔记");
        area.addEventListener("input", () => {
            write(id, { note: area.value });
            paint();
        });

        const hint = document.createElement("p");
        hint.className = "study-hint";
        hint.setAttribute("data-memory-status", "");

        panel.append(actions, area, hint);

        function paint() {
            const current = entry(id);
            for (const [key, node] of buttons) node.setAttribute("aria-pressed", String(current.state === key));
            star.setAttribute("aria-pressed", String(current.star));
            if (currentUid()) {
                hint.textContent = "已登录，记忆会自动同步到云端。";
                delete hint.dataset.kind;
            } else {
                hint.textContent = "未登录，记忆只保存在本机浏览器。";
                hint.dataset.kind = "warn";
            }
        }

        function afterChange() {
            const filter = document.getElementById("memory");
            if (filter && filter.value && typeof window.qbankRefresh === "function") window.qbankRefresh();
        }

        paint();
        marks.append(panel);
        const sync = () => {
            if (!panel.isConnected) {
                listeners.delete(sync);
                return;
            }
            paint();
        };
        listeners.add(sync);
    }

    function boot() {
        const auth = window.firebase?.auth;
        if (!auth) return;
        try {
            auth().onAuthStateChanged(account => {
                user = account || null;
                clearTimeout(flushTimer);
                // 登录态确定后再拉云端，避免读到别人的数据
                flushTimer = setTimeout(() => {
                    if (account) pull();
                    else setStatus("未登录，记忆只保存在本机浏览器。", "warn");
                }, 0);
            });
        } catch (error) {
            console.error(error);
        }
        for (const event of ["pagehide", "visibilitychange"]) {
            addEventListener(event, () => {
                if (event === "visibilitychange" && !document.hidden) return;
                flush();
            });
        }
    }

    window.qbankStudy = { match, decorate, mount, boot, flush, pull, entry };
})();
