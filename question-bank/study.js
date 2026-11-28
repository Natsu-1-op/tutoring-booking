"use strict";
/**
 * 839 题库 · 个人做题记忆
 * 本地优先：每次操作立刻写入 localStorage，保证零延迟；
 * 付费通行证通过 RTDB REST 自动同步到 bankPersonalPasses/{pass}/bankMemory；
 * 免费通行证与限时链接纯存本机浏览器，支持 JSON 导出/导入备份。
 */
(() => {
    const STORE = "hust839-bank-memory";
    const PUSH_DELAY = 1500;

    const memory = new Map();
    const pending = new Set();
    const listeners = new Set();
    let scope = "";
    let timer = 0;
    let syncing = false;
    let available = true;

    function selectScope() {
        const passScope = window.qbankPersonalPass?.storageScope;
        const next = passScope ? STORE + ":pass:" + passScope : STORE;
        if (next === scope) return;
        scope = next;
        clearTimeout(timer);
        memory.clear();
        pending.clear();
        try {
            const saved = JSON.parse(localStorage.getItem(scope) || "{}");
            for (const [id, item] of Object.entries(saved || {})) {
                if (item && typeof item === "object") memory.set(id, normalizeEntry(item));
            }
        } catch { /* 浏览器存储不可用时保留当前会话 */ }
    }

    function normalizeEntry(item) {
        const state = item.state === "mastered" || item.state === "wrong" ? item.state : "";
        return {
            state,
            star: item.star === true,
            note: typeof item.note === "string" ? item.note.slice(0, 4000) : "",
            updatedAt: Number(item.updatedAt) || 0,
        };
    }

    function blank() {
        return { state: "", star: false, note: "", updatedAt: 0 };
    }

    function entry(id) {
        selectScope();
        return memory.get(id) || blank();
    }

    function isEmpty(value) {
        return !value.state && !value.star && !value.note.trim();
    }

    function persist() {
        if (!available) return;
        try {
            const plain = Object.create(null);
            for (const [id, value] of memory) {
                plain[id] = value;
            }
            if (Object.keys(plain).length) localStorage.setItem(scope, JSON.stringify(plain));
            else localStorage.removeItem(scope);
        } catch {
            available = false;
        }
    }

    function emit() {
        for (const subscriber of [...listeners]) {
            if (!subscriber.panel.isConnected) {
                listeners.delete(subscriber);
                continue;
            }
            try { subscriber.paint(); } catch (error) { console.error(error); }
        }
    }

    function isPaidPass() {
        return Boolean(window.qbankPersonalPass && window.qbankPersonalPass.tier !== "free");
    }

    function isFreePass() {
        return Boolean(window.qbankPersonalPass && window.qbankPersonalPass.tier === "free");
    }

    function notifyChange(id) {
        try {
            window.dispatchEvent(new CustomEvent("qbank-study-change", { detail: { id: id || "" } }));
        } catch {}
    }

    function write(id, patch) {
        const next = { ...entry(id), ...patch, updatedAt: Math.max(Date.now(), entry(id).updatedAt + 1) };
        if (isEmpty(next)) memory.delete(id);
        else memory.set(id, next);
        persist();
        if (isPaidPass()) {
            pending.add(id);
            schedulePush();
        }
        notifyChange(id);
        return next;
    }

    function toggleState(id, key) {
        const next = entry(id).state === key ? "" : key;
        return write(id, { state: next });
    }

    function toggleStar(id) {
        return write(id, { star: !entry(id).star });
    }

    function schedulePush() {
        clearTimeout(timer);
        timer = setTimeout(push, PUSH_DELAY);
    }

    async function push() {
        selectScope();
        if (!pending.size || syncing || !isPaidPass()) return;
        syncing = true;
        const work = [...pending].map(id => [id, memory.get(id) || null]);
        pending.clear();
        try {
            const payload = {};
            for (const [id, value] of work) payload[id] = value ? value : null;
            const ok = await window.qbankPersonalPass.patchMemory(payload);
            if (ok === null || ok === false) throw new Error("通行证云端写入被拒绝");
            setStatus("");
        } catch (error) {
            if (isPaidPass()) {
                for (const [id] of work) pending.add(id);
                setStatus("云端同步失败：" + (error.message || "网络异常"), "warn");
            }
        } finally {
            syncing = false;
            if (pending.size) schedulePush();
        }
    }

    function flush() {
        clearTimeout(timer);
        if (!pending.size) return;
        if (isPaidPass()) {
            push();
            return;
        }
        pending.clear();
    }

    async function pull() {
        selectScope();
        if (!isPaidPass()) {
            setStatus(isFreePass()
                ? "免费版 · 进度保存在本机浏览器，可在顶部“学习进度”导出备份。"
                : "记忆只保存在本机浏览器，可在顶部“学习进度”导出备份。", "warn");
            return;
        }
        let cloud;
        try {
            cloud = (await window.qbankPersonalPass.readMemory()) || {};
        } catch (error) {
            setStatus("云端记忆读取失败：" + (error.message || "网络异常"), "warn");
            return;
        }
        for (const id of new Set([...Object.keys(cloud), ...memory.keys()])) {
            const remote = cloud[id] ? normalizeEntry(cloud[id]) : null;
            const local = memory.get(id);
            if (remote && (!local || remote.updatedAt >= local.updatedAt)) {
                if (isEmpty(remote)) memory.delete(id);
                else memory.set(id, remote);
                pending.delete(id);
            } else if (local && !isEmpty(local)) {
                pending.add(id);
            }
        }
        persist();
        if (pending.size) schedulePush();
        setStatus("");
        emit();
        notifyChange("");
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
        const cur = entry(id);
        if (value === "mastered") return cur.state === "mastered";
        if (value === "wrong") return cur.state === "wrong";
        if (value === "star") return cur.star === true;
        if (value === "note") return Boolean(cur.note.trim());
        if (value === "unmarked") return isEmpty(cur);
        return true;
    }

    function decorate(button, id) {
        const cur = entry(id);
        if (cur.state === "wrong" || cur.star || cur.state === "mastered") {
            const dot = document.createElement("span");
            dot.className = "mem-dot" + (cur.state === "wrong" ? "" : cur.state === "mastered" ? " mastered" : " star");
            dot.title = cur.state === "wrong" ? "错题" : cur.state === "mastered" ? "已掌握" : "已收藏";
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
            const cur = entry(id);
            for (const [key, node] of buttons) node.setAttribute("aria-pressed", String(cur.state === key));
            star.setAttribute("aria-pressed", String(cur.star));
            if (area.value !== cur.note) area.value = cur.note;
            if (isPaidPass()) {
                hint.textContent = "已连接专属通行证，做题记忆会自动同步到云端。";
                delete hint.dataset.kind;
            } else if (isFreePass()) {
                hint.textContent = "免费版 · 进度保存在本机浏览器，可在顶部“学习进度”导出备份。";
                hint.dataset.kind = "warn";
            } else {
                hint.textContent = "记忆只保存在本机浏览器，可在顶部“学习进度”导出备份。";
                hint.dataset.kind = "warn";
            }
        }

        function afterChange() {
            const filter = document.getElementById("memory");
            if (filter && filter.value && typeof window.qbankRefresh === "function") window.qbankRefresh();
        }

        paint();
        marks.append(panel);
        for (const subscriber of [...listeners]) {
            if (!subscriber.panel.isConnected) listeners.delete(subscriber);
        }
        listeners.add({ panel, paint });
    }

    function exportData() {
        selectScope();
        const plain = {};
        for (const [id, v] of memory) {
            if (!isEmpty(v)) plain[id] = v;
        }
        return plain;
    }

    function importData(rawRecords) {
        if (!rawRecords || typeof rawRecords !== "object" || Array.isArray(rawRecords)) {
            throw new Error("无效的进度 JSON 结构");
        }
        selectScope();
        let mergedCount = 0;
        for (const [id, val] of Object.entries(rawRecords)) {
            if (!val || typeof val !== "object") continue;
            const incoming = normalizeEntry(val);
            if (isEmpty(incoming)) continue;
            const existing = memory.get(id);
            if (!existing || incoming.updatedAt >= existing.updatedAt) {
                memory.set(id, incoming);
                if (isPaidPass()) pending.add(id);
                mergedCount++;
            }
        }
        persist();
        if (isPaidPass() && pending.size) schedulePush();
        emit();
        notifyChange("");
        return mergedCount;
    }

    function clearAll() {
        selectScope();
        if (isPaidPass()) {
            for (const id of memory.keys()) pending.add(id);
        }
        memory.clear();
        persist();
        if (isPaidPass() && pending.size) schedulePush();
        emit();
        notifyChange("");
    }

    function stats() {
        selectScope();
        let mastered = 0, wrong = 0, star = 0, note = 0;
        for (const v of memory.values()) {
            if (isEmpty(v)) continue;
            if (v.state === "mastered") mastered++;
            if (v.state === "wrong") wrong++;
            if (v.star) star++;
            if (v.note.trim()) note++;
        }
        return { total: memory.size, mastered, wrong, star, note };
    }

    function boot() {
        selectScope();
        if (isPaidPass()) {
            emit();
            pull();
        } else {
            emit();
            setStatus(isFreePass()
                ? "免费版 · 进度保存在本机浏览器，可在顶部“学习进度”导出备份。"
                : "记忆只保存在本机浏览器，可在顶部“学习进度”导出备份。", "warn");
        }
        for (const event of ["pagehide", "visibilitychange"]) {
            addEventListener(event, () => {
                if (event === "visibilitychange" && !document.hidden) return;
                flush();
            });
        }
    }

    window.qbankStudy = { match, decorate, mount, boot, flush, pull, entry, toggleState, toggleStar, exportData, importData, clearAll, stats };
})();
