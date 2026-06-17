// app.js
let isDeadlined = false;

// 📢 实时监听并渲染公告栏
db.ref('settings/notice').on('value', (snapshot) => {
    const notice = snapshot.val();
    const board = document.getElementById('notice-board');
    const content = document.getElementById('notice-content');
    if (notice && notice.trim() !== "") {
        content.innerHTML = notice.replace(/\n/g, '<br>'); 
        board.style.display = 'block';
    } else {
        board.style.display = 'none'; 
    }
});

db.ref('settings/deadline').on('value', (snapshot) => {
    const deadline = snapshot.val();
    if (deadline && new Date() > new Date(deadline)) {
        isDeadlined = true;
        document.getElementById('booking-form').innerHTML = '<h3 style="text-align:center; color:red;">本轮预约已截止，请等待下一次开放。</h3>';
    }
});

// 📅 实时监听排班数据并执行“已满沉底”智能排序渲染
db.ref('slots').on('value', (snapshot) => {
    if (isDeadlined) return;
    const slots = snapshot.val();
    const container = document.getElementById('slots-container');
    container.innerHTML = '';

    if (!slots) {
        container.innerHTML = '<p>暂无开放的时间段。</p>';
        return;
    }

    const availableSlots = [];
    const reservedSlots = [];

    Object.keys(slots).forEach(slotId => {
        const slot = slots[slotId];
        if (slot.reserved) {
            reservedSlots.push({ id: slotId, data: slot });
        } else {
            availableSlots.push({ id: slotId, data: slot });
        }
    });

    const sortedSlots = [...availableSlots, ...reservedSlots];

    sortedSlots.forEach(item => {
        const slotId = item.id;
        const slot = item.data;
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
    
    const dateMatch = slotTime.match(/^(\d{1,2}\/\d{1,2})/);
    const targetDatePrefix = dateMatch ? dateMatch[1] : '';

    btn.disabled = true;
    btn.textContent = '提交中...';

    // 🔒 连环锁第一重：防止挂机绕过，提交瞬间再次比对最新的截止时间
    db.ref('settings/deadline').once('value').then((dlSnap) => {
        const currentDeadline = dlSnap.val();
        if (currentDeadline && new Date() > new Date(currentDeadline)) {
            showMessage('抱歉，本轮预约在刚刚已经截止了！', false);
            btn.disabled = false;
            btn.textContent = '提交预约';
            return;
        }

        // 🔒 连环锁第二重：同日防刷锁
        db.ref('reservations').once('value').then((resSnap) => {
            const currentRes = resSnap.val();
            if (currentRes && targetDatePrefix) {
                const hasBookedToday = Object.values(currentRes).some(r => 
                    r.nickname === nickname && r.time.startsWith(targetDatePrefix)
                );
                if (hasBookedToday) {
                    showMessage(`❌ 拦截：[${nickname}] 同学，你在 ${targetDatePrefix} 这一天已经预约过了。同一天内无法重复预约！`, false);
                    btn.disabled = false;
                    btn.textContent = '提交预约';
                    return;
                }
            }

            // 验证班级统一口令
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
                        // 🌟 优化②：生成 6 位极难碰撞的 字母+数字 专属取消凭证码
                        const randomCancelCode = Math.random().toString(36).substring(2, 8).toUpperCase();

                        db.ref('reservations').push({
                            nickname: nickname,
                            slotId: slotId,
                            time: slotTime,
                            cancelCode: randomCancelCode,
                            timestamp: new Date().toISOString()
                        }).then(() => {
                            document.getElementById('booking-form').innerHTML = `
                                <h2 style="text-align:center; color:#52c41a;">🎉 预约成功！</h2>
                                <p style="text-align:center;">你的姓名: <b>${nickname}</b></p>
                                <p style="text-align:center;">预约时间: <b>${slotTime}</b></p>
                                <div style="background:#fff7e6; border:1px solid #ffd591; padding:15px; border-radius:6px; margin-top:15px; text-align:center;">
                                    <span style="color:#d46b08; font-size:14px;">⚠️ <b>重要：专属取消凭证码</b></span><br>
                                    <b style="font-size:26px; color:#ff4d4f; letter-spacing:2px;">${randomCancelCode}</b><br>
                                    <small style="color:#666;">如果后面需要临时取消，必须输入此验证码。<br>请截图保存。</small>
                                </div>
                            `;
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
    const cancelCodeInput = document.getElementById('cancel-code').value.trim();

    if (!cancelNickname) return showMessage('请输入你想取消的姓名！', false);
    if (!cancelDateInput) return showMessage('请选择你想取消哪一天的课程！', false);
    if (!cancelCodeInput) return showMessage('请输入你的6位专属取消凭证码！', false);

    const dateParts = cancelDateInput.split('-');
    const month = parseInt(dateParts[1], 10);
    const day = parseInt(dateParts[2], 10);
    const targetDatePrefix = `${month}/${day}`;

    if (!confirm(`确定要取消姓名为 [${cancelNickname}] 在 ${targetDatePrefix} 的预约吗？`)) return;

    const cancelBtn = document.getElementById('cancel-btn');
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消...';

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
        let hasMatchedUser = false;
        let isCodeCorrect = false;

        Object.keys(reservations).forEach(key => {
            const r = reservations[key];
            if (r.nickname === cancelNickname && r.time.startsWith(targetDatePrefix)) {
                hasMatchedUser = true;
                if (r.cancelCode && r.cancelCode.toString().toUpperCase() === cancelCodeInput.toUpperCase()) {
                    isCodeCorrect = true;
                    targetResKey = key;
                    targetSlotId = r.slotId;
                }
            }
        });

        if (!hasMatchedUser) {
            showMessage(`未找到 [${cancelNickname}] 在 ${targetDatePrefix} 的预约，请核对信息。`, false);
            cancelBtn.disabled = false;
            cancelBtn.textContent = '确认取消我的预约';
            return;
        }

        if (!isCodeCorrect) {
            showMessage(`❌ 验证失败：你输入的专属取消凭证码不正确！`, false);
            cancelBtn.disabled = false;
            cancelBtn.textContent = '确认取消我的预约';
            return;
        }

        // 🌟 优化④：使用 Promise.all 保证两个原子节点同时修改成功，拒绝死账产生
        Promise.all([
            db.ref('slots/' + targetSlotId + '/reserved').set(false),
            db.ref('reservations/' + targetResKey).remove()
        ]).then(() => {
            showMessage(`成功取消 [${cancelNickname}] 在 ${targetDatePrefix} 的预约！该时间段已重新开放。`, true);
            document.getElementById('cancel-nickname').value = '';
            document.getElementById('cancel-date').value = '';
            document.getElementById('cancel-code').value = '';
            cancelBtn.disabled = false;
            cancelBtn.textContent = '确认取消我的预约';
        }).catch(() => {
            showMessage('取消失败，请刷新页面重试。', false);
            cancelBtn.disabled = false;
            cancelBtn.textContent = '确认取消我的预约';
        });
    });
}
