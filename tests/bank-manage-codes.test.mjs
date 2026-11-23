/**
 * 用假的 DOM + fetch 跑真实的 question-bank/manage/manage.js，
 * 验证激活码表格的「删除」按钮确实发出 DELETE 并从表格里移除该行。
 */
import fs from "node:fs";
import vm from "node:vm";

import path from "node:path";
import {fileURLToPath} from "node:url";
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../question-bank/manage/manage.js");
const CODE = "QWU9-MDWK-3RPP";
const DB = "https://x.firebasedatabase.app";

const results = [];
const check = (name, ok, extra = "") => {
    results.push({name, ok});
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function makeButton() {
    const handlers = {};
    return {
        tagName: "BUTTON", type: "", textContent: "", className: "", disabled: false,
        addEventListener: (name, fn) => { handlers[name] = fn; },
        click: () => handlers.click?.(),
        handlers,
    };
}
function makeTable() {
    const rows = [];
    return {
        rows,
        replaceChildren: () => { rows.length = 0; },
        insertRow() {
            const cells = [];
            const row = {cells, insertCell: () => { const cell = {textContent: "", className: "", colSpan: 1, children: [], append: c => cell.children.push(c)}; cells.push(cell); return cell; }};
            rows.push(row);
            return row;
        },
    };
}

const tables = {"code-rows": makeTable(), "user-rows": makeTable(), "rows": makeTable()};
const listeners = {};
const els = new Map();
const el = id => {
    if (!els.has(id)) {
        els.set(id, {
            id, textContent: "", value: "", hidden: false, dataset: {}, disabled: false, valueAsNumber: 0,
            addEventListener: (name, fn) => { listeners[id + ":" + name] = fn; },
            focus() {}, select() {}, append() {},
        });
    }
    return els.get(id);
};
const stubEl = id => (tables[id] ? tables[id] : el(id));

const calls = [];
const fetchStub = async (url, options = {}) => {
    const text = String(url);
    const method = options.method || "GET";
    calls.push({method, url: text, body: options.body});
    if (text.includes("identitytoolkit")) {
        return {ok: true, status: 200, json: async () => ({idToken: "id", refreshToken: "r", expiresIn: "3600"})};
    }
    if (text.includes("securetoken")) {
        return {ok: true, status: 200, json: async () => ({id_token: "id", refresh_token: "r", expires_in: "3600"})};
    }
    if (method === "DELETE") return {ok: true, status: 200, json: async () => null};
    if (text.includes("/activation_codes.json")) {
        return {ok: true, status: 200, json: async () => ({[CODE]: {
            days: 365, durationMs: 365 * 86400000, note: "", createdAt: 1, createdBy: "a", release: "internal-v2", key: "k",
            claim: {usedBy: "uid-1", usedAt: 1, expiresAt: Date.now() + 86400000, email: "123@gmail.com"},
        }})};
    }
    if (text.includes("/users.json")) return {ok: true, status: 200, json: async () => ({})};
    if (text.includes("/questionBankAccess/settings.json")) {
        return {ok: true, status: 200, json: async () => ({key: "k", release: "internal-v2"})};
    }
    if (text.includes("/questionBankAccess/links.json")) return {ok: true, status: 200, json: async () => ({})};
    return {ok: true, status: 200, json: async () => null};
};

const document = {
    getElementById: stubEl,
    createElement: tag => (tag === "button" ? makeButton() : {tagName: tag, append() {}, setAttribute() {}}),
    querySelectorAll: () => [],
    addEventListener() {},
};
const sandbox = {
    console, JSON, Date, Number, String, Math, Object, Array, Promise, URL, URLSearchParams, Intl,
    crypto: globalThis.crypto,
    document,
    location: {href: "http://x/question-bank/manage/", reload() {}},
    navigator: {clipboard: {writeText: async () => {}}},
    confirm: () => true,
    fetch: fetchStub,
    setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
el("admin-config").textContent = JSON.stringify({apiKey: "k", database: DB, ownerEmail: "1843499931@qq.com"});
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox, {filename: "manage.js"});

// 模拟登录：填口令并提交
el("password").value = "pw";
await listeners["sign-in:submit"]({preventDefault() {}, submitter: makeButton()});
await new Promise(r => setTimeout(r, 50));

const table = tables["code-rows"];
check("登录后渲染出激活码行", table.rows.length === 1, `rows=${table.rows.length}`);
const cells = table.rows[0]?.cells || [];
check("表格有 7 列（含操作列）", cells.length === 7, `cells=${cells.length}`);
const ops = cells[6]?.children || [];
const labels = ops.map(b => b.textContent);
check("已使用的码只给「删除」按钮", labels.join(",") === "删除", labels.join(","));

await ops[0].click();
await new Promise(r => setTimeout(r, 20));
const del = calls.find(c => c.method === "DELETE");
check("点击删除发出 DELETE 请求", Boolean(del) && del.url.includes(`/activation_codes/${CODE}.json`), del?.url || "无请求");
check("删除后该行从表格移除", tables["code-rows"].rows.length === 1 && tables["code-rows"].rows[0].cells.length === 1,
    `rows=${tables["code-rows"].rows.length}`);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
