let isDeadlined = false;

// 📢 新增：实时监听并渲染公告栏
db.ref('settings/notice').on('value', (snapshot) => {
    const notice = snapshot.val();
    const board = document.getElementById('notice-board');
    const content = document.getElementById('notice-content');
    if (notice && notice.trim() !== "") {
        content.innerHTML = notice.replace(/\n/g, '<br>'); // 支持后台换行
        board.style.display = 'block';
    } else {
        board.style.display = 'none'; // 没公告时自动隐藏
    }
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

    if (!slots) {
        container.innerHTML = '<p>暂无开放的时间段。</p>';
        return;
    }

    Object.keys(slots).forEach(slotId => {
        const slot = slots[slotId];
        const div = document.createElement('div');
        div.className = `slot-item ${slot.reserved ? 'disabled' : ''}`;

        if (slot.reserved) {
            div.innerHTML = `<span>${slot.time}</span> <span style="color:#ff4d4f;">(已满)</span>`;
        } else {
            div.innerHTML = `
                <label style="display:flex; align-items:center; width:100%; cursor:pointer; font-weight:normal; margin:0;">
                    <input type="radio" name="slot" value="${slotId}" data-time="${slot.time}" style="margin-right:10px;">
                    ${slot.time}
                </label>
            `;
        }
        container.appendChild(div);
    });
});

function showMessage(msg, isSuccess) {
    const msgEl = document.getElementById('message');
    msgEl.textContent = msg;
    msgEl.className = isSuccess ? 'success' : 'error';
    window.scrollTo(0, 0);
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
    const btn = document.getElementById('submit-btn');
    
    btn.disabled = true;
    btn.textContent = '提交中...';

    db.ref('settings/accessCode').once('value').then((snapshot) => {
        const correctCode = snapshot.val() || "123456";
        if (accessCode !== correctCode) {
            showMessage('口令错误，无法提交！请向老师核对。', false);
            btn.disabled = false;
            btn.textContent = '提交预约';
            return;
        }

        const slotRef = db.ref('slots/' + slotId);
        slotRef.transaction((currentData) => {
            if (currentData === null) return currentData;
            if (!currentData.reserved) {
                currentData.reserved = true;
                return currentData;
            } else {
                return; 
            }
        }, (error, committed) => {
            if (error || !committed) {
                showMessage('手慢了，该时间已被预约，请重新选择！', false);
                btn.disabled = false;
                btn.textContent = '提交预约';
            } else {
                db.ref('reservations').push({
                    nickname: nickname,
                    slotId: slotId,
                    time: slotTime,
                    timestamp: new Date().toISOString()
                }).then(() => {
                    document.getElementById('booking-form').innerHTML = `
                        <h2 style="text-align:center; color:#52c41a;">预约成功！</h2>
                        <p style="text-align:center;">你的姓名: <b>${nickname}</b></p>
                        <p style="text-align:center;">预约时间: <b>${slotTime}</b></p>
                    `;
                });
            }
        });
    });
}

function cancelBooking() {
    const cancelNickname = document.getElementById('cancel-nickname').value.trim();
    const cancelDateInput = document.getElementById('cancel-date').value;
    const cancelCode = document.getElementById('cancel-code').value.trim();

    if (!cancelNickname) return showMessage('请输入你想取消的姓名！', false);
    if (!cancelDateInput) return showMessage('请选择你想取消哪一天的课程！', false);
    if (!cancelCode) return showMessage('请输入口令以验证身份！', false);

    const dateParts = cancelDateInput.split('-');
    const month = parseInt(dateParts[1], 10);
    const day = parseInt(dateParts[2], 10);
    const targetDatePrefix = `${month}/${day}`;

    if (!confirm(`确定要取消姓名为 [${cancelNickname}] 在 ${targetDatePrefix} 的预约吗？`)) return;

    const cancelBtn = document.getElementById('cancel-btn');
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消...';

    db.ref('settings/accessCode').once('value').then((snapshot) => {
        const correctCode = snapshot.val() || "123456";
        if (cancelCode !== correctCode) {
            showMessage('验证口令错误，无法取消！', false);
            cancelBtn.disabled = false;
            cancelBtn.textContent = '确认取消我的预约';
            return;
        }

        db.ref('reservations').once('value').then((resSnapshot) => {
            const reservations = resSnapshot.val();
            if (!reservations) {
                showMessage('没有找到相关的预约记录。', false);
                cancelBtn.disabled = false;
                cancelBtn.textContent = '确认取消我的预约';
                return;
            }

            let targetResKey = null;
            let targetSlotId = null;

            Object.keys(reservations).forEach(key => {
                const r = reservations[key];
                if (r.nickname === cancelNickname) {
                    if (r.time.startsWith(targetDatePrefix)) {
                        targetResKey = key;
                        targetSlotId = r.slotId;
                    }
                }
            });

            if (!targetResKey || !targetSlotId) {
                showMessage(`未找到 [${cancelNickname}] 在 ${targetDatePrefix} 的预约，请核对日期或姓名。`, false);
                cancelBtn.disabled = false;
                cancelBtn.textContent = '确认取消我的预约';
                return;
            }

            db.ref('slots/' + targetSlotId + '/reserved').set(false).then(() => {
                db.ref('reservations/' + targetResKey).remove().then(() => {
                    showMessage(`成功取消 [${cancelNickname}] 在 ${targetDatePrefix} 的预约！该时间段已重新开放。`, true);
                    
                    document.getElementById('cancel-nickname').value = '';
                    document.getElementById('cancel-date').value = '';
                    document.getElementById('cancel-code').value = '';
                    cancelBtn.disabled = false;
                    cancelBtn.textContent = '确认取消我的预约';
                });
            });
        });
    });
}
