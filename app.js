// app.js
let isDeadlined = false;
let isSubmitting = false;
let currentBookingReceipt = null;
let currentHistorySessionToken = '';

const INVALID_FIREBASE_KEY_CHARS = /[.#$\/\[\]<>\u0000-\u001F\u007F]/;

function isValidStudentName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 50 && !INVALID_FIREBASE_KEY_CHARS.test(name) && !name.includes(',');
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

let systemReady = false;
const systemLoadTimeout = setTimeout(() => {
    if (systemReady) return;
    const syncText = document.getElementById('sync-text');
    if (syncText) syncText.textContent = '连接超时，请检查网络后刷新页面。';
}, 12000);

SystemRouter.system().on('value', (snap) => {
    const sys = snap.val();
    if (sys && /^\d{4}$/.test(String(sys.activeYear || ''))) {
        systemReady = true;
        clearTimeout(systemLoadTimeout);
        SystemRouter.activeYear = sys.activeYear;

        const titleEl = document.getElementById('main-title');
        if (titleEl) titleEl.textContent = "专业课辅导";

        const overlay = document.getElementById('sync-overlay');
        if (overlay) overlay.style.display = 'none';
        bindActiveYearListeners();
    } else {
        const syncText = document.getElementById('sync-text');
        if (syncText) syncText.textContent = '系统尚未配置开放学年，请联系老师。';
    }
}, (error) => {
    console.error('读取系统配置失败:', error);
    const syncText = document.getElementById('sync-text');
    if (syncText) syncText.textContent = '云端连接失败，请检查网络后刷新页面。';
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
    let emergencyClaims = {};
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
            const isReserved = Boolean(
                slot.reserved ||
                // 应急占位只有与当前排班的所有者(reservationId)一致才算"已满"。
                // 教师删除/取消后 slot.reservationId 会被移除，残留的占位不再影响显示，
                // 否则会出现"教师端空闲、学生端永久已满"。
                (emergencyClaims[slotId] && slot.reservationId === emergencyClaims[slotId])
            );
            const displaySlot = isReserved && !slot.reserved ? { ...slot, reserved: true } : slot;
            if (isReserved) reservedSlots.push({ id: slotId, data: displaySlot });
            else availableSlots.push({ id: slotId, data: displaySlot });
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

    bind(db.ref(`emergencySlotClaims/${year}`), (snapshot) => {
        emergencyClaims = snapshot.val() || {};
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
        const payload = { year, nickname, accessCode, slotId, confirmSameDay: false };
        let result;
        try {
            result = await StudentApi.createBooking(payload);
        } catch (firstError) {
            if (firstError.reason !== 'SAME_DAY_CONFIRMATION_REQUIRED') throw firstError;
            const sameDayDate = parsedTimeObj.formattedSlotText.split(' ')[0];
            const confirmed = confirm(`提醒：您在 ${sameDayDate} 当天已有其他预约。\n确定还要再约这一节吗？\n\n（同天多节是允许的，请确认您没有不小心选错时间）`);
            if (!confirmed) return;
            result = await StudentApi.createBooking({ ...payload, confirmSameDay: true });
        }
        try { localStorage.setItem('booking_last_inputs', JSON.stringify({ name: nickname })); } catch(e) {}
        document.getElementById('nickname').value = '';
        document.getElementById('access-code').value = '';
        showBookingReceipt({ nickname: result.nickname, time: result.time, cancelCode: result.cancelCode });
        downloadICS(result.slotSnapshot || parsedTimeObj, result.cancelCode);
    } catch (err) {
        console.error('提交预约失败:', err);
        const messages = {
            BOOKING_CLOSED: '抱歉，本轮预约已截止！',
            STUDENT_NOT_ALLOWED: '预约拦截：姓名不在本期学生名单中，请输入标准姓名。',
            ACCESS_CODE_INVALID: '预约口令错误！',
            ACCESS_CODE_NOT_CONFIGURED: '本学年尚未配置预约口令，请联系老师。',
            SLOT_UNAVAILABLE: '手慢了，该时间段已被约满，请刷新后重试！',
            INSUFFICIENT_HOURS: `预约拦截：剩余课时不足，无法预约该时段。`,
            RATE_LIMITED: '操作过于频繁，请稍后再试。',
            YEAR_CHANGED: '当前开放学年已经变化，请刷新页面后重试。'
        };
        showMessage(messages[err.reason] || err.message || '操作失败，请检查网络后重试！', false);
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

async function loadMyHistory() {
    const searchName = document.getElementById('history-search-name').value.trim();
    const searchCode = document.getElementById('history-search-code').value.trim().toUpperCase();
    const container = document.getElementById('history-container');
    
    if (!searchName) return alert('请输入真实姓名！');
    if (!isValidStudentName(searchName)) return alert('姓名格式不合法！');
    if (!searchCode) return alert('请输入5位取消凭证码！');
    if (!/^[A-Z2-9]{5}$/.test(searchCode)) return alert('取消凭证码格式不合法！');

    container.innerHTML = '<p class="msg-hint">正在查询...</p>';

    try {
            const response = await StudentApi.getBookingHistory({
                year: SystemRouter.activeYear,
                nickname: searchName,
                cancelCode: searchCode
            });
            currentHistorySessionToken = response.sessionToken || '';
            const list = (response.reservations || []).map(r => ({ key: r.id, data: r }));
            const summary = response.summary || {};
            let summaryHtml = '';
            if (Number(summary.completedHours) > 0) {
                summaryHtml = `<div class="history-summary">已完成辅导累计：<b class="text-green">${Number(summary.completedHours).toFixed(2)} 小时</b></div>`;
            }
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

            let remainingHtml = '';
            if (summary.totalHours !== null && summary.totalHours !== undefined) {
                remainingHtml = `<div class="history-summary">剩余课时：<b class="text-blue">${Number(summary.remainingHours || 0).toFixed(2)} 小时</b><span class="text-gray" style="font-size:12px;">（总课时 ${Number(summary.totalHours)} 小时，已用 ${Number(summary.usedHours || 0).toFixed(2)} 小时）</span></div>`;
            }
            if (list.length === 0) container.innerHTML = `<p class="msg-hint">未找到对应的记录。</p>`;
            else container.innerHTML = summaryHtml + remainingHtml + listHtml;
    } catch (err) {
        currentHistorySessionToken = '';
        console.error('查询历史记录失败:', err);
        const message = err.reason === 'HISTORY_AUTH_FAILED'
            ? '姓名或凭证码错误！'
            : err.reason === 'RATE_LIMITED'
                ? '查询过于频繁，请稍后再试。'
                : (err.message || '查询失败，请检查网络后重试。');
        container.innerHTML = `<p class="msg-error">${escapeHtml(message)}</p>`;
    }
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
    try {
        if (!currentHistorySessionToken) return alert('查询凭证已失效，请重新验证历史记录。');
        const result = await StudentApi.cancelBooking({ year, reservationId: resKey, sessionToken: currentHistorySessionToken });
        if (result.slotReleased === false) {
            alert('预约已取消，但原排班没有可验证的所有权标记，时段暂未自动释放，请联系老师处理。');
        } else {
            alert('预约已取消。');
        }
        await loadMyHistory();
    } catch (error) {
        console.error('取消预约失败:', error);
        if (error.reason === 'HISTORY_SESSION_EXPIRED') currentHistorySessionToken = '';
        alert(error.message || '操作失败，请检查网络后重试。');
    }
}
