// 教师端统一认证：Google 登录 + 数据库 UID 白名单。
// 这个文件只负责身份确认；真正的读写权限仍由 Database Rules 强制执行。
(function () {
    const ALLOWLIST_PATH = 'teacherAllowlist';

    function ensureFirebase(config) {
        if (!window.firebase) throw new Error('Firebase SDK 尚未加载');
        if (!firebase.apps.length) {
            if (!config) throw new Error('Firebase 配置尚未加载');
            firebase.initializeApp(config);
        }
        return { auth: firebase.auth(), database: firebase.database() };
    }

    function isGoogleUser(user) {
        if (!user || user.emailVerified !== true) return false;
        return (user.providerData || []).some(item => item && item.providerId === 'google.com');
    }

    async function getTeacherProfile(user, database) {
        if (!isGoogleUser(user)) return null;
        const snapshot = await database.ref(`${ALLOWLIST_PATH}/${user.uid}`).once('value');
        const value = snapshot.val();
        const enabled = value === true || (value && value.enabled === true);
        if (!enabled) return null;
        return {
            uid: user.uid,
            email: user.email || '',
            displayName: user.displayName || '',
            canManageSystem: Boolean(value && value.canManageSystem === true)
        };
    }

    async function signIn(config) {
        const { auth } = ensureFirebase(config);
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        // LOCAL 让从 admin.html 打开的 money.html / exam_teacher.html 共用登录状态。
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        // GitHub Pages 不是 Firebase Hosting，优先使用用户点击触发的弹窗，
        // 避免部分浏览器阻止跨域 redirect helper 的第三方存储访问。
        try {
            return await auth.signInWithPopup(provider);
        } catch (error) {
            if (error && error.code === 'auth/popup-blocked') {
                return auth.signInWithRedirect(provider);
            }
            throw error;
        }
    }

    function authErrorMessage(error) {
        const code = error && error.code;
        if (code === 'auth/unauthorized-domain') return '当前网页域名未加入 Firebase Authentication 授权域名。';
        if (code === 'auth/popup-blocked') return '浏览器拦截了登录弹窗，请允许本站弹窗后重试。';
        if (code === 'auth/popup-closed-by-user') return '登录窗口已关闭，请重试。';
        if (code === 'auth/operation-not-supported-in-this-environment') return '当前页面必须通过 HTTPS 打开，不能直接从本地文件打开。';
        return 'Google 登录失败，请检查网络和 Firebase Authentication 设置后重试。';
    }

    async function signOut(config) {
        const { auth } = ensureFirebase(config);
        await auth.signOut();
    }

    function requireTeacher(options) {
        const config = options && options.config;
        const overlay = options && options.overlay;
        const signInButton = options && options.signInButton;
        const signOutButton = options && options.signOutButton;
        const errorElement = options && options.errorElement;
        const onAuthorized = options && options.onAuthorized;
        const onSignedOut = options && options.onSignedOut;
        const requireManager = Boolean(options && options.requireManager);
        const { auth, database } = ensureFirebase(config);
        let wasAuthorized = false;
        let preserveAuthorizationError = false;

        const setError = message => {
            if (errorElement) errorElement.textContent = message || '';
        };
        const setBusy = busy => {
            if (signInButton) {
                signInButton.disabled = Boolean(busy);
                signInButton.textContent = busy ? '正在验证…' : '使用 Google 账号登录';
            }
        };
        const startLogin = () => {
            setBusy(true);
            setError('正在跳转到 Google 登录…');
            signIn(config).catch(error => {
                console.error('Google 登录失败:', error);
                setBusy(false);
                setError(authErrorMessage(error));
            });
        };
        if (signInButton) signInButton.onclick = startLogin;
        if (signOutButton) {
            signOutButton.hidden = true;
            signOutButton.onclick = async () => {
                signOutButton.disabled = true;
                try {
                    await auth.signOut();
                } catch (error) {
                    console.error('教师账号退出失败:', error);
                    setError('退出失败，请重试。');
                } finally {
                    signOutButton.disabled = false;
                }
            };
        }

        auth.onAuthStateChanged(async user => {
            if (!user) {
                setBusy(false);
                if (signOutButton) signOutButton.hidden = true;
                if (overlay) overlay.style.display = '';
                if (preserveAuthorizationError) {
                    preserveAuthorizationError = false;
                } else {
                    setError('请使用已加入教师名单的 Google 账号登录。');
                }
                if (wasAuthorized && typeof onSignedOut === 'function') onSignedOut();
                wasAuthorized = false;
                return;
            }
            setBusy(true);
            setError('正在检查教师权限…');
            try {
                const profile = await getTeacherProfile(user, database);
                if (!profile || (requireManager && !profile.canManageSystem)) {
                    const account = user.email ? `账号 ${user.email}` : '该 Google 账号';
                    const uidHint = user.uid ? `，当前 UID：${user.uid}` : '';
                    preserveAuthorizationError = true;
                    await auth.signOut();
                    setBusy(false);
                    setError(requireManager && profile
                        ? `${account} 没有系统管理权限，无法进入该页面。${uidHint}`
                        : `${account} 尚未加入教师名单。请将这个 UID 加入 teacherAllowlist：${user.uid || '未知'}`);
                    return;
                }
                if (overlay) overlay.style.display = 'none';
                if (signOutButton) signOutButton.hidden = false;
                setError('');
                setBusy(false);
                wasAuthorized = true;
                if (typeof onAuthorized === 'function') await onAuthorized(user, profile);
            } catch (error) {
                console.error('教师权限检查失败:', error);
                setBusy(false);
                setError('教师权限暂时无法确认，请刷新后重试。');
            }
        });

        return { auth, database, signOut: () => signOut(config) };
    }

    window.TeacherAuth = { ensureFirebase, getTeacherProfile, requireTeacher, signIn, signOut, isGoogleUser };
}());
