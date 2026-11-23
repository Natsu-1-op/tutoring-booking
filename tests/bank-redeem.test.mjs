/**
 * 用假的 Firebase + DOM 跑真实的 question-bank/account.js，
 * 复现线上规则：activation_codes/{code}/release 学生账号不可读，
 * key 仅在 claim.usedBy === 本人 时可读。
 */
import fs from "node:fs";
import vm from "node:vm";

import path from "node:path";
import {fileURLToPath} from "node:url";
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../question-bank/account.js");
const CONFIG = {
    apiKey: "k", authDomain: "a", database: "https://x.firebasedatabase.app",
    release: "internal-v2", indexPath: "index",
};
const UID = "uid-student";
const KEY = "0x7SAoFyhDJqJSskDw6TrOSc7ezWe_3OCB9WWsGEFlY";
const CODE = "QWU9-MDWK-3RPP";
const DAY = 86400000;

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const getPath = (tree, path) => {
    let node = tree;
    for (const part of path.split("/").filter(Boolean)) {
        if (node === null || typeof node !== "object") return null;
        node = node[part];
        if (node === undefined) return null;
    }
    return node === undefined ? null : node;
};
const setPath = (tree, path, value) => {
    const parts = path.split("/").filter(Boolean);
    let node = tree;
    for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
        node = node[part];
    }
    if (value === null) delete node[parts.at(-1)];
    else node[parts.at(-1)] = value;
};

function makeContext(tree, user) {
    const denied = path => {
        const error = new Error(`Permission denied: ${path}`);
        error.code = "PERMISSION_DENIED";
        return error;
    };
    const readable = path => {
        const parts = path.split("/").filter(Boolean);
        if (parts[0] === "users") return parts[1] === user.uid;
        if (parts[0] !== "activation_codes") return false;
        const code = getPath(tree, `activation_codes/${parts[1]}`);
        if (!code) return parts.length >= 2; // 空码读取返回 null，不算拒绝
        const field = parts[2];
        if (field === "durationMs" || field === "days" || field === "revoked") return true;
        if (field === "release") return false;             // 线上就是拒绝的
        if (field === "key") return code.claim?.usedBy === user.uid;
        if (field === "claim") return !code.claim || code.claim.usedBy === user.uid;
        return false;
    };
    const ref = pathRaw => {
        const path = String(pathRaw).replace(/^\/+|\/+$/g, "");
        return {
            async once() {
                if (!readable(path)) throw denied(path);
                return {val: () => clone(getPath(tree, path))};
            },
            async transaction(fn) {
                if (!readable(path)) throw denied(path);
                const next = fn(clone(getPath(tree, path)));
                if (next === undefined) return {committed: false, snapshot: {val: () => clone(getPath(tree, path))}};
                setPath(tree, path, clone(next));
                return {committed: true, snapshot: {val: () => clone(next)}};
            },
            async update(patch) {
                if (path.split("/")[0] !== "users" || path.split("/")[1] !== user.uid) throw denied(path);
                for (const [key, value] of Object.entries(patch)) setPath(tree, `${path}/${key}`, clone(value));
            },
            async set(value) {
                if (path.split("/")[0] !== "users" || path.split("/")[1] !== user.uid) throw denied(path);
                setPath(tree, path, clone(value));
            },
        };
    };
    return ref;
}

function element(id) {
    return {
        id, textContent: "", value: "", hidden: false, dataset: {}, disabled: false,
        addEventListener() {}, append() {}, setAttribute() {}, focus() {}, select() {},
        insertRow: () => ({insertCell: () => ({})}),
    };
}

