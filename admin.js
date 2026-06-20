// admin.js

let initialized = false; 
let dateCollapseState = {};
let resCollapseState = {}; 
let reservationsData = []; 
let currentCloudImageBase64 = ""; 

function verifyAdmin() {
    const inputPass = document.getElementById('admin-password').value.trim();
    const errorEl = document.getElementById('login-error');
    if (!inputPass) return alert('请输入密码！');

    db.ref(`admin_auth/${inputPass}`).once('value').then((snapshot) => {
        if (snapshot.exists() && snapshot.val() === true) {
            document.getElementById('admin-login').style.display = 'none';
            document.getElementById('admin-content').style.display = 'block';
            initAdminSystem();
        } else {
            errorEl.textContent = '密码验证失败，拒绝访问！';
        }
    }).catch((error) => {
        errorEl.textContent = '网络连接异常或权限不足！';
    });
}

document.getElementById('admin-password').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') verifyAdmin();
});

function isValidCalendarDate(month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    if (month === 2) return day <= 29; 
    if ([4, 6, 9, 11].includes(month)) return day <= 30;
    return true;
}

function initAdminSystem() {
    if (initialized) return;
    initialized = true;

    db.ref('slots').on('value', (snapshot) => {
        const slots = snapshot.val();
        const container = document.getElementById('admin-slots-container');
        container.innerHTML = '';
        if (!slots) { container.innerHTML = '<p>暂无排班时间段。</p>'; return; }

        const groups = {};
        Object.keys(slots).forEach(slotId => {
            const slot = slots[slotId];
            if (!slot || !slot.time || slot.status === "hidden") return;

            const match = slot.time.match(/^(\d{1,2})\/(\d{1,2})/);
            const dateKey = match ? `${parseInt(match[1], 10)}/${parseInt(match[2], 10)}` : "其他日期格式";
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push({ id: slotId, data: slot });
        });

        Object.keys(groups).sort((a, b) => {
            const [am, ad] = a.split('/').map(Number);
            const [bm, bd] = b.split('/').map(Number);
            return new Date(2026, am - 1, ad) - new Date(2026, bm - 1, bd);
        }).forEach(dateKey => {
            const dateGroupDiv = document.createElement('div');
            dateGroupDiv.className = 'date-group';
            if (dateCollapseState[dateKey] === undefined) dateCollapseState[dateKey] = true; 

            const header = document.createElement('div');
            header.className = 'date-header';
            header.innerHTML = `<span>📅 ${dateKey} 排班列表</span> <span class="arrow-indicator">${dateCollapseState[dateKey] ? '展开 ➕' : '收起 ➖'}</span>`;
            const body = document.createElement('div');
            body.className = `date-body ${dateCollapseState[dateKey] ? 'collapsed' : ''}`;

            header.onclick = () => {
                dateCollapseState[dateKey] = !dateCollapseState[dateKey];
                body.classList.toggle('collapsed');
                header.querySelector('.arrow-indicator').textContent = dateCollapseState[dateKey] ? '展开 ➕' : '收起 ➖';
            };

            groups[dateKey].forEach(item => {
                const slotDiv = document.createElement('div');
                slotDiv.className = 'slot-item';
                slotDiv.id = `slot-row-${item.id}`; 
                slotDiv.innerHTML = `
                    <span class="slot-text-span">${item.data.time} ${item.data.reserved ? '<strong style="color:red">(已约)</strong>' : '<strong style="color:green">(空闲)</strong>'}</span>
                    <div class="btn-group">
                        <button style="background:#67c23a; width:auto; padding:8px 12px; font-size:14px;" onclick="startEditSlot('${item.id}', '${item.data.time}')">修改</button>
                        <button class="danger" onclick="deleteSlot('${item.id}')">删除</button>
                    </div>`;
                body.appendChild(slotDiv);
            });
            dateGroupDiv.appendChild(header); dateGroupDiv.appendChild(body); container.appendChild(dateGroupDiv);
        });
    });

    db.ref('settings/notice').on('value', (snapshot) => {
        if (snapshot.val() !== null) document.getElementById('notice-input').value = snapshot.val();
    });

    db.ref('settings/noticeImage').on('value', (snapshot) => {
        const previewContainer = document.getElementById('admin-img-preview-container');
        const previewImg = document.getElementById('admin-img-preview');
        if (snapshot.val()) {
            currentCloudImageBase64 = snapshot.val();
            previewImg.src = currentCloudImageBase64;
            previewContainer.style.display = 'block';
        } else {
            currentCloudImageBase64 = ""; previewImg.src = ""; previewContainer.style.display = 'none';
        }
    });

    db.ref('settings/deadline').on('value', (snapshot) => { if (snapshot.val()) document.getElementById('deadline-input').value = snapshot.val(); });
    db.ref('settings/accessCode').on('value', (snapshot) => { if (snapshot.val()) document.getElementById('code-input').value = snapshot.val(); });

    db.ref('reservations').on('value', (snapshot) => {
        const res = snapshot.val();
        const container = document.getElementById('admin-reservations-container');
        
        const pendingPanel = document.getElementById('pending-approval-panel');
        const pendingList = document.getElementById('pending-approval-list');
        const cancelPanel = document.getElementById('cancel-approval-panel');
        const cancelList = document.getElementById('cancel-approval-list');

        container.innerHTML = '';
        pendingList.innerHTML = '';
        cancelList.innerHTML = '';

        reservationsData = [];
        if (!res) { 
            container.innerHTML = '<p style="color:#999; text-align:center; padding:20px;">暂无同学预约记录</p>';
            pendingPanel.style.display = 'none'; cancelPanel.style.display = 'none'; return; 
        }

        let pendingHtml = "";
        let cancelRequestHtml = "";
        const resGroups = {};

        Object.keys(res).forEach(resKey => {
            const r = res[resKey];
            if (!r) return;
            reservationsData.push(r); 

            let currentStatus = r.status || "Confirmed"; 

            if (currentStatus === "Pending") {
                pendingHtml += `
                    <div class="approval-item">
                        <span>👤 <b>${r.nickname}</b> 申请时段：<b style="color:#409eff;">${r.time}</b></span>
                        <div class="approval-btns">
                            <button style="background:#67c23a;" onclick="approveBooking('${resKey}', true)">确认预约</button>
                            <button style="background:#ff4d4f;" onclick="approveBooking('${resKey}', false)">拒绝预约</button>
                        </div>
                    </div>
                `;
            }

            if (currentStatus === "PendingCancel") {
                cancelRequestHtml += `
                    <div class="approval-item">
                        <span>👤 <b>${r.nickname}</b> 申请退课：<b style="color:#f56c6c;">${r.time}</b></span>
                        <div class="approval-btns">
                            <button style="background:#e6a23c;" onclick="approveCancelRequest('${resKey}')">同意取消</button>
                        </div>
                    </div>
                `;
            }
            
            let submitDateStr = "历史记录";
            if (r.timestamp) {
                const parsedDate = new Date(r.timestamp);
                if (!isNaN(parsedDate.getTime())) submitDateStr = parsedDate.toLocaleDateString();
            }
            if (!resGroups[submitDateStr]) resGroups[submitDateStr] = [];
            resGroups[submitDateStr].push({ key: resKey, data: r });
        });

        if (pendingHtml) { pendingList.innerHTML = pendingHtml; pendingPanel.style.display = 'block'; } 
        else { pendingList.innerHTML = '<p style="color: #999; font-size: 13px;">暂无待确认的排班申请。</p>'; pendingPanel.style.display = 'none'; }

        if (cancelRequestHtml) { cancelList.innerHTML = cancelRequestHtml; cancelPanel.style.display = 'block'; } 
        else { cancelList.innerHTML = '<p style="color: #999; font-size: 13px;">暂无学生发起的取消申请。</p>'; cancelPanel.style.display = 'none'; }

        Object.keys(resGroups).sort().reverse().forEach(submitDate => { 
            const resGroupDiv = document.createElement('div');
            resGroupDiv.className = 'date-group res-group';
            if (resCollapseState[submitDate] === undefined) resCollapseState[submitDate] = true;

            const header = document.createElement('div');
            header.className = 'date-header res-header';
            header.innerHTML = `<span>📝 ${submitDate} 约课台账 (${resGroups[submitDate].length} 条)</span> <span class="arrow-indicator">${resCollapseState[submitDate] ? '展开 ➕' : '收起 ➖'}</span>`;
            const body = document.createElement('div');
            body.className = `date-body ${resCollapseState[submitDate] ? 'collapsed' : ''}`;
            body.style.overflowX = 'auto';

            header.onclick = () => {
                resCollapseState[submitDate] = !resCollapseState[submitDate];
                body.classList.toggle('collapsed');
                header.querySelector('.arrow-indicator').textContent = resCollapseState[submitDate] ? '展开 ➕' : '收起 ➖';
            };

            const table = document.createElement('table');
            table.innerHTML = `<thead><tr><th>时段</th><th>姓名</th><th>状态</th><th>验证凭证</th><th>操作</th></tr></thead><tbody></tbody>`;
            const tbody = table.querySelector('tbody');

            resGroups[submitDate].forEach(item => {
                const r = item.data; const tr = document.createElement('tr');
                let displayTimeText = r.time || "未知时间段";
                let rawStatus = r.status || "Confirmed";
                let statusText = "";

                switch(rawStatus) {
                    case "Pending": statusText = "<span style='color:#e6a23c;'>待确认</span>"; break;
                    case "Confirmed": statusText = "<span style='color:#409eff;'>已确认</span>"; break;
                    case "PendingCancel": statusText = "<span style='color:#f56c6c;'>学生申请取消</span>"; break;
                    case "Canceled": statusText = "<span style='color:#909399;'>已取消</span>"; break;
                    case "Completed": statusText = "<span style='color:#67c23a;'>已完成</span>"; break;
                }

                tr.innerHTML = `<td>${displayTimeText}</td><td><b>${r.nickname || "匿名"}</b></td><td>${statusText}</td><td>${r.cancelCode || '无'}</td>
                    <td><button class="danger" style="padding:4px 8px; font-size:12px;" onclick="deleteSingleReservation('${item.key}', '${r.slotId}', '${r.nickname || "未知"}')">强制删除单据</button></td>`;
                tbody.appendChild(tr);
            });
            body.appendChild(table); resGroupDiv.appendChild(header); resGroupDiv.appendChild(body); container.appendChild(resGroupDiv);
        });
    });
}

