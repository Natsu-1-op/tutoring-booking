"use strict";
/**
 * 839 题库账号与激活码门禁
 *
 * 依赖：index.html 已加载 firebase-app / firebase-auth / firebase-database（v8）
 * 数据：users/{uid}        题库用户档案（与 years/{year}/studentWhitelist 完全独立）
 *      activation_codes/{code}  管理员生成的激活码，claim 子节点只能被原子兑换一次
 *
 * 对外接口 window.qbankAccount：
 *   getGrant()  返回 {key, release, expiresAt} 或 null（未登录/未激活/已过期/已停用）
 *   refresh()    重新核验访问权限（供 access.js 轮询使用）
 *   signOut()
 */
(() => {
    const configJSON = document.getElementById("internal-config");
    if (!configJSON) return;
    const config = JSON.parse(configJSON.textContent);
    const status = document.getElementById("internal-status");

    // 链接模式（带 #key=）沿用原有内部链接机制，不展示账号界面
    const linkMode = new URLSearchParams(location.hash.slice(1)).has("key");

    const slowNotice = (message, ms = 10000) => setTimeout(() => {
        const status = document.getElementById("internal-status");
        if (status && !document.getElementById("internal-gate")?.hidden) status.textContent = message;
    }, ms);

    const app = firebase.initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        databaseURL: config.database,
    }, "qbank");
    const auth = app.auth();
    const db = app.database();

    const $ = id => document.getElementById(id);
    const messages = {
        "auth/invalid-email": "邮箱格式不正确。",
        "auth/missing-email": "请填写邮箱。",
        "auth/weak-password": "密码至少 6 位，建议 8 位以上。",
        "auth/email-already-in-use": "该邮箱已注册，请直接登录。",
        "auth/wrong-password": "邮箱或密码不正确。",
        "auth/user-not-found": "邮箱或密码不正确。",
        "auth/invalid-login-credentials": "邮箱或密码不正确。",
        "auth/invalid-credential": "邮箱或密码不正确。",
        "auth/too-many-requests": "尝试次数过多，请稍后再试。",
        "auth/operation-not-allowed": "当前 Firebase 项目尚未启用「邮箱/密码」登录，请联系管理员。",
        "auth/network-request-failed": "无法连接 Firebase 登录服务，请检查网络后重试。",
        "auth/user-disabled": "该账号已被停用。",
        "PERMISSION_DENIED": "权限校验未通过，请确认激活码或联系管理员。",
    };
    const fail = error => {
        const code = String(error?.code || "");
        if (messages[code]) return messages[code];
        const raw = String(error?.message || messages[code] || "");
        if (messages[raw]) return messages[raw];
        // 代码里主动抛出的中文提示原样展示，不再被通用文案吞掉
        if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
        if (raw) console.warn("[qbank]", code, raw);
        return "操作失败，请稍后重试。";
    };
    const say = (text, kind) => {
        if (!status) return;
        status.textContent = text;
        status.dataset.kind = kind || "";
    };

    // ---------- 登录态 ----------

    function currentUser() {
        return new Promise(resolve => {
            const stop = auth.onAuthStateChanged(user => {
                stop();
                resolve(user);
            });
        });
    }

    // ---------- 访问权限核验 ----------

    /**
     * 读取 users/{uid} 下与访问相关的字段。
     * 受规则约束：bankAccess/key 只有在 active === true 且未过期且未被停用时才可读。
     */
    async function readAccess(user) {
        const root = `users/${user.uid}`;
        const [disabledSnap, activeSnap, expiresSnap] = await Promise.all([
            db.ref(`${root}/disabled`).once("value"),
            db.ref(`${root}/bankAccess/active`).once("value"),
            db.ref(`${root}/bankAccess/expiresAt`).once("value"),
        ]);
        if (disabledSnap.val() === true) return {state: "disabled"};
        if (activeSnap.val() !== true) return {state: "inactive"};
        const expiresAt = Number(expiresSnap.val()) || 0;
        if (!expiresAt || Date.now() >= expiresAt) return {state: "expired", expiresAt};
        return {state: "ok", expiresAt};
    }

    /**
     * 取解密所需的密钥。规则要求 users/{uid}/bankAccess/key 仅在该账号
     * active === true、未过期且未被停用时可读，因此这里读不到即视为无权限。
     */
    async function readGrant(user, expiresAt) {
        let keySnap, releaseSnap;
        try {
            [keySnap, releaseSnap] = await Promise.all([
                db.ref(`users/${user.uid}/bankAccess/key`).once("value"),
                db.ref(`users/${user.uid}/bankAccess/release`).once("value"),
            ]);
        } catch {
            return {state: "nokey"};
        }
        const key = keySnap.val();
        const release = releaseSnap.val();
        if (typeof key !== "string" || !key) return {state: "nokey"};
        if (release !== config.release) return {state: "outdated", release};
        return {key, release, expiresAt};
    }

    let cachedGrant = null;
    let cachedAt = 0;
    const GRANT_TTL = 30000;

    async function resolveGrant(force) {
        const user = await currentUser();
        if (!user) return {state: "signed-out"};
        if (!force && cachedGrant && Date.now() - cachedAt < GRANT_TTL && Date.now() < cachedGrant.expiresAt) {
            return cachedGrant;
        }
        const access = await readAccess(user);
        if (access.state !== "ok") {
            cachedGrant = null;
            return {state: access.state, expiresAt: access.expiresAt, user};
        }
        const grant = await readGrant(user, access.expiresAt);
        if (!grant || grant.state) {
            cachedGrant = null;
            return {state: grant?.state || "inactive", release: grant?.release, user};
        }
        cachedGrant = grant;
        cachedAt = Date.now();
        return grant;
    }

    async function getGrant() {
        const result = await resolveGrant(false);
        return result.state ? null : result;
    }

    async function refresh() {
        cachedGrant = null;
        const result = await resolveGrant(true);
        return result.state ? null : result;
    }

    // ---------- 激活码兑换 ----------

    function normalizeCode(raw) {
        const plain = String(raw || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
        if (plain.length !== 12) return "";
        return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`;
    }

    /**
     * 读取激活码里的密钥。
     * 规则只对「claim.usedBy === 本人」放行 key；release 本来就没有读取授权，
     * 所以取不到时沿用当前页面版本，不能把一次成功的兑换判成失败。
     */
    async function readCodeSecret(code) {
        let key;
        try {
            key = (await db.ref(`activation_codes/${code}/key`).once("value")).val();
        } catch (error) {
            console.warn("[qbank] activation key denied", error?.code);
            throw new Error("激活码的密钥读取被拒绝，请把这串激活码发给管理员核对。");
        }
        if (typeof key !== "string" || !key) throw new Error("激活码缺少密钥配置，请联系管理员。");
        let release = "";
        try {
            release = (await db.ref(`activation_codes/${code}/release`).once("value")).val() || "";
        } catch {
            release = ""; // 正常情况：学生账号没有读 release 的权限
        }
        return {key, release: release || config.release};
    }

    async function redeem(rawCode) {
        const user = await currentUser();
        if (!user) throw new Error("请先登录后再兑换激活码。");
        const code = normalizeCode(rawCode);
        if (!code) throw new Error("激活码格式为 XXXX-XXXX-XXXX，请检查。");

        // 1) 读取该码的时长与状态（受规则约束：仅公开 durationMs/days/revoked）
        const [durationSnap, daysSnap, revokedSnap] = await Promise.all([
            db.ref(`activation_codes/${code}/durationMs`).once("value"),
            db.ref(`activation_codes/${code}/days`).once("value"),
            db.ref(`activation_codes/${code}/revoked`).once("value"),
        ]);
        const durationMs = Number(durationSnap.val()) || 0;
        if (!durationMs) throw new Error("激活码不存在，请核对后重试。");
        if (revokedSnap.val() === true) throw new Error("这个激活码已被停用。");

        // 2) 是否已由本人兑换过。中途失败（比如密钥没写进个人档案）时，
        //    这里能接管旧记录补齐，避免激活码被“吃掉”后学生毫无办法。
        let ownClaim = null;
        try {
            ownClaim = (await db.ref(`activation_codes/${code}/claim`).once("value")).val();
        } catch {
            ownClaim = null; // 已被他人兑换时连读都不允许
        }
        if (ownClaim && ownClaim.usedBy !== user.uid) throw new Error("这个激活码已经被使用。");

        // 3) 原子兑换：claim 不存在时才写入，并发下由 transaction 保证只有一人成功
        let claimExpiresAt = Number(ownClaim?.expiresAt) || 0;
        if (!ownClaim) {
            const claimRef = db.ref(`activation_codes/${code}/claim`);
            const now = Date.now();
            claimExpiresAt = now + durationMs;
            let result;
            try {
                result = await claimRef.transaction(current => {
                    if (current !== null) return; // 已被兑换，终止
                    return {
                        usedBy: user.uid,
                        usedAt: now,
                        expiresAt: claimExpiresAt,
                        email: user.email || "",
                    };
                });
            } catch (error) {
                // 已被他人兑换时读权限即被拒，SDK 抛出 PERMISSION_DENIED
                if (String(error?.code || "").indexOf("PERMISSION_DENIED") >= 0) {
                    throw new Error("这个激活码已经被使用或已停用。");
                }
                throw error;
            }
            if (!result.committed) throw new Error("这个激活码已经被使用。");
        }

        // 4) 取密钥（受规则约束：兑换成功后该码的 key 才对本人可读）
        const {key, release} = await readCodeSecret(code);
        const days = Number(daysSnap.val()) || Math.round(durationMs / 86400000);

        // 5) 有效期：首次兑换按叠加规则；补齐旧记录时以 claim 记录的到期时间为上限，
        //    保证重复输入同一个码不会把天数越叠越多
        const currentExpires = Number(
            (await db.ref(`users/${user.uid}/bankAccess/expiresAt`).once("value")).val()) || 0;
        let expiresAt;
        let stacked = false;
        if (ownClaim) {
            expiresAt = Math.max(currentExpires, claimExpiresAt);
            if (expiresAt <= Date.now()) {
                throw new Error(`这个激活码您已于 ${dateText(claimExpiresAt)} 用完，请使用新的激活码。`);
            }
        } else {
            stacked = currentExpires > Date.now();
            expiresAt = Math.max(Date.now(), currentExpires) + durationMs;
        }

        await db.ref(`users/${user.uid}/bankAccess`).update({
            active: true,
            expiresAt,
            days,
            key,
            release,
            updatedAt: Date.now(),
        });
        await db.ref(`users/${user.uid}/claimedCodes/${code}`).set(expiresAt);
        cachedGrant = null;
        return {expiresAt, days, stacked, resumed: Boolean(ownClaim)};
    }

    // ---------- 界面 ----------

    const dateText = ts => new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(ts));

    function showTab(name) {
        for (const tab of document.querySelectorAll("#gate-tabs [data-tab]")) {
            tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
        }
        $("form-signin").hidden = name !== "signin";
        $("form-signup").hidden = name !== "signup";
        $("form-reset").hidden = name !== "reset";
    }

    function paintSignedOut() {
        $("gate-account").hidden = false;
        $("gate-signed-in").hidden = true;
        $("session-line").hidden = true;
        showTab("signin");
        say("请使用邮箱登录；首次使用请先注册并兑换激活码。");
    }

    function paintBlocked(state, user, expiresAt) {
        $("gate-account").hidden = true;
        $("gate-signed-in").hidden = false;
        $("gate-email").textContent = user.email || user.uid;
        $("session-line").hidden = true;
        $("form-activate").hidden = false;
        $("gate-signout").hidden = false;
        if (state === "disabled") {
            say("该账号已被停用，请联系管理员。");
        } else if (state === "expired") {
            say(`题库权限已于 ${dateText(expiresAt)} 到期，请输入新的激活码续期。`);
        } else if (state === "outdated") {
            say("题库已更新到新版本，请联系管理员获取对应激活码。");
        } else if (state === "nokey") {
            say("激活信息不完整（缺少密钥），请把上次那串激活码再输入一次完成绑定。");
        } else {
            say("账号尚未激活，请输入激活码解锁题库。");
        }
    }

    function paintExpiredAfterSignIn() {
        $("gate-account").hidden = true;
        $("gate-signed-in").hidden = false;
        $("form-activate").hidden = false;
        $("gate-signout").hidden = false;
    }

    async function paint() {
        if (linkMode) return;
        const user = await currentUser();
        if (!user) {
            paintSignedOut();
            return;
        }
        const access = await readAccess(user);
        if (access.state !== "ok") {
            paintBlocked(access.state, user, access.expiresAt);
            return;
        }
        const grant = await readGrant(user, access.expiresAt);
        if (!grant || grant.state) {
            paintBlocked(grant?.state || "inactive", user, access.expiresAt);
            return;
        }
        paintExpiredAfterSignIn();
        $("gate-email").textContent = user.email || user.uid;
        $("session-line").hidden = false;
        $("session-expires").textContent = dateText(access.expiresAt);
        $("form-activate").hidden = true;
        say("权限有效，正在载入题库…");
    }

    function bind() {
        if (linkMode) return;
        for (const tab of document.querySelectorAll("#gate-tabs [data-tab]")) {
            tab.addEventListener("click", () => {
                say("");
                showTab(tab.dataset.tab);
            });
        }

        $("form-signin").addEventListener("submit", async event => {
            event.preventDefault();
            const button = event.submitter;
            button.disabled = true;
            say("正在登录…");
            const warning = slowNotice("邮箱登录服务响应较慢。请运行网络检测；如需直接刷题，可向老师索取内部链接。");
            try {
                await auth.signInWithEmailAndPassword($("signin-email").value.trim(), $("signin-password").value);
                $("signin-password").value = "";
                await paint();
                if (await getGrant()) location.reload();
            } catch (error) {
                say(fail(error), "error");
            } finally {
                clearTimeout(warning);
                button.disabled = false;
            }
        });

        $("form-signup").addEventListener("submit", async event => {
            event.preventDefault();
            const button = event.submitter;
            if ($("signup-password").value !== $("signup-password2").value) {
                say("两次输入的密码不一致。", "error");
                return;
            }
            button.disabled = true;
            say("正在注册…");
            const warning = slowNotice("注册请求仍在等待。网络恢复后先试登录，确认是否已注册。");
            try {
                const credential = await auth.createUserWithEmailAndPassword(
                    $("signup-email").value.trim(), $("signup-password").value);
                const uid = credential.user.uid;
                // 首次建档：只写邮箱与创建时间，权限字段由激活码流程写入
                await db.ref(`users/${uid}`).set({
                    email: credential.user.email,
                    createdAt: Date.now(),
                });
                $("signup-password").value = "";
                $("signup-password2").value = "";
                await paint();
                say("注册成功，请输入激活码解锁题库。");
            } catch (error) {
                say(fail(error), "error");
            } finally {
                clearTimeout(warning);
                button.disabled = false;
            }
        });

        $("form-reset").addEventListener("submit", async event => {
            event.preventDefault();
            const button = event.submitter;
            button.disabled = true;
            say("正在发送重置邮件…");
            const warning = slowNotice("重置邮件请求仍在等待，请检查 Firebase 登录服务是否可达。");
            try {
                await auth.sendPasswordResetEmail($("reset-email").value.trim());
                say("重置邮件已发送，请查收邮箱（含垃圾邮件目录）并按邮件中的链接设置新密码。");
            } catch (error) {
                say(fail(error), "error");
            } finally {
                clearTimeout(warning);
                button.disabled = false;
            }
        });

        $("form-activate").addEventListener("submit", async event => {
            event.preventDefault();
            const button = event.submitter;
            button.disabled = true;
            say("正在兑换激活码…");
            const warning = slowNotice("题库授权数据库响应较慢。请勿重复兑换，网络恢复后先检查权限。");
            try {
                const done = await redeem($("activate-code").value);
                $("activate-code").value = "";
                say(done.resumed
                    ? `已补齐激活信息，到期时间 ${dateText(done.expiresAt)}。`
                    : done.stacked
                        ? `兑换成功，已在原有效期上叠加 ${done.days} 天，到期时间 ${dateText(done.expiresAt)}。`
                        : `兑换成功，有效期 ${done.days} 天，到期时间 ${dateText(done.expiresAt)}。`);
                cachedGrant = null;
                location.reload();
            } catch (error) {
                say(fail(error), "error");
            } finally {
                clearTimeout(warning);
                button.disabled = false;
            }
        });

        $("gate-signout").addEventListener("click", async () => {
            await auth.signOut();
            cachedGrant = null;
            location.reload();
        });
    }

    function signOut() {
        cachedGrant = null;
        return auth.signOut();
    }

    window.qbankAccount = {getGrant, refresh, signOut, redeem};

    bind();
    if (!linkMode) {
        const warning = slowNotice("正在等待登录状态或题库授权数据库。请运行网络检测，或使用老师发的内部链接。");
        paint().catch(error => say(fail(error), "error")).finally(() => clearTimeout(warning));
    }

    // 邮箱验证不属于准入条件，这里只做提示，不阻断使用
    auth.onAuthStateChanged(() => {
        cachedGrant = null;
    });
})();
