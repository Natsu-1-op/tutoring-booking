// app.js
let isDeadlined = false;
let isSubmitting = false;
let currentBookingReceipt = null;

const INVALID_FIREBASE_KEY_CHARS = /[.#$\/\[\]<>\u0000-\u001F\u007F]/;

function isValidStudentName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 50 && !INVALID_FIREBASE_KEY_CHARS.test(name) && !name.includes(',');
}

function generateSecureCode(length) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
}

function safeJsArg(value) {
    return escapeHtml(JSON.stringify(String(value ?? '')));
}

// 仅记住姓名；预约口令属于准入凭证，不落盘保存。
(function restoreSavedInputs() {
    const saved = localStorage.getItem('booking_last_inputs');
    if (saved) {
        try {
            const { name } = JSON.parse(saved);
            const nameEl = document.getElementById('nickname');
            if (nameEl && isValidStudentName(name)) nameEl.value = name;
            // 清除旧版本曾保存的口令。
            localStorage.setItem('booking_last_inputs', JSON.stringify({ name: isValidStudentName(name) ? name : '' }));
        } catch(e) {}
    }
})();

SystemRouter.system().on('value', (snap) => {
    const sys = snap.val();
    if (sys && /^\d{4}$/.test(String(sys.activeYear || ''))) {
        SystemRouter.activeYear = sys.activeYear;

        const titleEl = document.getElementById('main-title');
        if (titleEl) titleEl.textContent = "专业课辅导";

        const overlay = document.getElementById('sync-overlay');
        if (overlay) overlay.style.display = 'none';
        bindActiveYearListeners();
    }
});

let activeYearListeners = []; // 当前学年已绑定的监听器，切换学年时先卸载再重绑，避免监听器累积
let deadlineTimer = null;

