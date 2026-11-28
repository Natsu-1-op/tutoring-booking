"use strict";
const $ = id => document.getElementById(id);
const config = JSON.parse($("admin-config").textContent);
const alias = config.ownerEmail;
const date = new Intl.DateTimeFormat("zh-CN",{
    timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",
});
let session, refreshTask, settings;
let currentLink = "";
let links = {};
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
$("sign-in-as").textContent = "登录账号：" + alias;
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
        buttons.append(action("删除",async()=>{
            const tip = active
                ? `删除后这条内部链接立即失效且无法恢复，持链接的人将无法进入题库。\n确认删除「${link.label}」？`
                : `删除「${link.label}」这条记录？`;
            if (!confirm(tip)) return;
            try {
                await database("links/" + key, "DELETE");
                delete links[key];
                if (currentLink===makeLink(key)) { $("generated").hidden=true; currentLink=""; }
                showRows();
                notice("已删除该内部链接。");
            } catch (e) {
                notice("删除失败：" + e.message + "（若提示权限不足，请先把最新的 database.rules.json 更新到线上）");
            }
        },"danger"));
    }
}

async function loadLinks() {
    [settings, links] = await Promise.all([database("settings"), database("links")]);
    links ||= {};
    if (!settings?.key || !settings.release) throw new Error("当前题库版本尚未配置。");
    showRows();
}
const personalPassAPI = (path, method, value) => request(config.database + "/bankPersonalPasses", path, method, value);
const appsAPI = (path, method, value) => request(config.database + "/bankApplications", path, method, value);
const AI_REV_STORE = "hust839-admin-ai-review";
let applications = {};
const aiVerdicts = new Map();

function readAiRevConfig() {
    try {
        const parsed = JSON.parse(localStorage.getItem(AI_REV_STORE) || "{}");
        return {
            base: String(parsed.base || "https://api.openai.com/v1").trim(),
            key: String(parsed.key || "").trim(),
            model: String(parsed.model || "gpt-4o-mini").trim() || "gpt-4o-mini",
        };
    } catch {
        return { base: "https://api.openai.com/v1", key: "", model: "gpt-4o-mini" };
    }
}
function loadAiRevForm() {
    const cfg = readAiRevConfig();
    if ($("ai-rev-base")) $("ai-rev-base").value = cfg.base;
    if ($("ai-rev-key")) $("ai-rev-key").value = cfg.key;
    if ($("ai-rev-model")) $("ai-rev-model").value = cfg.model;
}
loadAiRevForm();
$("ai-rev-save")?.addEventListener("click", () => {
    const payload = {
        base: ($("ai-rev-base")?.value || "").trim() || "https://api.openai.com/v1",
        key: ($("ai-rev-key")?.value || "").trim(),
        model: ($("ai-rev-model")?.value || "").trim() || "gpt-4o-mini",
    };
    try { localStorage.setItem(AI_REV_STORE, JSON.stringify(payload)); } catch {}
    notice("AI 预审配置已保存在本机浏览器。");
});
$("photo-dialog-close")?.addEventListener("click", () => $("photo-dialog")?.close());
$("photo-dialog")?.addEventListener("click", e => { if (e.target === $("photo-dialog")) $("photo-dialog").close(); });

function randomPassCode() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
        .replaceAll("+", "-").replaceAll("/", "_");
}

function personalPassLink(pass) {
    const url = new URL("../", location.href);
    url.hash = new URLSearchParams({pass});
    return url.href;
}

async function loadApplications() {
    if (!$("app-pending-rows")) return;
    applications = (await appsAPI("")) || {};
    renderApplications();
}

