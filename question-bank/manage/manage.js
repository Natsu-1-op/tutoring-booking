"use strict";
const $ = id => document.getElementById(id);
const config = JSON.parse($("admin-config").textContent);
const alias = config.ownerEmail;
const date = new Intl.DateTimeFormat("zh-CN",{
    timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",
});
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let session, refreshTask, settings;
let currentLink = "";
let links = {};
let codes = {};
let users = {};
const signURL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(config.apiKey);
function notice(text) { $("status").textContent = text; }

// 把 Firebase 的错误码翻译成能照着修的中文，避免一律“口令有误”让人无从下手
const LOGIN_ERRORS = {
    INVALID_LOGIN_CREDENTIALS: "邮箱或口令不正确。这里的口令是 Firebase 账号的密码，不是 QQ / 邮箱本身的登录密码。",
    INVALID_PASSWORD: "口令不正确。",
    EMAIL_NOT_FOUND: "Firebase Authentication 里没有这个邮箱账号。",
    USER_DISABLED: "该账号已被停用。",
    OPERATION_NOT_ALLOWED: "项目未启用「电子邮件/密码」登录方式。",
    PASSWORD_LOGIN_DISABLED: "项目已关闭邮箱密码登录方式。",
    TOO_MANY_ATTEMPTS_TRY_LATER: "尝试过于频繁，请稍后再试。",
    API_KEY_INVALID: "admin-config 里的 API Key 无效。",
    INVALID_EMAIL: "邮箱格式不正确。",
};
function loginError(code) {
    return LOGIN_ERRORS[code] || ("登录失败（" + (code || "响应异常") + "）。");
}
// 把正在使用的登录邮箱直接显示出来，避免误以为是别的账号
$("sign-in-as").textContent = "登录账号：" + alias + "（口令即该 Firebase 账号的密码）";
async function token() {
    if (session.until - Date.now() > 60000) return session.id;
    if (!refreshTask) refreshTask = (async()=>{
        const reply = await fetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(config.apiKey),{
            method:"POST",body:new URLSearchParams({grant_type:"refresh_token",refresh_token:session.refresh}),
            cache:"no-store",referrerPolicy:"no-referrer",
        });
        if (!reply.ok) throw new Error("登录已失效，请重新登录。");
        const d = await reply.json();
        session = {id:d.id_token,refresh:d.refresh_token,until:Date.now()+1000*Number(d.expires_in)};
        return session.id;
    })().finally(()=>{refreshTask=null;});
    return refreshTask;
}
async function request(base, path, method="GET", value) {
    // base 可带或不带结尾斜杠，path 可带或不带开头斜杠；空 path 表示读取整个集合
    const clean = String(path || "").replace(/^\/+/, "");
    const url = new URL(base.replace(/\/+$/, "") + (clean ? "/" + clean : "") + ".json");
    url.searchParams.set("auth",await token());
    const reply = await fetch(url,{
        method,body:value === undefined ? undefined : JSON.stringify(value),
        headers:value === undefined ? undefined : {"Content-Type":"application/json"},
        cache:"no-store",referrerPolicy:"no-referrer",
    });
    if (reply.status===401 || reply.status===403) throw new Error("题库管理权限验证失败，或保存内容不符合要求。");
    if (!reply.ok) throw new Error("题库管理暂时无法连接，请稍后重试。");
    return reply.json();
}
const database = (path, method, value) => request(config.database + "/questionBankAccess/", path, method, value);
const codesAPI = (path, method, value) => request(config.database + "/activation_codes/", path, method, value);
const usersAPI = (path, method, value) => request(config.database + "/users/", path, method, value);

function makeLink(key) {
    const url = new URL("../",location.href);
    url.hash = new URLSearchParams({key});
    return url.href;
}
async function copy(text, message) {
    try {
        await navigator.clipboard.writeText(text);
        notice(message || "已复制。");
        return true;
    } catch {
        $("generated").hidden = false;
        $("share").value = text;
        $("share").focus();
        $("share").select();
        notice("已选中内容，可手动复制。");
        return false;
    }
}
function action(label,handler,css) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (css) b.className = css;
    b.addEventListener("click",handler);
    return b;
}
function showRows() {
    const host = $("rows");
    host.replaceChildren();
    const items = Object.entries(links).sort((a,b)=>b[1].createdAt-a[1].createdAt);
    if (!items.length) {
        const message = host.insertRow().insertCell();
        message.colSpan=4;
        message.textContent="还没有内部链接。";
    }
    for(const [key,link] of items) {
        const row=host.insertRow();
        const {expiresAt,revoked,release}=link.delivery;
        const active=!revoked && expiresAt>Date.now() && release===settings.release;
        row.insertCell().textContent=link.label;
        row.insertCell().textContent=date.format(expiresAt);
        const state=row.insertCell();
        state.textContent=revoked?"已停用":active?"可用":"已失效";
        state.className=active?"live":"off";
        const buttons=row.insertCell();
        if (active) {
            buttons.append(action("复制",()=>copy(makeLink(key),"已复制内部链接。")));
            const stop=action("停用",async()=>{
                if (!confirm("停用后，持此链接的人将无法重新进入题库。确认停用？")) return;
                stop.disabled=true;
                try {
                    await database("links/" + key + "/delivery","PATCH",{revoked:true});
                    links[key].delivery.revoked=true;
                    if (currentLink===makeLink(key)) { $("generated").hidden=true; currentLink=""; }
                    showRows();
                    notice("该链接已停用。");
                } catch (e) { notice(e.message); }
                finally { stop.disabled=false; }
            },"danger");
            buttons.append(stop);
        }
    }
}