async function run() {
    const results = [];
    const check = (name, ok, extra = "") => {
        results.push({name, ok});
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    };

    const scenario = async (label, tree, fn) => {
        const els = new Map();
        const document = {
            getElementById: id => {
                if (!els.has(id)) els.set(id, element(id));
                return els.get(id);
            },
            querySelectorAll: () => [],
            addEventListener() {},
        };
        document.getElementById("internal-config").textContent = JSON.stringify(CONFIG);
        const user = {uid: UID, email: "123@gmail.com"};
        const ref = makeContext(tree, user);
        let reloads = 0;
        const sandbox = {
            console, Intl, JSON, Date, URL, URLSearchParams, Promise, Number, String, Math, Array, Object,
            crypto: globalThis.crypto,
            document,
            location: {hash: "", href: "http://x/", reload: () => { reloads += 1; }},
            addEventListener() {},
            firebase: {
                initializeApp: () => ({
                    auth: () => ({onAuthStateChanged: cb => { setTimeout(() => cb(user), 0); return () => {}; }}),
                    database: () => ({ref}),
                }),
            },
            setTimeout, clearTimeout, setInterval, clearInterval,
        };
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox, {filename: "account.js"});
        await new Promise(r => setTimeout(r, 10));
        return {account: sandbox.window.qbankAccount, tree, reloads, label, fn};
    };

    // 1) 全新兑换：release 读不到不应导致失败
    {
        const tree = {
            activation_codes: {[CODE]: {days: 365, durationMs: 365 * DAY, note: "", createdAt: 1, createdBy: "a", release: "internal-v2", key: KEY}},
            users: {[UID]: {email: "123@gmail.com", createdAt: 1}},
        };
        const ctx = await scenario("fresh", tree);
        const done = await ctx.account.redeem(CODE);
        const access = getPath(tree, `users/${UID}/bankAccess`);
        check("全新兑换成功（release 无读权限也能完成）", done && !done.resumed);
        check("写入密钥与版本", access?.key === KEY && access?.release === "internal-v2" && access?.active === true);
        check("写入了 claim", getPath(tree, `activation_codes/${CODE}/claim`)?.usedBy === UID);
        check("claimedCodes 已记录", getPath(tree, `users/${UID}/claimedCodes/${CODE}`) === access?.expiresAt);
        check("授权可读回", (await ctx.account.getGrant())?.key === KEY);
    }

    // 2) 中断后重试：claim 已存在且属于本人，个人档案只有 active/expiresAt
    {
        const claimExpiresAt = Date.now() + 200 * DAY;
        const tree = {
            activation_codes: {[CODE]: {days: 365, durationMs: 365 * DAY, note: "", createdAt: 1, createdBy: "a", release: "internal-v2", key: KEY,
                claim: {usedBy: UID, usedAt: Date.now() - 1000, expiresAt: claimExpiresAt, email: "123@gmail.com"}}},
            users: {[UID]: {email: "123@gmail.com", createdAt: 1, bankAccess: {active: true, expiresAt: claimExpiresAt, updatedAt: 1}}},
        };
        const ctx = await scenario("resume", tree);
        const done = await ctx.account.redeem(CODE);
        const access = getPath(tree, `users/${UID}/bankAccess`);
        check("重复输入同一个码走补齐流程", done?.resumed === true);
        check("补齐后密钥就位", access?.key === KEY && access?.release === "internal-v2" && access?.days === 365);
        check("不重复叠加天数", access?.expiresAt === claimExpiresAt, `expiresAt=${access?.expiresAt}, claim=${claimExpiresAt}`);
        check("补齐后可直接进入题库", (await ctx.account.getGrant())?.key === KEY);
    }

    // 3) 别人已兑换
    {
        const tree = {
            activation_codes: {[CODE]: {days: 365, durationMs: 365 * DAY, note: "", createdAt: 1, createdBy: "a", release: "internal-v2", key: KEY,
                claim: {usedBy: "someone-else", usedAt: 1, expiresAt: Date.now() + DAY, email: "other@gmail.com"}}},
            users: {[UID]: {email: "123@gmail.com", createdAt: 1}},
        };
        const ctx = await scenario("taken", tree);
        let message = "";
        try { await ctx.account.redeem(CODE); } catch (e) { message = e.message; }
        check("他人已用的码给出明确提示", message.includes("已经被使用"), message);
        check("不写个人档案", getPath(tree, `users/${UID}/bankAccess`) === null);
    }

    // 4) 本人用过的码已过期，再次输入不应续命
    {
        const claimExpiresAt = Date.now() - 10 * DAY;
        const tree = {
            activation_codes: {[CODE]: {days: 365, durationMs: 365 * DAY, note: "", createdAt: 1, createdBy: "a", release: "internal-v2", key: KEY,
                claim: {usedBy: UID, usedAt: 1, expiresAt: claimExpiresAt, email: "123@gmail.com"}}},
            users: {[UID]: {email: "123@gmail.com", createdAt: 1, bankAccess: {active: true, expiresAt: claimExpiresAt, updatedAt: 1}}},
        };
        const ctx = await scenario("expired-resume", tree);
        let message = "";
        try { await ctx.account.redeem(CODE); } catch (e) { message = e.message; }
        check("已用完的码提示换新码", /用完|新的激活码/.test(message), message);
        check("不会把到期时间改到未来", getPath(tree, `users/${UID}/bankAccess/expiresAt`) === claimExpiresAt);
    }

    // 5) 码不存在
    {
        const tree = {activation_codes: {}, users: {[UID]: {email: "123@gmail.com", createdAt: 1}}};
        const ctx = await scenario("missing", tree);
        let message = "";
        try { await ctx.account.redeem("AAAA-BBBB-CCCC"); } catch (e) { message = e.message; }
        check("不存在的码提示核对", message.includes("不存在"), message);
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) process.exit(1);
}

run().catch(error => { console.error(error); process.exit(1); });