function renderApplications() {
    const pendingHost = $("app-pending-rows");
    const doneHost = $("app-done-rows");
    if (!pendingHost || !doneHost) return;
    pendingHost.replaceChildren();
    doneHost.replaceChildren();
    const list = Object.entries(applications).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    let pendingCount = 0;
    for (const [appId, rec] of list) {
        if (!rec || typeof rec !== "object") continue;
        if (rec.status === "pending") {
            pendingCount++;
            const row = pendingHost.insertRow();
            row.insertCell().textContent = rec.createdAt ? date.format(rec.createdAt) : "—";
            const infoCell = row.insertCell();
            infoCell.textContent = `${rec.name} · ${rec.school}（${rec.contact}）` + (rec.note ? ` · ${rec.note}` : "");
            const imgCell = row.insertCell();
            if (rec.photo) {
                const img = document.createElement("img");
                img.className = "thumb";
                img.src = rec.photo;
                img.alt = "学生证";
                img.title = "点击查看大图";
                img.addEventListener("click", () => {
                    $("photo-dialog-title").textContent = `${rec.name} · ${rec.school}`;
                    $("photo-dialog-img").src = rec.photo;
                    $("photo-dialog").showModal();
                });
                imgCell.append(img);
            } else {
                imgCell.textContent = "无照片";
            }
            const aiCell = row.insertCell();
            const v = aiVerdicts.get(appId);
            if (v) {
                const b = document.createElement("span");
                b.className = "badge " + (v.verdict === "pass" ? "pass" : v.verdict === "reject" ? "reject" : "review");
                b.textContent = v.verdict === "pass" ? "建议通过" : v.verdict === "reject" ? "建议驳回" : "人工复核";
                aiCell.append(b, document.createElement("br"), document.createTextNode(v.reason || ""));
            } else {
                aiCell.textContent = "未预审";
            }
            const ops = row.insertCell();
            const approveBtn = action("通过发码", async () => {
                const days = $("app-free-days")?.valueAsNumber || 180;
                if (!Number.isInteger(days) || days < 1 || days > 365) { notice("有效天数需为 1-365。"); return; }
                approveBtn.disabled = true;
                try {
                    const code = randomPassCode();
                    const validUntil = Date.now() + days * 86400000;
                    const label = ("免费-" + rec.name + "-" + rec.school).slice(0, 56);
                    await personalPassAPI(code, "PUT", {
                        label,
                        validUntil,
                        revoked: false,
                        delivery: {"~": {release: settings.release, key: settings.key, tier: "free"}}
                    });
                    await appsAPI(appId, "PATCH", {
                        status: "approved",
                        passCode: code,
                        passValidUntil: validUntil,
                        reviewedAt: Date.now(),
                        photo: null
                    });
                    await Promise.all([loadApplications(), loadPersonalPasses()]);
                    notice(`已通过 ${rec.name} 的申请，生成免费通行证并清除证件照片。`);
                } catch (err) {
                    notice(err.message);
                } finally {
                    approveBtn.disabled = false;
                }
            });
            const rejectBtn = action("驳回", async () => {
                const reason = prompt("输入驳回原因（留空使用默认原因）：", "照片不清晰或无法核验在校学生身份");
                if (reason === null) return;
                rejectBtn.disabled = true;
                try {
                    await appsAPI(appId, "PATCH", {
                        status: "rejected",
                        rejectReason: (reason.trim() || "照片不清晰或无法核验在校学生身份").slice(0, 120),
                        reviewedAt: Date.now(),
                        photo: null
                    });
                    await loadApplications();
                    notice(`已驳回 ${rec.name} 的申请并清除证件照片。`);
                } catch (err) {
                    notice(err.message);
                } finally {
                    rejectBtn.disabled = false;
                }
            }, "danger");
            ops.append(approveBtn, rejectBtn);
        } else {
            const row = doneHost.insertRow();
            row.insertCell().textContent = rec.reviewedAt ? date.format(rec.reviewedAt) : "—";
            row.insertCell().textContent = `${rec.name} · ${rec.school}（${rec.contact}）`;
            const stCell = row.insertCell();
            const badge = document.createElement("span");
            badge.className = "badge " + (rec.status === "approved" ? "pass" : "reject");
            badge.textContent = rec.status === "approved" ? "已通过" : "已驳回";
            stCell.append(badge);
            row.insertCell().textContent = rec.status === "approved"
                ? (rec.passCode ? rec.passCode.slice(0, 8) + "…" : "已发码")
                : (rec.rejectReason || "—");
            const ops = row.insertCell();
            if (rec.passCode) ops.append(action("复制链接", () => copy(personalPassLink(rec.passCode))));
            ops.append(action("删除记录", async () => {
                if (!confirm("删除此申请记录？（已发放的通行证本身不受影响）")) return;
                try {
                    await appsAPI(appId, "DELETE");
                    await loadApplications();
                    notice("申请记录已删除。");
                } catch (err) { notice(err.message); }
            }, "danger"));
        }
    }
    if (!pendingCount) {
        const r = pendingHost.insertRow();
        const c = r.insertCell();
        c.colSpan = 5;
        c.textContent = "暂无待审核的学生证申请。";
    }
    if ($("app-pending-badge")) $("app-pending-badge").textContent = pendingCount + " 待审";
}

$("app-refresh")?.addEventListener("click", () => loadApplications().then(() => notice("已刷新申请列表。")).catch(e => notice(e.message)));

