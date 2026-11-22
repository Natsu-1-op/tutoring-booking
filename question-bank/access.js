"use strict";
(() => {
    const access = document.getElementById("access");
    const form = document.getElementById("access-form");
    const message = document.getElementById("access-message");
    const config = JSON.parse(document.getElementById("access-config").textContent);
    const root = config.database + "/questionBankPrivate/bank_v1/";
    let session = null;
    let refreshTask = null;
    let bank;
    const normalize = value => value.normalize("NFKC").trim().replace(/\s+/g,"");
    async function syntheticEmail(name) {
        const hashed = await crypto.subtle.digest("SHA-256",new TextEncoder().encode("hust839:" + normalize(name)));
        const hex = Array.from(new Uint8Array(hashed),b=>b.toString(16).padStart(2,"0")).join("");
        return "q839-" + hex.slice(0,48) + "@hust839.invalid";
    }
    async function login(name,password) {
        const result = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" +
            encodeURIComponent(config.apiKey),{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({email:await syntheticEmail(name),password,returnSecureToken:true}),
            cache:"no-store",referrerPolicy:"no-referrer",
        });
        if (!result.ok) throw new Error("姓名或个人口令有误，或该账号尚未获准访问。");
        const data = await result.json();
        return {token:data.idToken,refresh:data.refreshToken,expires:Date.now()+Number(data.expiresIn)*1000};
    }
    async function token() {
        if (!session) throw new Error("请登录后查看题库。");
        if (session.expires-Date.now()>60000) return session.token;
        if (!refreshTask) refreshTask = (async()=>{
            const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(config.apiKey),{
                method:"POST",body:new URLSearchParams({grant_type:"refresh_token",refresh_token:session.refresh}),
                cache:"no-store",referrerPolicy:"no-referrer",
            });
            if (!r.ok) throw new Error("登录已失效，请退出后重新登录。");
            const d = await r.json();
            session = {token:d.id_token,refresh:d.refresh_token,expires:Date.now()+Number(d.expires_in)*1000};
            return session.token;
        })().finally(()=>{refreshTask=null;});
        return refreshTask;
    }
    async function read(path,signal) {
        const url = new URL(root + path + ".json");
        url.searchParams.set("auth",await token());
        const r = await fetch(url,{cache:"no-store",referrerPolicy:"no-referrer",signal});
        if (r.status===401 || r.status===403) throw new Error("此账号没有题库访问权限，或白名单已更新。");
        if (!r.ok) throw new Error("题库暂时无法读取，请稍后再试。");
        const data = await r.json();
        if (data===null) throw new Error("题库文件暂不可用。");
        return data;
    }
    function fromBase64(value) {
        if (Uint8Array.fromBase64) return Uint8Array.fromBase64(value);
        const str=atob(value);
        const buffer=new Uint8Array(str.length);
        for (let i=0;i<str.length;i++) buffer[i]=str.charCodeAt(i);
        return buffer;
    }
    window.loadProtectedAsset = async (id,type,signal) => {
        const name = bank.assetPaths[id];
        if (!name) throw new Error("未找到该题的图片。");
        const key = name.split("/").at(-1).replace(".","_");
        const data = await read("assets/" + encodeURIComponent(key),signal);
        return URL.createObjectURL(new Blob([fromBase64(data)],{type}));
    };
    form.addEventListener("submit",async event=>{
        event.preventDefault();
        const go = form.querySelector("button");
        const code = document.getElementById("entry-code");
        go.disabled=true;
        message.textContent="正在验证…";
        try {
            session=await login(document.getElementById("entry-name").value,code.value.trim());
            code.value="";
            const compressed=await read("index");
            const stream=new Blob([fromBase64(compressed)]).stream().pipeThrough(new DecompressionStream("gzip"));
            const json=await new Response(stream).text();
            bank=JSON.parse(json);
            document.getElementById("question-data").textContent=json;
            window.startQuestionBank();
            access.hidden=true;
            document.documentElement.classList.remove("bank-locked");
            document.getElementById("logout").hidden=false;
        } catch(error) {
            session=null;
            message.textContent=error.message==="Failed to fetch" ? "暂时无法连接验证服务，请稍后重试。" : error.message;
        } finally {
            go.disabled=false;
        }
    });
    document.getElementById("logout").addEventListener("click",()=>location.reload());
})();
