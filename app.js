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
        if (slot.status === "hidden" || !slot || !slot.time) return;

        if (slot.reserved) reservedSlots.push({ id: slotId, data: slot });
        else availableSlots.push({ id: slotId, data: slot });
    });

    const sortedSlots = [...availableSlots, ...reservedSlots];
    if (sortedSlots.length === 0) { container.innerHTML = '<p>暂无开放的时间段。</p>'; return; }

    sortedSlots.forEach(item => {
        const div = document.createElement('div');
        div.className = `slot-item ${item.data.reserved ? 'disabled' : ''}`;
        if (item.data.reserved) {
            div.innerHTML = `<span>${item.data.time}</span> <span style="color:#ff4d4f;">(已满/审批中)</span>`;
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
        if (dlVal && !isNaN(new Date(dlVal).getTime()) && new Date() > new Date(dlVal)) {
            showMessage('抱歉，本轮预约已截止！', false); btn.disabled = false; return;
        }

        db.ref('reservations').once('value').then((resSnap) => {
            const currentRes = resSnap.val();
            if (currentRes && targetDate) {
                const hasBookedToday = Object.values(currentRes).some(r => 
                    r.nickname === nickname && r.time && r.time.startsWith(targetDate) && r.status !== "Canceled"
                );
                if (hasBookedToday) { showMessage(`拦截：您在 ${targetDate} 这天已有申请，同日限约一节！`, false); btn.disabled = false; btn.textContent = '提交预约'; return; }
            }

            db.ref('settings/accessCode').once('value').then((snapshot) => {
                if (accessCode !== (snapshot.val() || "123456")) { showMessage('口令错误，无法提交！', false); btn.disabled = false; return; }

                db.ref('slots/' + slotId).transaction((currentData) => {
                    if (currentData === null) return currentData;
                    if (!currentData.reserved && currentData.status !== "hidden") { currentData.reserved = true; return currentData; }
                    return; 
                }, (error, committed) => {
                    if (error || !committed) { showMessage('手慢了，该时间已被抢占申请！', false); btn.disabled = false; }
                    else {
                        const randomCancelCode = (Math.random().toString(36).substring(2, 4) + Math.random().toString(36).substring(2, 5)).toUpperCase().slice(0, 5);
                        db.ref('reservations').push({
                            nickname: nickname,
                            slotId: slotId,
                            time: slotTime,
                            cancelCode: randomCancelCode,
                            status: "Pending", 
                            timestamp: new Date().toISOString()
                        }).then(() => {
                            document.getElementById('nickname').value = '';
                            document.getElementById('access-code').value = '';
                            showMessage('约课申请已提交！请前往“我的历史约课”页面查看审批状态。', true);
                            btn.disabled = false; btn.textContent = '提交预约申请';
                        });
                    }
                });
            });
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
    const container = document.getElementById('history-container');
    if (!searchName) return alert('请输入姓名以查询！');

    container.innerHTML = '<p style="text-align:center; color:#999;">正在调取您的辅导记录单...</p>';

    db.ref('reservations').once('value').then((snapshot) => {
        const reservations = snapshot.val();
        if (!reservations) { container.innerHTML = '<p style="text-align:center; color:#999; padding:20px;">暂无任何历史单据记录。</p>'; return; }

        let listHtml = "";
        let count = 0;

        Object.keys(reservations).sort((a,b) => new Date(reservations[b].timestamp) - new Date(reservations[a].timestamp)).forEach(key => {
            const r = reservations[key];
            if (r.nickname !== searchName) return;
            count++;

            let currentStatus = r.status || "Confirmed"; 
            let statusText = "";
            let badgeClass = "";
            let actionButtonHtml = "";

            switch(currentStatus) {
                case "Pending":
                    statusText = "待确认"; badgeClass = "status-pending";
                    actionButtonHtml = `<button class="action-btn" style="background:#f56c6c;" onclick="requestCancelBooking('${key}')">申请取消</button>`;
                    break;
                case "Confirmed":
                    statusText = "已确认"; badgeClass = "status-confirmed";
                    actionButtonHtml = `<button class="action-btn" style="background:#909399; cursor:not-allowed;" disabled title="已确认的课程不支持取消预约，请联系处理。">已确认（不支持取消）</button>`;
                    break;
                case "PendingCancel":
                    statusText = "待同意取消"; badgeClass = "status-pendingcancel";
                    actionButtonHtml = `<span style="font-size:13px; color:#f56c6c; font-weight:bold;"> 等待处理取消申请</span>`;
                    break;
                case "Canceled":
                    statusText = "已取消"; badgeClass = "status-canceled";
                    actionButtonHtml = `<span style="font-size:13px; color:#909399;">无操作</span>`;
                    break;
                case "Completed":
                    statusText = "已完成"; badgeClass = "status-completed";
                    actionButtonHtml = `<span style="font-size:13px; color:#67c23a;">无操作</span>`;
                    break;
            }

            listHtml += `
                <div class="history-card">
                    <div class="card-row"><b>辅导时段：</b><span style="color:#409eff; font-weight:bold;">${r.time}</span></div>
                    <div class="card-row"><b>当前状态：</b><span class="status-badge ${badgeClass}">${statusText}</span></div>
                    <div class="card-row" style="color:#999; font-size:12px;"><b>专属取消凭证：</b>${r.cancelCode || '无'}</div>
                    <div class="card-row" style="color:#999; font-size:12px;"><b>提交时间：</b>${new Date(r.timestamp).toLocaleString()}</div>
                    <div style="margin-top:10px; border-top:1px dashed #eee; padding-top:8px; text-align:right;">
                        ${actionButtonHtml}
                    </div>
                </div>
            `;
        });

        if (count === 0) {
            container.innerHTML = `<p style="text-align:center; color:#999; padding:20px;">未找到姓名为 [${searchName}] 的约课历史单据。</p>`;
        } else {
            container.innerHTML = listHtml;
        }
    });
}

function requestCancelBooking(resKey) {
    if (!confirm('确定要为这条待确认的课程发起取消申请吗？')) return;
    
    db.ref(`reservations/${resKey}`).update({ status: "PendingCancel" }).then(() => {
        alert('取消申请提交成功！请提醒他同意。');
        loadMyHistory(); 
    });
}
