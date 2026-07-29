// app.js
let isDeadlined = false;
let isSubmitting = false; 

SystemRouter.system().on('value', (snap) => {
    const sys = snap.val();
    if (sys && sys.activeYear) {
        SystemRouter.activeYear = sys.activeYear;
        
        const titleEl = document.getElementById('main-title');
        if (titleEl) titleEl.textContent = "专业课辅导";
        
        const overlay = document.getElementById('sync-overlay');
        if (overlay) overlay.style.display = 'none';
        
        bindActiveYearListeners();
    }
});

function bindActiveYearListeners() {
    const year = SystemRouter.activeYear;
    
    let currentNoticeText = "";
    let currentNoticeImgHtml = "";

    function renderFullNoticeBoard() {
        const board = document.getElementById('notice-board');
        const content = document.getElementById('notice-content');
        if (!currentNoticeText && !currentNoticeImgHtml) {
            board.style.display = 'none';
            return;
        }
        let htmlBuilder = currentNoticeText ? escapeHtml(currentNoticeText).replace(/\n/g, '<br>') : "";
        if (currentNoticeImgHtml) {
            htmlBuilder += currentNoticeImgHtml;
        }
        content.innerHTML = htmlBuilder;
        board.style.display = 'block';
    }

    SystemRouter.getSettingsRef(year).child('notice').on('value', (snapshot) => {
        const notice = snapshot.val();
        currentNoticeText = (notice && notice.trim() !== "") ? notice : "";
        renderFullNoticeBoard();
    });

    SystemRouter.getSettingsRef(year).child('noticeImage').on('value', (snapshot) => {
        const imgBase64 = snapshot.val();
        currentNoticeImgHtml = imgBase64 ? `<br><img src="${imgBase64}" style="max-width:100%; height:auto; border-radius:6px; margin-top:10px; display:block; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">` : "";
        renderFullNoticeBoard();
    });

    SystemRouter.getSettingsRef(year).child('deadline').on('value', (snapshot) => {
        const deadline = snapshot.val();
        let deadlineHint = document.getElementById('deadline-hint');
        if (!deadlineHint) {
            deadlineHint = document.createElement('h3'); deadlineHint.id = 'deadline-hint';
            deadlineHint.style.textAlign = 'center'; deadlineHint.style.color = 'red';
            deadlineHint.textContent = '本轮预约已截止，请等待下一次开放。';
            const formEl = document.getElementById('booking-form');
            if (formEl) formEl.parentNode.insertBefore(deadlineHint, formEl);
        }
        
        if (deadline && !isNaN(new Date(deadline).getTime()) && new Date() > new Date(deadline)) {
            isDeadlined = true;
            document.getElementById('booking-form').style.display = 'none';
            deadlineHint.style.display = 'block';
        } else {
            isDeadlined = false;
            document.getElementById('booking-form').style.display = 'block';
            deadlineHint.style.display = 'none';
        }
    });

    SystemRouter.getSlotsRef(year).on('value', (snapshot) => {
        if (isDeadlined) return;
        const slots = snapshot.val();
        const container = document.getElementById('slots-container');
        container.innerHTML = '';
        if (!slots) { container.innerHTML = '<p>暂无开放的时间段。</p>'; return; }

        const availableSlots = []; const reservedSlots = [];
        Object.keys(slots).forEach(slotId => {
            const slot = slots[slotId];
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
            const displayTime = parsed ? parsed.formattedSlotText : item.data.time;

            if (item.data.reserved) {
                div.innerHTML = `<span>${escapeHtml(displayTime)}</span> <span class="text-red">(已满)</span>`;
            } else {
                div.innerHTML = `<label class="slot-radio-label">
                    <input type="radio" name="slot" value="${item.id}" data-time="${escapeHtml(item.data.time)}">${escapeHtml(displayTime)}</label>`;
            }
            container.appendChild(div);
        });
    });
}

function showMessage(msg, isSuccess) {
    const msgEl = document.getElementById('message'); msgEl.textContent = msg; msgEl.className = isSuccess ? 'success' : 'error'; window.scrollTo(0, 0);
}