function approveBooking(resKey, isApprove) {
    db.ref(`reservations/${resKey}`).once('value').then(snapshot => {
        const r = snapshot.val(); if (!r) return;
        const updates = {};
        if (isApprove) {
            updates[`reservations/${resKey}/status`] = "Confirmed";
            db.ref().update(updates).then(() => alert('该约课单已确认成功！'));
        } else {
            updates[`reservations/${resKey}/status`] = "Canceled";
            updates[`slots/${r.slotId}/reserved`] = false;
            db.ref().update(updates).then(() => alert('已拒绝该申请。'));
        }
    });
}

function approveCancelRequest(resKey) {
    db.ref(`reservations/${resKey}`).once('value').then(snapshot => {
        const r = snapshot.val(); if (!r) return;

        db.ref('slots/' + r.slotId).once('value').then(slotSnapshot => {
            const slot = slotSnapshot.val();
            const updates = {};
            updates[`reservations/${resKey}/status`] = "Canceled";

            if (!slot || slot.status === "hidden") {
                updates[`slots/${r.slotId}`] = null;
            } else {
                updates[`slots/${r.slotId}/reserved`] = false;
            }

            db.ref().update(updates).then(() => {
                alert('已同意退课取消申请！');
            });
        });
    });
}

function cancelEditSlot(slotId) {
    db.ref('slots/' + slotId).once('value').then(snapshot => {
        const slot = snapshot.val(); if (!slot) return;
        const row = document.getElementById(`slot-row-${slotId}`);
        row.innerHTML = `
            <span class="slot-text-span">${slot.time} ${slot.reserved ? '<strong style="color:red">(已约)</strong>' : '<strong style="color:green">(空闲)</strong>'}</span>
            <div class="btn-group">
                <button style="background:#67c23a; width:auto; padding:8px 12px; font-size:14px;" onclick="startEditSlot('${slotId}', '${slot.time}')">修改</button>
                <button class="danger" onclick="deleteSlot('${slotId}')">删除</button>
            </div>
        `;
    });
}

