// app.js
let isDeadlined = false;
let currentNoticeText = ""; 
let currentNoticeImgHtml = ""; 

function renderStudentNoticeBoard() {
    const board = document.getElementById('notice-board');
    const content = document.getElementById('notice-content');
    if (!currentNoticeText && !currentNoticeImgHtml) { board.style.display = 'none'; return; }
    let htmlBuilder = currentNoticeText ? currentNoticeText.replace(/\n/g, '<br>') : "";
    if (currentNoticeImgHtml) htmlBuilder += currentNoticeImgHtml;
    content.innerHTML = htmlBuilder; board.style.display = 'block';
}

db.ref('settings/notice').on('value', (snapshot) => {
    const notice = snapshot.val(); currentNoticeText = (notice && notice.trim() !== "") ? notice : ""; renderStudentNoticeBoard();
});

db.ref('settings/noticeImage').on('value', (snapshot) => {
    currentNoticeImgHtml = snapshot.val() ? `<br><img src="${snapshot.val()}" style="max-width:100%; height:auto; border-radius:6px; margin-top:10px; display:block; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">` : "";
    renderStudentNoticeBoard();
});

// 🌟 核心更新：实时监听并对直连格式截止日期进行精准毫秒对比拦截
db.ref('settings/deadline').on('value', (snapshot) => {
    const deadline = snapshot.val();
    if (deadline) {
        const deadlineDate = new Date(deadline);
        if (!isNaN(deadlineDate.getTime()) && new Date() > deadlineDate) {
            isDeadlined = true; 
            document.getElementById('booking-form').innerHTML = '<h3 style="text-align:center; color:red;">本轮预约已截止，请等待下一次开放。</h3>';
        }
    }
});

db.ref('slots').on('value', (snapshot) => {
    if (isDeadlined) return;
    const slots = snapshot.val();
    const container = document.getElementById('slots-container');
    container.innerHTML = '';
    if (!slots) { container.innerHTML = '<p>暂无开放的时间段。</p>'; return; }

    const availableSlots = []; const reservedSlots = [];
    Object.keys(slots).forEach(slotId => {
        const slot = slots[slotId];
        if (slot.status === "hidden") return;
        if (!slot || !slot.time) return;

        if (slot.reserved) reservedSlots.push({ id: slotId, data: slot });
        else availableSlots.push({ id: slotId, data: slot });
    });

    const sortedSlots = [...availableSlots, ...reservedSlots];
    if (sortedSlots.length === 0) { container.innerHTML = '<p>暂无开放的时间段。</p>'; return; }

    sortedSlots.forEach(item => {
        const div = document.createElement('div');
        div.className = `slot-item ${item.data.reserved ? 'disabled' : ''}`;
        if (item.data.reserved) {
            div.innerHTML = `<span>${item.data.time}</span> <span style="color:#ff4d4f;">(已满)</span>`;
        } else {
            div.innerHTML = `<label style="display:flex; align-items:center; width:100%; cursor:pointer; font-weight:normal; margin:0;">
                <input type="radio" name="slot" value="${item.id}" data-time="${item.data.time}" style="margin-right:10px;">${item.data.time}</label>`;
        }
        container.appendChild(div);
    });
});

function showMessage(msg, isSuccess) {
    const msgEl = document.getElementById('message'); msgEl.textContent = msg; msgEl.className = isSuccess ? 'success' : 'error'; window.scrollTo(0, 0);
}