function submitBooking() {
    if (isSubmitting) return;

    const nickname = document.getElementById('nickname').value.trim();
    const accessCode = document.getElementById('access-code').value.trim();
    const selectedSlot = document.querySelector('input[name="slot"]:checked');

    if (!nickname) return showMessage('请输入姓名！', false);
    if (!accessCode) return showMessage('请输入预约口令！', false);
    if (!selectedSlot) return showMessage('请选择一个时间！', false);
    if (nickname.includes(',')) return showMessage('姓名中不能包含逗号！', false);

    const slotId = selectedSlot.value; const slotTime = selectedSlot.getAttribute('data-time');
    const year = SystemRouter.activeYear;

    const parsedTimeObj = TimeParser.parseRawText(slotTime, year);
    if (!parsedTimeObj) return showMessage('排班格式错误，请联系老师处理！', false);

    const btn = document.getElementById('submit-btn');
    isSubmitting = true; btn.disabled = true; btn.textContent = '提交中...';

    function resetBtn() { isSubmitting = false; btn.disabled = false; btn.textContent = '提交预约申请'; }

    SystemRouter.getSettingsRef(year).child('deadline').once('value').then((dlSnap) => {
        const dlVal = dlSnap.val();
        if (dlVal && !isNaN(new Date(dlVal).getTime()) && new Date() > new Date(dlVal)) {
            showMessage('抱歉，本轮预约已截止！', false); resetBtn(); return;
        }

        db.ref(`years/${year}/studentWhitelist`).once('value').then((whitelistSnap) => {
            const whitelist = whitelistSnap.val();
            if (!whitelist) {
                showMessage('抱歉，本学年暂未录入任何准入学生名单！', false);
                resetBtn(); return;
            }

            const isNameAuthorized = Object.values(whitelist).some(approvedName => approvedName === nickname);
            if (!isNameAuthorized) {
                showMessage('预约拦截：您不在本期专业课辅导学生名单中，请输入标准姓名！', false);
                resetBtn(); return;
            }

            // 同天多节提醒：查询该学生当天是否已有预约
            SystemRouter.getReservationsRef(year)
                .orderByChild('nickname').equalTo(nickname)
                .once('value').then((existingSnap) => {
                    const existing = existingSnap.val();
                    let hasSameDay = false;
                    if (existing) {
                        const targetDate = parsedTimeObj.date; // 格式 YYYY-MM-DD
                        hasSameDay = Object.values(existing).some(r => {
                            if (!r || r.status === 'canceled') return false;
                            const p = TimeParser.parseRawText(r.time, year);
                            return p && p.date === targetDate;
                        });
                    }

                    if (hasSameDay) {
                        const sameDayDate = parsedTimeObj.formattedSlotText.split(' ')[0];
                        if (!confirm(`提醒：您在 ${sameDayDate} 当天已有其他预约。\n确定还要再约这一节吗？\n\n（同天多节是允许的，请确认您没有不小心选错时间）`)) {
                            resetBtn(); return;
                        }
                    }

                    // 通过所有校验，开始约课
                    SystemRouter.getSettingsRef(year).child('accessCode').once('value').then((snapshot) => {
                        if (accessCode !== (snapshot.val() || "123456")) {
                            showMessage('预约口令错误！', false); resetBtn(); return;
                        }

                        SystemRouter.getSlotsRef(year).child(slotId).transaction((slot) => {
                            if (slot && !slot.reserved && slot.status !== "hidden") {
                                slot.reserved = true; return slot;
                            }
                            return;
                        }, (err, committed) => {
                            if (!committed) {
                                showMessage('手慢了，该时间段已被约满！', false); resetBtn(); return;
                            }

                            const resKey = SystemRouter.getReservationsRef(year).push().key;
                            const cancelSecureCode = Math.random().toString(36).substring(2, 7).toUpperCase();

                            SystemRouter.getReservationsRef(year).child(resKey).set({
                                nickname: nickname, slotId: slotId, time: parsedTimeObj.formattedSlotText, status: "booked", cancelCode: cancelSecureCode,
                                slotSnapshot: parsedTimeObj, timestamp: firebase.database.ServerValue.TIMESTAMP
                            }).then(() => {
                                SystemRouter.getLogsRef(year).push({ action: `学生 [${nickname}] 预约成功: [${parsedTimeObj.formattedSlotText}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                                document.getElementById('nickname').value = ''; resetBtn();
                                showMessage(`预约成功！您的取消凭证码为:【 ${cancelSecureCode} 】, 查询记录时需要输入此凭证！`, true);
                            }).catch(() => {
                                SystemRouter.getSlotsRef(year).child(slotId).update({ reserved: false });
                                showMessage('网络异常，请重试！', false); resetBtn();
                            });
                        });
                    });
                });
        }).catch((err) => {
            console.error('提交预约失败:', err);
            showMessage('操作失败，请检查网络后重试！', false);
            resetBtn();
        });
    });
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
    if (!searchCode) return alert('请输入5位取消凭证码！');

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

            let listHtml = ""; let count = 0;
            Object.keys(reservations).sort((a,b) => new Date(reservations[b].timestamp || 0) - new Date(reservations[a].timestamp || 0)).forEach(key => {
                const r = reservations[key]; if (r.nickname !== searchName) return; count++;
                let currentStatus = r.status || "booked"; let statusText = ""; let badgeClass = ""; let actionButtonHtml = "";

                switch(currentStatus) {
                    case "booked":
                        statusText = "已预约"; badgeClass = "status-pending";
                        actionButtonHtml = `<button class="action-btn btn-cancel-booking" onclick="requestCancelBooking('${key}')">取消预约</button>`;
                        break;
                    case "confirmed":
                        statusText = "已确认"; badgeClass = "status-confirmed";
                        actionButtonHtml = `<button class="action-btn btn-cancel-booking" onclick="requestCancelBooking('${key}')">取消预约</button>`;
                        break;
                    case "completed": statusText = "已完成"; badgeClass = "status-completed"; break;
                    case "canceled": statusText = "已取消"; badgeClass = "status-canceled"; break;
                }

                listHtml += `
                    <div class="history-card">
                        <div class="card-row"><b>辅导时段：</b><span class="text-blue text-bold">${escapeHtml(r.time)}</span></div>
                        <div class="card-row"><b>当前状态：</b><span class="status-badge ${badgeClass}">${escapeHtml(statusText)}</span></div>
                        <div class="card-row card-row-sub"><b>专属取消凭证：</b>${escapeHtml(r.cancelCode || '无')}</div>
                        <div class="card-row card-row-sub"><b>提交时间：</b>${r.timestamp ? new Date(r.timestamp).toLocaleString() : '未知提交时间'}</div>
                        <div class="card-footer">${actionButtonHtml}</div>
                    </div>`;
            });

            if (count === 0) container.innerHTML = `<p class="msg-hint">未找到对应的记录。</p>`;
            else container.innerHTML = listHtml;
        }).catch((err) => {
            console.error('查询历史记录失败:', err);
            container.innerHTML = '<p class="msg-error">查询失败，请检查网络后重试。</p>';
        });
}

function requestCancelBooking(resKey) {
    if (!confirm('确定要取消这条预约吗？取消后该时段将重新开放给其他同学。')) return;
    const year = SystemRouter.activeYear;

    SystemRouter.getReservationsRef(year).child(resKey).once('value').then((snap) => {
        const r = snap.val();
        if (!r) { alert('记录不存在。'); return; }

        const updates = {};
        updates[`years/${year}/reservations/${resKey}/status`] = "canceled";
        if (r.slotId) {
            updates[`years/${year}/slots/${r.slotId}/reserved`] = false;
        }

        db.ref().update(updates).then(() => {
            SystemRouter.getLogsRef(year).push({
                action: `学生 [${r.nickname}] 自行取消了预约: [${r.time}]`,
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
            alert('预约已取消。');
            document.getElementById('history-container').innerHTML = '';
        }).catch(() => {
            alert('操作失败，请检查网络后重试。');
        });
    }).catch(() => {
        alert('操作失败，请检查网络后重试。');
    });
}