function startEditSlot(slotId, currentTime) {
    const row = document.getElementById(`slot-row-${slotId}`);
    row.innerHTML = `
        <input type="text" class="edit-input" id="edit-input-${slotId}" value="${currentTime}">
        <div class="btn-group">
            <button style="background:#409eff; width:auto; padding:8px 12px; font-size:14px;" onclick="saveEditedSlot('${slotId}')">保存</button>
            <button style="background:#909399; width:auto; padding:8px 12px; font-size:14px;" onclick="cancelEditSlot('${slotId}')">取消</button>
        </div>
    `;
}

function saveEditedSlot(slotId) {
    const newTime = document.getElementById(`edit-input-${slotId}`).value.trim();
    const dateMatch = newTime.match(/^(\d{1,2})\/(\d{1,2})/);
    if (!dateMatch) return alert('❌ 格式不正确！必须以“月/日”格式开头');
    const month = parseInt(dateMatch[1], 10); const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) return alert(`❌ 修改失败：日历中不存在 ${month}月${day}日！`);

    db.ref('slots/' + slotId).update({ time: newTime }).then(() => {
        db.ref('reservations').once('value').then((snapshot) => {
            const res = snapshot.val(); const updates = {};
            if (res) {
                Object.keys(res).forEach(resKey => {
                    if (res[resKey].slotId === slotId) updates[`reservations/${resKey}/time`] = newTime;
                });
            }
            db.ref().update(updates).then(() => alert('时间段文字修改成功，已自动同步预约单！'));
        });
    });
}