function bindActiveYearListeners() {
    const year = SystemRouter.activeYear;

    // 先卸载上一学年绑定的监听器，否则每次切换都会多一套，导致重复渲染、跨学年公告串台
    activeYearListeners.forEach(({ ref, handler }) => ref.off('value', handler));
    activeYearListeners = [];
    if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
    }

    function bind(ref, handler) {
        ref.on('value', handler);
        activeYearListeners.push({ ref, handler });
    }

    let currentNoticeText = "";
    let currentNoticeImgSrc = "";

    function renderFullNoticeBoard() {
        const board = document.getElementById('notice-board');
        const content = document.getElementById('notice-content');
        if (!board || !content) return;
        if (!currentNoticeText && !currentNoticeImgSrc) {
            board.style.display = 'none';
            return;
        }
        content.replaceChildren();
        if (currentNoticeText) {
            const textEl = document.createElement('div');
            textEl.textContent = currentNoticeText;
            textEl.style.whiteSpace = 'pre-line';
            content.appendChild(textEl);
        }
        if (currentNoticeImgSrc) {
            const image = document.createElement('img');
            image.src = currentNoticeImgSrc;
            image.alt = '公告图片';
            image.style.cssText = 'max-width:100%; height:auto; border-radius:6px; margin-top:10px; display:block; box-shadow: 0 2px 8px rgba(0,0,0,0.05);';
            content.appendChild(image);
        }
        board.style.display = 'block';
    }

    bind(SystemRouter.getSettingsRef(year).child('notice'), (snapshot) => {
        const notice = snapshot.val();
        const normalizedNotice = notice == null ? '' : String(notice);
        currentNoticeText = normalizedNotice.trim() !== "" ? normalizedNotice : "";
        renderFullNoticeBoard();
    });

    bind(SystemRouter.getSettingsRef(year).child('noticeImage'), (snapshot) => {
        const imgBase64 = snapshot.val();
        currentNoticeImgSrc = (typeof imgBase64 === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(imgBase64)) ? imgBase64 : "";
        renderFullNoticeBoard();
    });

    function setDeadlineUi(deadlineHint, deadlineTime) {
        const formEl = document.getElementById('booking-form');
        if (!formEl || !deadlineHint) return;
        const closed = Number.isFinite(deadlineTime) && deadlineTime <= Date.now();
        isDeadlined = closed;
        formEl.style.display = closed ? 'none' : 'block';
        deadlineHint.style.display = closed ? 'block' : 'none';
        if (!closed) renderSlots();
    }

    function scheduleDeadlineCheck(deadlineTime, deadlineHint) {
        if (!Number.isFinite(deadlineTime) || deadlineTime <= Date.now()) return;
        // 浏览器对超过约 24.8 天的 setTimeout 可能发生 32 位溢出；分段检查。
        const remaining = deadlineTime - Date.now();
        const wait = Math.min(remaining, 24 * 60 * 60 * 1000);
        deadlineTimer = setTimeout(async () => {
            deadlineTimer = null;
            if (year !== SystemRouter.activeYear) return;
            if (wait < remaining) {
                scheduleDeadlineCheck(deadlineTime, deadlineHint);
                return;
            }
            try {
                const latest = (await SystemRouter.getSettingsRef(year).child('deadline').once('value')).val();
                const latestTime = latest ? new Date(latest).getTime() : NaN;
                setDeadlineUi(deadlineHint, latestTime);
                scheduleDeadlineCheck(latestTime, deadlineHint);
            } catch (e) {
                // 网络异常时不擅自关闭预约；短时间后重新确认云端状态。
                scheduleDeadlineCheck(Date.now() + 60 * 1000, deadlineHint);
            }
        }, Math.max(0, wait));
    }

    bind(SystemRouter.getSettingsRef(year).child('deadline'), (snapshot) => {
        const deadline = snapshot.val();
        let deadlineHint = document.getElementById('deadline-hint');
        if (!deadlineHint) {
            deadlineHint = document.createElement('h3'); deadlineHint.id = 'deadline-hint';
            deadlineHint.style.textAlign = 'center'; deadlineHint.style.color = 'red';
            deadlineHint.textContent = '本轮预约已截止，请等待下一次开放。';
            const formEl = document.getElementById('booking-form');
            if (formEl) formEl.parentNode.insertBefore(deadlineHint, formEl);
        }

        if (deadlineTimer) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
        }
        const deadlineTime = deadline ? new Date(deadline).getTime() : NaN;
        setDeadlineUi(deadlineHint, deadlineTime);
        scheduleDeadlineCheck(deadlineTime, deadlineHint);
    });

    let currentSlots = null;
    function renderSlots() {
        if (isDeadlined) return;
        const container = document.getElementById('slots-container');
        if (!container) return;
        container.innerHTML = '';
        if (!currentSlots) { container.innerHTML = '<p>暂无开放的时间段。</p>'; return; }

        const availableSlots = []; const reservedSlots = [];
        Object.keys(currentSlots).forEach(slotId => {
            const slot = currentSlots[slotId];
            if (!slot || slot.status === "hidden" || !slot.time) return;
            if (slot.reserved) reservedSlots.push({ id: slotId, data: slot });
            else availableSlots.push({ id: slotId, data: slot });
        });

        const sortedSlots = [...availableSlots, ...reservedSlots];
        if (sortedSlots.length === 0) { container.innerHTML = '<p>暂无开放的时间段。</p>'; return; }

        sortedSlots.forEach(item => {
            const div = document.createElement('div');
            div.className = `slot-item ${item.data.reserved ? 'disabled' : ''}`;
            const parsed = TimeParser.parseRawText(item.data.time, SystemRouter.activeYear);
            const displayTime = parsed ? parsed.formattedSlotText : String(item.data.time);
            if (item.data.reserved) {
                div.innerHTML = `<span>${escapeHtml(displayTime)}</span> <span class="text-red">(已满)</span>`;
            } else {
                div.innerHTML = `<label class="slot-radio-label">
                    <input type="radio" name="slot" value="${escapeHtml(item.id)}" data-time="${escapeHtml(item.data.time)}">${escapeHtml(displayTime)}</label>`;
            }
            container.appendChild(div);
        });
    }

    bind(SystemRouter.getSlotsRef(year), (snapshot) => {
        currentSlots = snapshot.val();
        renderSlots();
    });
}

function showMessage(msg, isSuccess) {
    const msgEl = document.getElementById('message'); msgEl.textContent = msg; msgEl.className = isSuccess ? 'success' : 'error'; window.scrollTo(0, 0);
}

function showBookingReceipt(receipt) {
    currentBookingReceipt = { ...receipt };
    const receiptEl = document.getElementById('booking-receipt');
    if (!receiptEl) return;
    document.getElementById('receipt-student-name').textContent = receipt.nickname;
    document.getElementById('receipt-lesson-time').textContent = receipt.time;
    document.getElementById('receipt-cancel-code').textContent = receipt.cancelCode;
    receiptEl.style.display = 'block';
    const formEl = document.getElementById('booking-form');
    if (formEl) formEl.style.display = 'none';
    const messageEl = document.getElementById('message');
    if (messageEl) messageEl.textContent = '';
}

