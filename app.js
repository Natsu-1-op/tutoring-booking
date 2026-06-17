// app.js
let isDeadlined = false;

db.ref('settings/notice').on('value', (snapshot) => {
    const notice = snapshot.val();
    const board = document.getElementById('notice-board');
    const content = document.getElementById('notice-content');
    if (notice && notice.trim() !== "") {
        content.innerHTML = notice.replace(/\n/g, '<br>'); board.style.display = 'block';
    } else { board.style.display = 'none'; }
});

db.ref('settings/deadline').on('value', (snapshot) => {
    const deadline = snapshot.val();
    if (deadline && new Date() > new Date(deadline)) {
        isDeadlined = true;
        document.getElementById('booking-form').innerHTML = '<h3 style="text-align:center; color:red;">本轮预约已截止，请等待下一次开放。</h3>';
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
        if (slot.reserved) reservedSlots.push({ id: slotId, data: slot });
        else availableSlots.push({ id: slotId, data: slot });
    });

    [...availableSlots, ...reservedSlots].forEach(item => {
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
    const msgEl = document.getElementById('message');
    msgEl.textContent = msg; msgEl.className = isSuccess ? 'success' : 'error'; window.scrollTo(0, 0);
}

function submitBooking() {
    const nickname = document.getElementById('nickname').value.trim();
    const accessCode = document.getElementById('access-code').value.trim();
    const selectedSlot = document.querySelector('input[name="slot"]:checked');

    if (!nickname) return showMessage('请输入姓名！', false);
    if (!accessCode) return showMessage('请输入预约口令！', false);
    if (!selectedSlot) return showMessage('请选择一个时间！', false);

    const slotId = selectedSlot.value;
    const slotTime = selectedSlot.getAttribute('data-time');
    const match = slotTime.match(/^(\d{1,2}\/\d{1,2})/);
    const targetDate = match ? match[1] : '';

    const btn = document.getElementById('submit-btn');
    btn.disabled = true; btn.textContent = '提交中...';

    db.ref('settings/deadline').once('value').then((dlSnap) => {
        if (dlSnap.val() && new Date() > new Date(dlSnap.val())) {
            showMessage('抱歉，本轮预约已截止！', false); btn.disabled = false; return;
        }

        // 同日防刷锁（限约一次）
        db.ref('reservations').once('value').then((resSnap) => {
            const currentRes = resSnap.val();
            if (currentRes && targetDate) {
                const hasBookedToday = Object.values(currentRes).some(r => r.nickname === nickname && r.time.startsWith(targetDate));
                if (hasBookedToday) {
                    showMessage(`❌ 拦截：您在 ${targetDate} 这天已有预约，同日限约一节！`, false);
                    btn.disabled = false; btn.textContent = '提交预约'; return;
                }
            }

            db.ref('settings/accessCode').once('value').then((snapshot) => {
                if (accessCode !== (snapshot.val() || "123456")) {
                    showMessage('口令错误，无法提交！', false); btn.disabled = false; return;
                }

                // 并发原子锁
                db.ref('slots/' + slotId).transaction((currentData) => {
                    if (currentData === null) return currentData;
                    if (!currentData.reserved) { currentData.reserved = true; return currentData; }
                    return; 
                }, (error, committed) => {
                    if (error || !committed) {
                        showMessage('手慢了，该时间已被预约！', false); btn.disabled = false;
                    } else {
                        // 🌟 修复④：采用极难碰撞的高强度 8 位字母数字组合作为退课凭证
                        const randomCancelCode = Math.random().toString(36).substring(2, 6).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

                        db.ref('reservations').push({
                            nickname: nickname, slotId: slotId, time: slotTime, cancelCode: randomCancelCode, timestamp: new Date().toISOString()
                        }).then(() => {
                            document.getElementById('booking-form').innerHTML = `
                                <h2 style="text-align:center; color:#52c41a;">🎉 预约成功！</h2>
                                <p style="text-align:center;">你的姓名: <b>${nickname}</b></p>
                                <p style="text-align:center;">预约时间: <b>${slotTime}</b></p>
                                <div style="background:#fff7e6; border:1px solid #ffd591; padding:15px; border-radius:6px; margin-top:15px; text-align:center;">
                                    <span style="color:#d46b08; font-size:14px;">⚠️ <b>专属凭证取消码（防代退）</b></span><br>
                                    <b style="font-size:26px; color:#ff4d4f; letter-spacing:2px;">${randomCancelCode}</b><br>
                                    <small style="color:#666;">临时调整必须输入此码，请截图或复制妥善保存。</small>
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

    if (!cancelNickname || !cancelDateInput || !cancelCodeInput) return showMessage('请完整填写姓名、日期和凭证码！', false);
    const dateParts = cancelDateInput.split('-');
    const targetDatePrefix = `${parseInt(dateParts[1], 10)}/${parseInt(dateParts[2], 10)}`;

    if (!confirm(`确定要取消 [${cancelNickname}] 在 ${targetDatePrefix} 的预约吗？`)) return;
    const cancelBtn = document.getElementById('cancel-btn');
    cancelBtn.disabled = true;

    db.ref('reservations').once('value').then((resSnapshot) => {
        const reservations = resSnapshot.val();
        if (!reservations) { showMessage('没有找到相关的预约记录。', false); cancelBtn.disabled = false; return; }

        let targetResKey = null; let targetSlotId = null;
        Object.keys(reservations).forEach(key => {
            const r = reservations[key];
            if (r.nickname === cancelNickname && r.time.startsWith(targetDatePrefix) && r.cancelCode === cancelCodeInput) {
                targetResKey = key; targetSlotId = r.slotId;
            }
        });

        if (!targetResKey) {
            showMessage(`验证失败：姓名、日期或专属凭证码不匹配！`, false); cancelBtn.disabled = false; return;
        }

        // 🌟 修复⑤：退课完美切换为 Multi-location updates 多路径提交，多节点强一致原子变更！
        const updates = {};
        updates[`slots/${targetSlotId}/reserved`] = false;
        updates[`reservations/${targetResKey}`] = null;

        db.ref().update(updates).then(() => {
            showMessage(`成功取消预约！该时间段已重新开放。`, true);
            document.getElementById('cancel-nickname').value = ''; document.getElementById('cancel-date').value = ''; document.getElementById('cancel-code').value = '';
            cancelBtn.disabled = false;
        }).catch(() => { alert('系统异常！'); cancelBtn.disabled = false; });
    });
}