function submitBooking() {
    const nickname = document.getElementById('nickname').value.trim();
    const accessCode = document.getElementById('access-code').value.trim();
    const selectedSlot = document.querySelector('input[name="slot"]:checked');

    if (!nickname) return showMessage('请输入姓名！', false);
    if (!accessCode) return showMessage('请输入预约口令！', false);
    if (!selectedSlot) return showMessage('请选择一个时间！', false);

    const slotId = selectedSlot.value; const slotTime = selectedSlot.getAttribute('data-time');
    const match = slotTime.match(/^(\d{1,2}\/\d{1,2})/); const targetDate = match ? match[1] : '';
    const btn = document.getElementById('submit-btn'); btn.disabled = true; btn.textContent = '提交中...';

    db.ref('settings/deadline').once('value').then((dlSnap) => {
        const dlVal = dlSnap.val();
        if (dlVal) {
            const dlDate = new Date(dlVal);
            if (!isNaN(dlDate.getTime()) && new Date() > dlDate) {
                showMessage('抱歉，本轮预约已截止！', false); btn.disabled = false; return;
            }
        }

        db.ref('reservations').once('value').then((resSnap) => {
            const currentRes = resSnap.val();
            if (currentRes && targetDate) {
                const hasBookedToday = Object.values(currentRes).some(r => r.nickname === nickname && r.time && r.time.startsWith(targetDate));
                if (hasBookedToday) { showMessage(`❌ 拦截：您在 ${targetDate} 这天已有预约，同日限约一节！`, false); btn.disabled = false; btn.textContent = '提交预约'; return; }
            }

            db.ref('settings/accessCode').once('value').then((snapshot) => {
                if (accessCode !== (snapshot.val() || "123456")) { showMessage('口令错误，无法提交！', false); btn.disabled = false; return; }

                db.ref('slots/' + slotId).transaction((currentData) => {
                    if (currentData === null) return currentData;
                    if (!currentData.reserved && currentData.status !== "hidden") { currentData.reserved = true; return currentData; }
                    return; 
                }, (error, committed) => {
                    if (error || !committed) { showMessage('手慢了，该时间已被预约！', false); btn.disabled = false; }
                    else {
                        const randomCancelCode = (Math.random().toString(36).substring(2, 4) + Math.random().toString(36).substring(2, 5)).toUpperCase().slice(0, 5);
                        db.ref('reservations').push({
                            nickname: nickname, slotId: slotId, time: slotTime, cancelCode: randomCancelCode, timestamp: new Date().toISOString()
                        }).then(() => {
                            document.getElementById('booking-form').innerHTML = `
                                <h2 style="text-align:center; color:#52c41a;">🎉 预约成功！</h2>
                                <p style="text-align:center;">你的姓名: <b>${nickname}</b></p>
                                <p style="text-align:center;">预约时间: <b>${slotTime}</b></p>
                                <div style="background:#fff7e6; border:1px solid #ffd591; padding:15px; border-radius:6px; margin-top:15px; text-align:center;">
                                    <span style="color:#d46b08; font-size:14px;">⚠️ <b>重要：5位专属取消凭证码</b></span><br>
                                    <b style="font-size:26px; color:#ff4d4f; letter-spacing:2px;">${randomCancelCode}</b><br>
                                    <small style="color:#666;">如果后面需要临时取消，必须输入此验证码。<br>请截图保存。</small>
                                </div>`;
                        });
                    }
                });
            });
        });
    });
}

function cancelBooking() {
    const cancelNickname = document.getElementById('cancel-nickname').value.trim();
    const cancelDateInput = document.getElementById('cancel-date').value;
    const cancelCodeInput = document.getElementById('cancel-code').value.trim().toUpperCase();

    if (!cancelNickname || !cancelDateInput || !cancelCodeInput) return showMessage('请完整填写姓名、日期 and 凭证码！', false);
    const dateParts = cancelDateInput.split('-'); const targetDatePrefix = `${parseInt(dateParts[1], 10)}/${parseInt(dateParts[2], 10)}`;

    if (!confirm(`确定要取消 [${cancelNickname}] 在 ${targetDatePrefix} 的预约吗？`)) return;
    const cancelBtn = document.getElementById('cancel-btn'); cancelBtn.disabled = true;

    db.ref('reservations').once('value').then((resSnapshot) => {
        const reservations = resSnapshot.val();
        if (!reservations) { showMessage('没有找到相关的预约记录。', false); cancelBtn.disabled = false; return; }

        let targetResKey = null; let targetSlotId = null;
        Object.keys(reservations).forEach(key => {
            const r = reservations[key];
            if (r.nickname === cancelNickname && r.time && r.time.startsWith(targetDatePrefix) && r.cancelCode === cancelCodeInput) {
                targetResKey = key; targetSlotId = r.slotId;
            }
        });

        if (!targetResKey) { showMessage(`验证失败：姓名、日期或 5 位凭证码不匹配！`, false); cancelBtn.disabled = false; return; }

        db.ref('slots/' + targetSlotId).once('value').then((slotSnapshot) => {
            const slot = slotSnapshot.val();
            const updates = {};
            updates[`reservations/${targetResKey}`] = null;

            if (!slot || slot.status === "hidden") {
                updates[`slots/${targetSlotId}`] = null;
            } else {
                updates[`slots/${targetSlotId}/reserved`] = false;
            }

            db.ref().update(updates).then(() => {
                showMessage(`成功取消预约！该时间段已重新开放。`, true);
                document.getElementById('cancel-nickname').value = ''; document.getElementById('cancel-date').value = ''; document.getElementById('cancel-code').value = '';
                cancelBtn.disabled = false;
            }).catch(() => { alert('系统异常！'); cancelBtn.disabled = false; });
        });
    });
}