// ---------- 激活码 ----------

function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let code = "";
    for (let i = 0; i < 12; i += 1) {
        if (i === 4 || i === 8) code += "-";
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return code;
}
function showCodes() {
    const host = $("code-rows");
    host.replaceChildren();
    const items = Object.entries(codes).sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0));
    if (!items.length) {
        const cell = host.insertRow().insertCell();
        cell.colSpan = 6;
        cell.textContent = "还没有生成激活码。";
        return;
    }
    for (const [code, item] of items) {
        const row = host.insertRow();
        row.insertCell().textContent = code;
        row.insertCell().textContent = item.note || "";
        row.insertCell().textContent = item.days || "";
        const state = row.insertCell();
        const claim = item.claim;
        if (item.revoked) { state.textContent = "已停用"; state.className = "off"; }
        else if (claim) {
            const live = Number(claim.expiresAt) > Date.now();
            state.textContent = live ? "已使用（有效）" : "已使用（到期）";
            state.className = live ? "live" : "off";
        } else { state.textContent = "未使用"; state.className = "live"; }
        row.insertCell().textContent = claim?.email || claim?.usedBy || "";
        row.insertCell().textContent = claim ? date.format(claim.expiresAt) : "";
        if (!claim && !item.revoked) {
            state.append(" ");
            state.append(action("复制", () => copy(code, "已复制该激活码。")));
        }
    }
}
function unusedCodes() {
    return Object.entries(codes)
        .filter(([, item]) => !item.claim && !item.revoked)
        .map(([code]) => code);
}

// ---------- 题库用户 ----------

function userState(item) {
    if (item.disabled === true) return {text: "已停用", css: "off"};
    const access = item.bankAccess || {};
    const expiresAt = Number(access.expiresAt) || 0;
    if (access.active !== true || !expiresAt) return {text: "未激活", css: "off"};
    if (expiresAt <= Date.now()) return {text: "已过期", css: "off"};
    return {text: "正常", css: "live"};
}
function showUsers() {
    const host = $("user-rows");
    host.replaceChildren();
    const items = Object.entries(users)
        .map(([uid, item]) => ({uid, ...item}))
        .sort((a,b)=>(Number(b.bankAccess?.expiresAt)||0)-(Number(a.bankAccess?.expiresAt)||0));
    if (!items.length) {
        const cell = host.insertRow().insertCell();
        cell.colSpan = 4;
        cell.textContent = "还没有题库账号。";
        return;
    }
    for (const item of items) {
        const row = host.insertRow();
        row.insertCell().textContent = item.email || item.uid;
        const expiresAt = Number(item.bankAccess?.expiresAt) || 0;
        row.insertCell().textContent = expiresAt ? date.format(expiresAt) : "—";
        const state = row.insertCell();
        const view = userState(item);
        state.textContent = view.text;
        state.className = view.css;
        const buttons = row.insertCell();
        const renew = action("续期", async () => {
            const days = Number($("renew-days").valueAsNumber);
            if (!Number.isInteger(days) || days < 1 || days > 1095) { notice("续期天数需为 1–1095 的整数。"); return; }
            renew.disabled = true;
            try {
                const base = Math.max(Date.now(), expiresAt);
                await usersAPI(`/${item.uid}/bankAccess`, "PATCH", {
                    active: true,
                    expiresAt: base + days * 86400000,
                    updatedAt: Date.now(),
                });
                await loadUsers();
                notice(`已为 ${item.email || item.uid} 续期 ${days} 天。`);
            } catch (e) { notice(e.message); }
            finally { renew.disabled = false; }
        });
        buttons.append(renew);
        if (item.disabled === true) {
            buttons.append(action("启用", async () => {
                try {
                    await usersAPI(`/${item.uid}`, "PATCH", {disabled: false});
                    await loadUsers();
                    notice("已启用该账号。");
                } catch (e) { notice(e.message); }
            }));
        } else {
            buttons.append(action("停用", async () => {
                if (!confirm(`停用后 ${item.email || item.uid} 将立即无法进入题库。确认停用？`)) return;
                try {
                    await usersAPI(`/${item.uid}`, "PATCH", {disabled: true});
                    await loadUsers();
                    notice("已停用该账号。");
                } catch (e) { notice(e.message); }
            }, "danger"));
        }
    }
}