function setNotice() {
    const noticeInputEl = document.getElementById('notice-input'); const noticeText = noticeInputEl.value;
    const fileInput = document.getElementById('notice-image-input'); const file = fileInput.files[0];

    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas'); let width = img.width; let height = img.height;
                const MAX_WIDTH = 600; if (width > MAX_WIDTH) { height = Math.round((height * MAX_WIDTH) / width); width = MAX_WIDTH; }
                canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.6);
                db.ref('settings/notice').set(noticeText).then(() => {
                    db.ref('settings/noticeImage').set(compressedBase64).then(() => { fileInput.value = ''; alert('公告及附加图片更新成功！'); });
                });
            }; img.src = e.target.result;
        }; reader.readAsDataURL(file);
    } else {
        db.ref('settings/notice').set(noticeText).then(() => alert('公告文本更新成功！'));
    }
}

function removeCurrentNoticeImage() {
    if (confirm('确定要清除当前的公告图片吗？（只保留文字）')) {
        db.ref('settings/noticeImage').remove().then(() => alert('当前公告图片已成功移除！'));
    }
}

function addSlot() {
    const timeInput = document.getElementById('new-slot-time'); const time = timeInput.value.trim();
    const dateMatch = time.match(/^(\d{1,2})\/(\d{1,2})/); if (!dateMatch) return alert('❌ 格式不正确！必须以“月/日”格式开头，例如: "6/19 0800-1015"');
    const month = parseInt(dateMatch[1], 10); const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) return alert(`❌ 添加失败：公历中不存在 ${month}月${day}日！`);
    db.ref('slots').push({ time: time, reserved: false, status: "active" }).then(() => { timeInput.value = ''; });
}

function generateDayTemplate() {
    const dateInput = document.getElementById('template-date').value; if (!dateInput) return alert('请先选择需要批量排班的日期！');
    const dateObj = new Date(dateInput); const prefix = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
    const templates = []; for (let i = 1; i <= 5; i++) { const val = document.getElementById(`tpl-time-${i}`).value.trim(); if (val) templates.push(val); }
    if (templates.length === 0) return alert('请至少填写一个时间段！');

    if (confirm(`确定要一键生成 ${prefix} 的这 ${templates.length} 个自定义辅导时间段吗？`)) {
        const updates = {};
        templates.forEach(t => {
            const newKey = db.ref().child('slots').push().key;
            updates[`slots/${newKey}`] = { time: `${prefix} ${t}`, reserved: false, status: "active" };
        });
        db.ref().update(updates).then(() => { document.getElementById('template-date').value = ""; alert('⚡ 排班模板已成功部署！'); });
    }
}

function deleteSlot(slotId) {
    if (confirm('确定要移除这个时间段吗？（有学生预约的单据会完好留存在下方列表中以供对账）')) {
        db.ref('slots/' + slotId).once('value').then(snapshot => {
            const slot = snapshot.val();
            if (slot && slot.reserved) {
                db.ref('slots/' + slotId).update({ status: "hidden" }).then(() => alert('该时段已从学生页面安全隐藏，其历史预约单据已为您稳固保存！'));
            } else {
                db.ref('slots/' + slotId).remove().then(() => alert('该空闲时段已彻底安全移除！'));
            }
        });
    }
}

function deleteSingleReservation(resKey, slotId, nickname) {
    if (confirm(`确定要直接从台账花名册强行删除学生 [${nickname}] 的这条记录吗？`)) {
        db.ref('slots/' + slotId).once('value').then(slotSnap => {
            const slot = slotSnap.val(); const updates = {};
            updates[`reservations/${resKey}`] = null;
            if (!slot || slot.status === "hidden") updates[`slots/${slotId}`] = null;
            else updates[`slots/${slotId}/reserved`] = false;

            db.ref().update(updates).then(() => alert(`已从后台花名册中彻底删除 [${nickname}] 的单据记录。`));
        });
    }
}

function setDeadline() {
    const deadline = document.getElementById('deadline-input').value; if (!deadline) return alert('请选择时间！');
    db.ref('settings').update({ deadline: deadline }).then(() => alert('截止时间已成功保存！'));
}

function setCode() {
    const code = document.getElementById('code-input').value.trim(); if (!code) return alert('口令不能为空！');
    db.ref('settings').update({ accessCode: code }).then(() => alert('预约口令已更新！'));
}

function exportCSV() {
    if (reservationsData.length === 0) return alert('当前无数据可导出');
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF预约时间,姓名,凭证码,精确提交时间\n";
    reservationsData.forEach(r => {
        csvContent += `${r.time},${r.nickname},${r.cancelCode || '无'},${new Date(r.timestamp).toLocaleString()}\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a"); link.setAttribute("href", encodedUri); link.setAttribute("download", "课程预约花名册.csv");
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

function clearData() {
    if (confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？')) {
        const updates = { slots: null, reservations: null };
        db.ref().update(updates).then(() => alert('云端数据已彻底擦除！'));
    }
}
