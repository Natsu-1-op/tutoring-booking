"use strict";
const $ = id => document.getElementById(id);
const config = JSON.parse($("admin-config").textContent);
const alias = config.ownerEmail;
const root = config.database + "/questionBankAccess/";
const date = new Intl.DateTimeFormat("zh-CN",{
    timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",
});
let session, refreshTask, settings;
let currentLink = "";
let links = {};
const signURL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(config.apiKey);
function notice(text) { $("status").textContent = text; }
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
async function database(path,method="GET",value) {
    const url = new URL(root + path + ".json");
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
function makeLink(key) {
    const url = new URL("../",location.href);
    url.hash = new URLSearchParams({key});
    return url.href;
}
async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        notice("已复制内部链接。");
    } catch {
        $("generated").hidden=false;
        $("share").value=text;
        currentLink=text;
        $("share").focus();
        $("share").select();
        notice("链接已选中，可手动复制。");
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
            buttons.append(action("复制",()=>copy(makeLink(key))));
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
async function load() {
    [settings,links] = await Promise.all([database("settings"),database("links")]);
    links ||= {};
    if (!settings?.key || !settings.release) throw new Error("当前题库版本尚未配置。");
    showRows();
}
$("sign-in").addEventListener("submit",async event=>{
    event.preventDefault();
    const go=event.submitter;
    go.disabled=true;
    try {
        const password=$("password").value.trim();
        $("password").value="";
        const r=await fetch(signURL,{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({email:alias,password,returnSecureToken:true}),
            cache:"no-store",referrerPolicy:"no-referrer",
        });
        if (!r.ok) throw new Error("管理员个人口令有误，或验证服务暂时不可用。");
        const d=await r.json();
        session={id:d.idToken,refresh:d.refreshToken,until:Date.now()+1000*Number(d.expiresIn)};
        await load();
        $("login").hidden=true;
        $("manage").hidden=false;
        $("exit").hidden=false;
        notice("");
        setInterval(showRows,60000);
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
$("copy-current").addEventListener("click",()=>copy(currentLink));
$("exit").addEventListener("click",()=>location.reload());