$("ai-review-run")?.addEventListener("click", async () => {
    const cfg = readAiRevConfig();
    if (!cfg.key) {
        $("ai-review-box").open = true;
        notice("请先在「AI 辅助预审配置」中填写 API Key 并保存。");
        return;
    }
    const pendingEntries = Object.entries(applications).filter(([, r]) => r && r.status === "pending" && r.photo);
    if (!pendingEntries.length) {
        notice("当前没有带照片的待审申请。");
        return;
    }
    const btn = $("ai-review-run");
    btn.disabled = true;
    let done = 0;
    try {
        for (const [appId, rec] of pendingEntries) {
            notice(`AI 正在预审第 ${++done} / ${pendingEntries.length} 条（${rec.name}）…`);
            const endpoint = cfg.base.replace(/\/+$/, "") + "/chat/completions";
            const promptText = `你是一名辅助人工管理员核验“在校学生证免费题库申请”的助手。\n申请人填报姓名：${rec.name}\n填报学校/学院：${rec.school}\n请查看图片是否为真实有效的高校学生证或校园卡，并检查照片中的姓名、学校与填报信息是否一致。\n仅返回严格 JSON（不要 markdown 代码块）：{"verdict":"pass"|"review"|"reject","reason":"15字以内简明理由"}。`;
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + cfg.key
                },
                body: JSON.stringify({
                    model: cfg.model,
                    temperature: 0.1,
                    messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: promptText },
                            { type: "image_url", image_url: { url: rec.photo } }
                        ]
                    }]
                })
            });
            if (!res.ok) throw new Error("AI 接口返回 " + res.status);
            const data = await res.json();
            const rawText = String(data?.choices?.[0]?.message?.content || "");
            const match = rawText.match(/\{[\s\S]*\}/);
            let parsed = { verdict: "review", reason: "请人工复核" };
            if (match) {
                try {
                    const obj = JSON.parse(match[0]);
                    parsed = {
                        verdict: ["pass", "review", "reject"].includes(obj.verdict) ? obj.verdict : "review",
                        reason: String(obj.reason || "").slice(0, 40)
                    };
                } catch {}
            }
            aiVerdicts.set(appId, parsed);
            renderApplications();
        }
        notice(`已完成 ${done} 条 AI 预审，请人工确认后放行或驳回。`);
    } catch (error) {
        notice("AI 预审中断：" + (error.message || "请求失败"));
    } finally {
        btn.disabled = false;
    }
});

async function loadPersonalPasses() {
    const host = $("personal-pass-rows");
    if (!personalPassForm) return;
    const passes = await personalPassAPI("") || {};
    host.replaceChildren();
    for (const [code, entry] of Object.entries(passes)) {
        const row = host.insertRow();
        row.insertCell().textContent = entry.label;
        const tier = entry.delivery?.["~"]?.tier === "free" ? "free" : "paid";
        const tierCell = row.insertCell();
        const tierBadge = document.createElement("span");
        tierBadge.className = "badge " + tier;
        tierBadge.textContent = tier === "free" ? "免费·本地" : "付费·云同步";
        tierCell.append(tierBadge);
        const devices = Object.values(entry.devices || {}).filter(device => device.released === false);
        row.insertCell().textContent = devices.length + " / 2";
        row.insertCell().textContent = entry.revoked ? "已停用" : date.format(entry.validUntil);
        const controls = row.insertCell();
        if (entry.revoked) continue;
        controls.append(action("复制链接", () => copy(personalPassLink(code))));
        controls.append(action("重置设备", async () => {
            if (!confirm("解除此通行证的全部设备绑定，并结束当前会话？")) return;
            try {
                await personalPassAPI(code, "PATCH", {devices: null, lease: null});
                await loadPersonalPasses();
                notice("设备绑定已重置。");
            } catch (error) { notice(error.message); }
        }));
        controls.append(action("停用", async () => {
            if (!confirm("停用此通行证？")) return;
            try {
                await personalPassAPI(code, "PATCH", {revoked: true, lease: null});
                await loadPersonalPasses();
                notice("个人通行证已停用。");
            } catch (error) { notice(error.message); }
        }, "danger"));
    }
}

const personalPassForm = $("gen-personal-passes");
personalPassForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    const count = $("personal-pass-count").valueAsNumber;
    const days = $("personal-pass-days").valueAsNumber;
    const tier = $("personal-pass-tier")?.value === "free" ? "free" : "paid";
    if (!Number.isInteger(count) || count < 1 || count > 50
        || !Number.isInteger(days) || days < 1 || days > 365) return;
    const label = $("personal-pass-label").value.trim() || (tier === "free" ? "学生免费试用" : "题库试用");
    const output = $("personal-pass-output");
    const generated = [];
    button.disabled = true;
    try {
        for (let index = 0; index < count; index++) {
            const code = randomPassCode();
            await personalPassAPI(code, "PUT", {
                label: count > 1 ? label + " " + (index + 1) : label,
                validUntil: Date.now() + days * 86400000,
                revoked: false,
                delivery: {"~": {release: settings.release, key: settings.key, tier}}
            });
            generated.push(personalPassLink(code));
        }
        notice("已生成 " + generated.length + " 份" + (tier === "free" ? "免费" : "付费") + "个人通行证。");
    } catch (error) { notice(error.message + "（已生成 " + generated.length + " 份）"); }
    finally {
        if (generated.length) {
            output.value = generated.join("\n");
            output.hidden = false;
        }
        await loadPersonalPasses().catch(() => {});
        button.disabled = false;
    }
});

async function load() {
    await loadLinks();
    await loadPersonalPasses().catch(() => {
        if (personalPassForm) $("personal-pass-rows").textContent = "个人通行证规则尚未启用。";
    });
    await loadApplications().catch(() => {
        if ($("app-pending-rows")) $("app-pending-rows").textContent = "学生证审核规则尚未启用（请先更新 database.rules.json）。";
    });
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
        setInterval(()=>{ showRows(); },60000);
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

$("exit").addEventListener("click",()=>location.reload());
