// admin.js

let initialized = false; 
let dateCollapseState = {};
let resCollapseState = {}; 
let reservationsData = []; 
let currentCloudImageBase64 = ""; // 临时缓存云端当前的图片数据

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

    // 📢 1. 实时监听文字公告（百分之百在编辑框完美留存，绝不被清空）
    db.ref('settings/notice').on('value', (snapshot) => {
        if (snapshot.val() !== null) {
            document.getElementById('notice-input').value = snapshot.val();
        }
    });

    // 📢 2. 实时监听图片公告并在后台生成独立预览，允许管理员随时查看或删除
    db.ref('settings/noticeImage').on('value', (snapshot) => {
        const previewContainer = document.getElementById('admin-img-preview-container');
        const previewImg = document.getElementById('admin-img-preview');
        if (snapshot.val()) {
            currentCloudImageBase64 = snapshot.val();
            previewImg.src = currentCloudImageBase64;
            previewContainer.style.display = 'block';
        } else {
            currentCloudImageBase64 = "";
            previewImg.src = "";
            previewContainer.style.display = 'none';
        }
    });

    db.ref('settings/deadline').on('value', (snapshot) => { if (snapshot.val()) document.getElementById('deadline-input').value = snapshot.val(); });
    db.ref('settings/accessCode').on('value', (snapshot) => { if (snapshot.val()) document.getElementById('code-input').value = snapshot.val(); });

    db.ref('reservations').on('value', (snapshot) => {
        const res = snapshot.val();
        const container = document.getElementById('admin-reservations-container');
        container.innerHTML = ''; reservationsData = [];
        if (!res) { container.innerHTML = '<p style="color:#999; text-align:center; padding:20px;">暂无同学预约记录</p>'; return; }

        const resGroups = {};
        Object.keys(res).forEach(resKey => {
            const r = res[resKey]; reservationsData.push(r); 
            const submitDateStr = new Date(r.timestamp).toLocaleDateString();
            if (!resGroups[submitDateStr]) resGroups[submitDateStr] = [];
            resGroups[submitDateStr].push({ key: resKey, data: r });
        });

        Object.keys(resGroups).sort().reverse().forEach(submitDate => { 
            const resGroupDiv = document.createElement('div');
            resGroupDiv.className = 'date-group res-group';
            if (resCollapseState[submitDate] === undefined) resCollapseState[submitDate] = true;

            const header = document.createElement('div');
            header.className = 'date-header res-header';
            header.innerHTML = `<span>📝 ${submitDate} 提交的预约 (${resGroups[submitDate].length} 条记录)</span> <span class="arrow-indicator">${resCollapseState[submitDate] ? '展开 ➕' : '收起 ➖'}</span>`;
            const body = document.createElement('div');
            body.className = `date-body ${resCollapseState[submitDate] ? 'collapsed' : ''}`;
            body.style.overflowX = 'auto';

            header.onclick = () => {
                resCollapseState[submitDate] = !resCollapseState[submitDate];
                body.classList.toggle('collapsed');
                header.querySelector('.arrow-indicator').textContent = resCollapseState[submitDate] ? '展开 ➕' : '收起 ➖';
            };

            const table = document.createElement('table');
            table.innerHTML = `<thead><tr><th>时段</th><th>姓名</th><th>专属取消码</th><th>精确提交时间</th><th>操作</th></tr></thead><tbody></tbody>`;
            const tbody = table.querySelector('tbody');

            resGroups[submitDate].forEach(item => {
                const r = item.data;
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${r.time}</td><td><b>${r.nickname}</b></td><td style="color:#e6a23c; font-weight:bold;">${r.cancelCode || '无'}</td><td>${new Date(r.timestamp).toLocaleTimeString()}</td>
                    <td><button class="danger" style="padding:4px 8px; font-size:12px;" onclick="deleteSingleReservation('${item.key}', '${r.slotId}', '${r.nickname}')">取消该预约</button></td>`;
                tbody.appendChild(tr);
            });
            body.appendChild(table); resGroupDiv.appendChild(header); resGroupDiv.appendChild(body); container.appendChild(resGroupDiv);
        });
    });
}

// 🌟 核心更新：发布/更新公告（完美支持：文字留存、图片覆盖或无缝继续留存）
function setNotice() {
    const noticeText = document.getElementById('notice-input').value;
    const fileInput = document.getElementById('notice-image-input');
    const file = fileInput.files[0];

    // 分支 1：管理员选择了全新的本地图片，执行等比例调幅及画质压缩
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                let width = img.width; let height = img.height;
                const MAX_WIDTH = 600; // 限制画幅最大宽度为 600px
                if (width > MAX_WIDTH) {
                    height = Math.round((height * MAX_WIDTH) / width);
                    width = MAX_WIDTH;
                }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.6); // 降低质量系数到 0.6 压缩体积

                // 分开安全独立存储，文字留存，图片上传
                db.ref('settings/notice').set(noticeText).then(() => {
                    db.ref('settings/noticeImage').set(compressedBase64).then(() => {
                        fileInput.value = ''; 
                        alert('公告文字与新附加图片发布成功！文本已原地留存。');
                    });
                });
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    } else {
        // 分支 2：没选新图片。文字正常更新，原图在云端稳固继续留存
        db.ref('settings/notice').set(noticeText).then(() => {
            alert('公告文本更新成功！上一次的内容已完美留存。');
        });
    }
}

// 🌟 新增功能：允许管理员随时在后台单触一键“摘除并消灭图片缓存”
function removeCurrentNoticeImage() {
    if (confirm('确定要清除当前的公告图片吗？（只保留文字）')) {
        db.ref('settings/noticeImage').remove().then(() => {
            alert('当前公告图片已成功移除！');
        });
    }
}

function saveEditedSlot(slotId) {
    const newTime = document.getElementById(`edit-input-${slotId}`).value.trim();
    const dateMatch = newTime.match(/^(\d{1,2})\/(\d{1,2})/);
    if (!dateMatch) return alert('❌ 格式不正确！必须以“月/日”格式开头，如 "6/19 14:00-15:00"');
    const month = parseInt(dateMatch[1], 10); const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) return alert(`❌ 修改失败：日历中不存在 ${month}月${day}日！请重新核对。`);

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

function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    const dateMatch = time.match(/^(\d{1,2})\/(\d{1,2})/);
    if (!dateMatch) return alert('❌ 格式不正确！必须以“月/日”格式开头，例如: "6/19 0800-1015"');
    const month = parseInt(dateMatch[1], 10); const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) return alert(`❌ 添加失败：公历中不存在 ${month}月${day}日！`);

    db.ref('slots').push({ time: time, reserved: false }).then(() => { timeInput.value = ''; });
}

function generateDayTemplate() {
    const dateInput = document.getElementById('template-date').value;
    if (!dateInput) return alert('请先选择需要批量排班的日期！');
    const dateObj = new Date(dateInput);
    const prefix = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
    const templates = [];
    for (let i = 1; i <= 5; i++) { const val = document.getElementById(`tpl-time-${i}`).value.trim(); if (val) templates.push(val); }
    if (templates.length === 0) return alert('请至少填写一个时间段！');

    if (confirm(`确定要一键生成 ${prefix} 的这 ${templates.length} 个自定义辅导时间段吗？`)) {
        const updates = {};
        templates.forEach(t => {
            const newKey = db.ref().child('slots').push().key;
            updates[`slots/${newKey}`] = { time: `${prefix} ${t}`, reserved: false };
        });
        db.ref().update(updates).then(() => {
            document.getElementById('template-date').value = "";
            alert('⚡ 排班模板已成功部署！');
        });
    }
}

function deleteSlot(slotId) {
    if (confirm('确定要彻底删除这个时间段排班吗？（对应的学生预约单也会一并删除）')) {
        db.ref('slots/' + slotId).remove().then(() => {
            db.ref('reservations').once('value').then((snapshot) => {
                const res = snapshot.val(); const updates = {};
                if (res) {
                    Object.keys(res).forEach(resKey => {
                        if (res[resKey].slotId === slotId) updates[`reservations/${resKey}`] = null;
                    });
                }
                db.ref().update(updates).then(() => alert('该时段排班与关联的学生单据已一并同步清除！'));
            });
        });
    }
}

function setDeadline() { const dl = document.getElementById('deadline-input').value; if (!dl) return alert('请选择时间！'); db.ref('settings/deadline').set(dl).then(() => alert('截止时间已保存！')); }
function setCode() { const code = document.getElementById('code-input').value.trim(); if (!code) return alert('口令不能为空！'); db.ref('settings/accessCode').set(code).then(() => alert('预约口令已更新！')); }
function deleteSingleReservation(resKey, slotId, nickname) { if (confirm(`确定要取消学生 [${nickname}] 的这条预约吗？`)) { const updates = {}; updates[`slots/${slotId}/reserved`] = false; updates[`reservations/${resKey}`] = null; db.ref().update(updates).then(() => alert(`已成功取消 [${nickname}] 的预约，名额已释放！`)); } }
function clearData() { if (confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？')) { const updates = { slots: null, reservations: null }; db.ref().update(updates).then(() => alert('云端数据已彻底擦除！')); } }