function closeBookingReceipt() {
    currentBookingReceipt = null;
    const receiptEl = document.getElementById('booking-receipt');
    if (receiptEl) receiptEl.style.display = 'none';
    const formEl = document.getElementById('booking-form');
    if (formEl && !isDeadlined) formEl.style.display = 'block';
}

async function copyBookingReceiptCode() {
    if (!currentBookingReceipt) return;
    try {
        await navigator.clipboard.writeText(currentBookingReceipt.cancelCode);
        showMessage('取消凭证已复制。', true);
    } catch (error) {
        showMessage('复制失败，请手动记录凭证。', false);
    }
}

function downloadBookingReceipt() {
    if (!currentBookingReceipt) return;
    const text = [
        '专业课辅导预约凭证',
        `姓名：${currentBookingReceipt.nickname}`,
        `上课时间：${currentBookingReceipt.time}`,
        `取消凭证：${currentBookingReceipt.cancelCode}`,
        '',
        '查询或取消预约时需要使用取消凭证。'
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `预约凭证_${currentBookingReceipt.cancelCode}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function submitBooking() {
    if (isSubmitting) return;

    const nickname = document.getElementById('nickname').value.trim();
    const accessCode = document.getElementById('access-code').value.trim();
    const selectedSlot = document.querySelector('input[name="slot"]:checked');

    if (!nickname) return showMessage('请输入姓名！', false);
    if (!accessCode) return showMessage('请输入预约口令！', false);
    if (!selectedSlot) return showMessage('请选择一个时间！', false);
    if (!isValidStudentName(nickname)) return showMessage('姓名格式不合法（最多50字，不能包含逗号或路径特殊字符）！', false);
    if (accessCode.length > 128) return showMessage('预约口令格式不合法！', false);

    const slotId = selectedSlot.value; const slotTime = selectedSlot.getAttribute('data-time');
    const year = SystemRouter.activeYear;
    const parsedTimeObj = TimeParser.parseRawText(slotTime, year);
    if (!parsedTimeObj) return showMessage('排班格式错误，请联系老师处理！', false);

    const btn = document.getElementById('submit-btn');
    isSubmitting = true; btn.disabled = true; btn.textContent = '提交中...';
    function resetBtn() { isSubmitting = false; btn.disabled = false; btn.textContent = '提交预约申请'; }

    try {
        const dlVal = (await SystemRouter.getSettingsRef(year).child('deadline').once('value')).val();
        if (dlVal && !isNaN(new Date(dlVal).getTime()) && Date.now() > new Date(dlVal).getTime()) {
            showMessage('抱歉，本轮预约已截止！', false);
            return;
        }

        const whitelist = (await db.ref(`years/${year}/studentWhitelist`).once('value')).val();
        if (!whitelist) {
            showMessage('抱歉，本学年暂未录入任何准入学生名单！', false);
            return;
        }
        if (!Object.values(whitelist).some(approvedName => approvedName === nickname)) {
            showMessage('预约拦截：您不在本期专业课辅导学生名单中，请输入标准姓名！', false);
            return;
        }

        const existing = (await SystemRouter.getReservationsRef(year)
            .orderByChild('nickname').equalTo(nickname).once('value')).val();
        let hasSameDay = false;
        if (existing) {
            hasSameDay = Object.values(existing).some(r => {
                if (!r || r.status === 'canceled') return false;
                const p = TimeParser.parseRawText(r.time, year);
                return p && p.date === parsedTimeObj.date;
            });
        }
        if (hasSameDay) {
            const sameDayDate = parsedTimeObj.formattedSlotText.split(' ')[0];
            if (!confirm(`提醒：您在 ${sameDayDate} 当天已有其他预约。\n确定还要再约这一节吗？\n\n（同天多节是允许的，请确认您没有不小心选错时间）`)) return;
        }

        let usedHours = 0;
        if (existing) {
            Object.values(existing).forEach(r => {
                if (r && r.status !== 'canceled') usedHours += TimeParser.calcHours(r.time);
            });
        }
        const slotHours = TimeParser.calcHours(parsedTimeObj.formattedSlotText);
        const total = (await db.ref(`years/${year}/studentHours/${nickname}`).once('value')).val();
        if (total !== null && total !== undefined && Number(total) > 0 && usedHours + slotHours > Number(total)) {
            showMessage(`预约拦截：该时段为 ${slotHours.toFixed(2)} 小时，您当前剩余课时仅 ${Math.max(0, Number(total) - usedHours).toFixed(2)} 小时，无法预约。`, false);
            return;
        }

        const configuredAccessCode = (await SystemRouter.getSettingsRef(year).child('accessCode').once('value')).val();
        if (accessCode !== (configuredAccessCode || "123456")) {
            showMessage('预约口令错误！', false);
            return;
        }

        const resKey = SystemRouter.getReservationsRef(year).push().key;
        const committed = await new Promise((resolve, reject) => {
            SystemRouter.getSlotsRef(year).child(slotId).transaction((slot) => {
                if (slot && !slot.reserved && slot.status !== "hidden") {
                    slot.reserved = true;
                    slot.reservationId = resKey;
                    return slot;
                }
                return;
            }, (err, didCommit) => err ? reject(err) : resolve(didCommit));
        });
        if (!committed) {
            showMessage('手慢了，该时间段已被约满！', false);
            return;
        }

        const cancelSecureCode = generateSecureCode(5);
        try {
            await SystemRouter.getReservationsRef(year).child(resKey).set({
                nickname: nickname, slotId: slotId, reservationId: resKey, time: parsedTimeObj.formattedSlotText, status: "booked", cancelCode: cancelSecureCode,
                slotSnapshot: parsedTimeObj, timestamp: firebase.database.ServerValue.TIMESTAMP
            });
        } catch (reservationError) {
            try {
                await new Promise((resolve, reject) => {
                    SystemRouter.getSlotsRef(year).child(slotId).transaction((slot) => {
                        // 只回滚本次事务占用的时段，避免误释放后来者的预约。
                        if (!slot || slot.reservationId !== resKey) return;
                        slot.reserved = false;
                        delete slot.reservationId;
                        return slot;
                    }, (rollbackError) => rollbackError ? reject(rollbackError) : resolve());
                });
            }
            catch (rollbackError) { console.error('预约失败后的排班回滚失败:', rollbackError); }
            throw reservationError;
        }

        SystemRouter.getLogsRef(year).push({ action: `学生 [${nickname}] 预约成功: [${parsedTimeObj.formattedSlotText}]`, timestamp: firebase.database.ServerValue.TIMESTAMP })
            .catch(err => console.error('预约日志写入失败:', err));
        try { localStorage.setItem('booking_last_inputs', JSON.stringify({ name: nickname })); } catch(e) {}
        document.getElementById('nickname').value = '';
        showBookingReceipt({ nickname, time: parsedTimeObj.formattedSlotText, cancelCode: cancelSecureCode });
        downloadICS(parsedTimeObj, cancelSecureCode);
    } catch (err) {
        console.error('提交预约失败:', err);
        showMessage('操作失败，请检查网络后重试！', false);
    } finally {
        resetBtn();
    }
}

function switchView(view) {
    if (view === 'booking') {
        document.getElementById('booking-section').style.display = 'block';
        document.getElementById('history-section').style.display = 'none';
    } else {
        document.getElementById('booking-section').style.display = 'none';
        document.getElementById('history-section').style.display = 'block';
    }
}

function loadMyHistory() {
    const searchName = document.getElementById('history-search-name').value.trim();
    const searchCode = document.getElementById('history-search-code').value.trim().toUpperCase();
    const container = document.getElementById('history-container');
    
    if (!searchName) return alert('请输入真实姓名！');
    if (!isValidStudentName(searchName)) return alert('姓名格式不合法！');
    if (!searchCode) return alert('请输入5位取消凭证码！');
    if (!/^[A-Z2-9]{5}$/.test(searchCode)) return alert('取消凭证码格式不合法！');

    container.innerHTML = '<p class="msg-hint">正在查询...</p>';

    SystemRouter.getReservationsRef(SystemRouter.activeYear)
        .orderByChild('nickname')
        .equalTo(searchName)
        .once('value').then((snapshot) => {
            const reservations = snapshot.val();
            const isAuthPassed = reservations ? Object.values(reservations).some(r => (r.cancelCode || '').toUpperCase() === searchCode) : false;
            if (!isAuthPassed) {
                // 统一提示信息，不区分「姓名不存在」和「凭证码错误」，防止信息泄露
                container.innerHTML = `<p class="msg-error">姓名或凭证码错误！</p>`;
                return;
            }

            // 收集并排序：按上课时间倒序，最近的在最上面
            const list = [];
            Object.keys(reservations).forEach(key => {
                const r = reservations[key];
                if (r.nickname !== searchName) return;
                // 解析上课时间用于排序
                let lessonTs = 0;
                if (r.time) {
                    const p = TimeParser.parseRawText(r.time, SystemRouter.activeYear);
                    if (p && p.date) lessonTs = new Date(p.date + 'T' + p.startTime).getTime();
                }
                if (!lessonTs) lessonTs = r.timestamp || 0;
                list.push({ key, data: r, lessonTs });
            });
            list.sort((a, b) => b.lessonTs - a.lessonTs);

            // 统计已完成课时
            let completedHours = 0;
            list.forEach(item => {
                if (item.data.status === 'completed') {
                    completedHours += TimeParser.calcHours(item.data.time);
                }
            });

            let summaryHtml = '';
            if (completedHours > 0) {
                summaryHtml = `<div class="history-summary">已完成辅导累计：<b class="text-green">${completedHours.toFixed(2)} 小时</b></div>`;
            }

            // 已占用课时（未取消的预约合计），用于剩余课时展示
            let usedHours = 0;
            list.forEach(item => {
                if (item.data.status !== 'canceled') usedHours += TimeParser.calcHours(item.data.time);
            });

            let listHtml = "";
            list.forEach(item => {
                const r = item.data; const key = item.key;
                let currentStatus = r.status || "booked"; let statusText = ""; let badgeClass = ""; let actionButtonHtml = "";

                switch(currentStatus) {
                    case "booked":
                        statusText = "已预约"; badgeClass = "status-pending";
                        actionButtonHtml = `<button class="action-btn btn-cancel-booking" onclick="requestCancelBooking(${safeJsArg(key)})">取消预约</button>`;
                        break;
                    case "confirmed":
                        statusText = "已确认"; badgeClass = "status-confirmed";
                        actionButtonHtml = `<button class="action-btn btn-cancel-booking" onclick="requestCancelBooking(${safeJsArg(key)})">取消预约</button>`;
                        break;
                    case "completed": statusText = "已完成"; badgeClass = "status-completed"; break;
                    case "canceled": statusText = "已取消"; badgeClass = "status-canceled"; break;
                }

                const hours = TimeParser.calcHours(r.time);
                const hoursText = hours > 0 ? ` <span class="text-gray" style="font-size:12px;">(${hours.toFixed(2)}h)</span>` : '';
                // 统一日期格式：提取完整 YYYY-MM-DD
                let fullTime = r.time || '';
                const p = TimeParser.parseRawText(r.time, SystemRouter.activeYear);
                if (p) fullTime = `${p.date} ${p.startTime}-${p.endTime}`;

                // 日历下载按钮（传 time 字符串和 cancelCode，由 downloadICSFromTime 解析）
                const calBtn = r.time ? `<button class="action-btn btn-cal-add" onclick="downloadICSFromTime(${safeJsArg(r.time)}, ${safeJsArg(r.cancelCode || '')})" title="添加到手机日历">日历</button>` : '';

                listHtml += `
                    <div class="history-card">
                        <div class="card-row"><b>辅导时段：</b><span class="text-blue text-bold">${escapeHtml(fullTime)}${hoursText}</span></div>
                        <div class="card-row"><b>当前状态：</b><span class="status-badge ${badgeClass}">${escapeHtml(statusText)}</span></div>
                        <div class="card-row card-row-sub"><b>专属取消凭证：</b>${escapeHtml(r.cancelCode || '无')}</div>
                        <div class="card-row card-row-sub"><b>提交时间：</b>${r.timestamp ? new Date(r.timestamp).toLocaleString() : '未知提交时间'}</div>
                        <div class="card-footer">${calBtn} ${actionButtonHtml}</div>
                    </div>`;
            });

            // 剩余课时只在身份验证通过后读取并展示（避免输入姓名就泄露他人课时）
            return db.ref(`years/${SystemRouter.activeYear}/studentHours/${searchName}`).once('value').then((hs) => {
                const total = hs.val();
                let remainingHtml = '';
                if (total !== null && total !== undefined && Number(total) > 0) {
                    const remaining = Math.max(0, Number(total) - usedHours);
                    remainingHtml = `<div class="history-summary">剩余课时：<b class="text-blue">${remaining.toFixed(2)} 小时</b><span class="text-gray" style="font-size:12px;">（总课时 ${Number(total)} 小时，已用 ${usedHours.toFixed(2)} 小时）</span></div>`;
                }

                if (list.length === 0) container.innerHTML = `<p class="msg-hint">未找到对应的记录。</p>`;
                else container.innerHTML = summaryHtml + remainingHtml + listHtml;
            });
        }).catch((err) => {
            console.error('查询历史记录失败:', err);
            container.innerHTML = '<p class="msg-error">查询失败，请检查网络后重试。</p>';
        });
}

// 从 time 字符串解析并下载日历
function downloadICSFromTime(timeStr, cancelCode) {
    const parsed = TimeParser.parseRawText(timeStr, SystemRouter.activeYear);
    if (!parsed) return alert('无法解析时间，请联系老师。');
    downloadICS(parsed, cancelCode || '');
}

// 生成并下载 .ics 日历文件，可导入手机/电脑日历实现上课提醒
function downloadICS(parsedTimeObj, cancelCode) {
    if (!parsedTimeObj || !parsedTimeObj.date) return;
    const [y, m, d] = parsedTimeObj.date.split('-');
    const [sh, sm] = parsedTimeObj.startTime.split(':');
    const [eh, em] = parsedTimeObj.endTime.split(':');

    const pad = (n) => String(n).padStart(2, '0');
    const dtStart = `${y}${pad(m)}${pad(d)}T${sh}${sm}00`;
    const dtEnd   = `${y}${pad(m)}${pad(d)}T${eh}${em}00`;
    const escapeIcsText = (value) => String(value ?? '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,');

    const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TutoringBooking//CN',
        'BEGIN:VEVENT',
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        'SUMMARY:专业课辅导',
        `DESCRIPTION:预约凭证码: ${escapeIcsText(cancelCode)}\\n请提前5分钟到达教室`,
        'BEGIN:VALARM',
        'TRIGGER:-PT15M',
        'ACTION:DISPLAY',
        'DESCRIPTION:15分钟后有专业课辅导，请做好准备',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');

    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `辅导课_${parsedTimeObj.date}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function requestCancelBooking(resKey) {
    if (!confirm('确定要取消这条预约吗？取消后该时段将重新开放给其他同学。')) return;
    const year = SystemRouter.activeYear;
    let reservationCanceled = false;

    try {
        const snap = await SystemRouter.getReservationsRef(year).child(resKey).once('value');
        const r = snap.val();
        if (!r) return alert('记录不存在。');

        const reservationRef = SystemRouter.getReservationsRef(year).child(resKey);
        const cancelResult = await reservationRef.transaction(current => {
            if (!current || current.status === 'canceled') return;
            current.status = 'canceled';
            return current;
        });
        if (!cancelResult.committed) return alert('这条预约已经取消或不存在。');
        reservationCanceled = true;

        let slotReleased = null;
        if (r.slotId) {
            slotReleased = await new Promise((resolve, reject) => {
                SystemRouter.getSlotsRef(year).child(r.slotId).transaction(slot => {
                    // 旧数据没有 reservationId 时不自动释放，避免误开放已被其他预约占用的时段。
                    if (!slot || !slot.reserved || slot.reservationId !== resKey) return;
                    slot.reserved = false;
                    delete slot.reservationId;
                    return slot;
                }, (err, committed) => err ? reject(err) : resolve(committed));
            });
        }

        SystemRouter.getLogsRef(year).push({
            action: `学生 [${r.nickname}] 自行取消了预约: [${r.time}]`,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        }).catch(err => console.error('取消预约日志写入失败:', err));
        document.getElementById('history-container').innerHTML = '';
        if (slotReleased === false) {
            alert('预约已取消，但原排班没有可验证的所有权标记，时段暂未自动释放，请联系老师处理。');
        } else {
            alert('预约已取消。');
        }
    } catch (error) {
        console.error('取消预约失败:', error);
        alert(reservationCanceled
            ? '预约已标记取消，但排班释放失败，请联系老师检查该时段。'
            : '操作失败，请检查网络后重试。');
    }
}