async function loadLinks() {
    [settings, links] = await Promise.all([database("settings"), database("links")]);
    links ||= {};
    if (!settings?.key || !settings.release) throw new Error("当前题库版本尚未配置。");
    showRows();
}
async function loadCodes() {
    codes = (await codesAPI("")) || {};
    showCodes();
}
async function loadUsers() {
    users = (await usersAPI("")) || {};
    showUsers();
}
async function load() {
    await loadLinks();
    await Promise.all([loadCodes(), loadUsers()]);
}

$("sign-in").addEventListener("submit",async event=>{
    event.preventDefault();
    const go=event.submitter;
    go.disabled=true;
    try {
        const password=$("password").value.trim();
        $("password").value="";
        let r;
        try {
            r=await fetch(signURL,{
                method:"POST",headers:{"Content-Type":"application/json"},
                body:JSON.stringify({email:alias,password,returnSecureToken:true}),
                cache:"no-store",referrerPolicy:"no-referrer",
            });
        } catch(networkError) {
            throw new Error("无法连接 Firebase 验证服务（identitytoolkit.googleapis.com），请检查网络环境。");
        }
        if (!r.ok) {
            const detail=await r.json().catch(()=>({}));
            const code=String(detail?.error?.message||"").split(" ")[0];
            console.warn("[signInWithPassword]", r.status, code || "(无错误码)");
            throw new Error(loginError(code) + "（账号：" + alias + "）");
        }
        const d=await r.json();
        session={id:d.idToken,refresh:d.refreshToken,until:Date.now()+1000*Number(d.expiresIn)};
        await load();
        $("login").hidden=true;
        $("manage").hidden=false;
        $("exit").hidden=false;
        notice("");
        setInterval(()=>{ showRows(); showCodes(); },60000);
    } catch(e) {
        session=null;
        notice(e.message);
    } finally { go.disabled=false; }
});
$("create").addEventListener("submit",async event=>{
    event.preventDefault();
    const hours=$("hours").valueAsNumber;
    if (!Number.isInteger(hours) || hours<1 || hours>720) return;
    const go=event.submitter;
    go.disabled=true;
    try {
        const key=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll("+","-").replaceAll("/","_");
        const link={
            label:$("label").value.trim() || "内部试用",
            createdAt:{".sv":"timestamp"},
            delivery:{expiresAt:Date.now()+hours*3600000,revoked:false,release:settings.release,key:settings.key},
        };
        links[key]=await database("links/" + key,"PUT",link);
        currentLink=makeLink(key);
        $("share").value=currentLink;
        $("generated").hidden=false;
        $("label").value="";
        showRows();
        notice("内部链接已生成。");
    } catch(e) { notice(e.message); }
    finally { go.disabled=false; }
});
$("copy-current").addEventListener("click",()=>copy(currentLink,"已复制内部链接。"));

// 批量生成激活码
$("gen-codes").addEventListener("submit", async event => {
    event.preventDefault();
    const count = $("gen-count").valueAsNumber;
    const days = $("gen-days").valueAsNumber;
    const note = $("gen-note").value.trim();
    if (!Number.isInteger(count) || count < 1 || count > 50) { notice("数量需为 1–50 的整数。"); return; }
    if (!Number.isInteger(days) || days < 1 || days > 1095) { notice("有效天数需为 1–1095 的整数。"); return; }
    const go = event.submitter;
    go.disabled = true;
    const generated = [];
    try {
        for (let i = 0; i < count; i += 1) {
            let code = randomCode();
            while (codes[code]) code = randomCode();
            const record = {
                days,
                durationMs: days * 86400000,
                note,
                createdAt: {".sv":"timestamp"},
                createdBy: alias,
                release: settings.release,
                key: settings.key,
            };
            await codesAPI("/" + code, "PUT", record);
            generated.push(code);
        }
        $("gen-output").value = generated.join("\n");
        $("gen-result").hidden = false;
        $("gen-note").value = "";
        await loadCodes();
        notice(`已生成 ${generated.length} 个激活码，每个可兑换 ${days} 天。`);
    } catch (e) {
        notice(e.message + (generated.length ? `（已生成 ${generated.length} 个，见下方列表）` : ""));
        await loadCodes().catch(()=>{});
    } finally { go.disabled = false; }
});
$("gen-copy").addEventListener("click", () => copy($("gen-output").value, "已复制本次生成的激活码。"));
$("copy-unused").addEventListener("click", () => {
    const list = unusedCodes();
    if (!list.length) { notice("当前没有未使用的激活码。"); return; }
    copy(list.join("\n"), `已复制 ${list.length} 个未使用激活码。`);
});
$("refresh").addEventListener("click", async () => {
    try { await load(); notice("已刷新。"); }
    catch (e) { notice(e.message); }
});

$("exit").addEventListener("click",()=>location.reload());
