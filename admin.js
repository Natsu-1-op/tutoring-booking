// admin.js

let initialized = false; 
let dateCollapseState = {};
let resCollapseState = {}; 
let reservationsData = []; 

// 🔑 1. 直观的本地密码验证
function verifyAdmin() {
    const inputPass = document.getElementById('admin-password').value.trim();
    const errorEl = document.getElementById('login-error');
    if (!inputPass) return alert('请输入密码！');

    // 探测 admin_auth/密码 路径是否放行
    db.ref(`admin_auth/${inputPass}`).once('value').then((snapshot) => {
        if (snapshot.exists() && snapshot.val() === true) {
            document.getElementById('admin-login').style.display = 'none';
            document.getElementById('admin-content').style.display = 'block';
            initAdminSystem();
        } else {
            errorEl.textContent = '认证失败：密码错误，拒绝访问！';
        }
    }).catch((error) => {
        errorEl.textContent = '认证失败：密码错误或无管理权限！';
    });
}

document.getElementById('admin-password').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') verifyAdmin();
});

// 📅 辅助函数：严格验证真实世界日历的合法性（拦截 6/31, 2/30 等）
function isValidCalendarDate(month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const monthDaysMapping = {
        1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
        7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31
    };
    return day <= monthDaysMapping[month];
}

// 🛠️ 2. 初始化系统监听
function initAdminSystem() {
    if (initialized) return;
    initialized = true;

    // 🕒 监听并按 mm/dd 进行高级折叠渲染
    db.ref('slots').on('value', (snapshot) => {
        const slots = snapshot.val();
        const container = document.getElementById('admin-slots-container');
        container.innerHTML = '';
        if (!slots) { container.innerHTML = '<p>暂无排班时间段。</p>'; return; }

        const groups = {};
        Object.keys(slots).forEach(slotId => {
            const slot = slots[slotId];
            const match = slot.time.match(/^(\d{1,2})\/(\d{1,2})/);
            const dateKey = match ? `${match[1]}/${match[2]}` : "其他日期格式";
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push({ id: slotId, data: slot });
        });

        // 📅 智能排序：按真实日期线性升序排列
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
            header.innerHTML = `<span>📅 ${dateKey} 排班列表</span> <span class="arrow">${dateCollapseState[dateKey] ? '展开 ➕' : '收起 ➖'}</span>`;
            const body = document.createElement('div');
            body.className = `date-body ${dateCollapseState[dateKey] ? 'collapsed' : ''}`;

            header.onclick = () => {
                dateCollapseState[dateKey] = !dateCollapseState[dateKey];
                body.classList.toggle('collapsed');
                header.querySelector('.arrow').textContent = dateCollapseState[dateKey] ? '展开 ➕' : '收起 ➖';
            };

            groups[dateKey].forEach(item => {
                const slotDiv = document.createElement('div');
                slotDiv.className = 'slot-item';
                slotDiv.id = `slot-row-${item.id}`; 
                slotDiv.innerHTML = `
                    <span>${item.data.time} ${item.data.reserved ? '<strong style="color:red">(已约)</strong>' : '<strong style="color:green">(空闲)</strong>'}</span>
                    <div class="btn-group">
                        <button style="background:#67c23a; width:auto; padding:8px 12px; font-size:14px;" onclick="startEditSlot('${item.id}', '${item.data.time}')">修改</button>
                        <button class="danger" onclick="deleteSlot('${item.id}')">删除</button>
                    </div>
                `;
                body.appendChild(slotDiv);
            });
            dateGroupDiv.appendChild(header);
            dateGroupDiv.appendChild(body);
            container.appendChild(dateGroupDiv);
        });
    });

    db.ref('settings/notice').on('value', (snapshot) => { if (snapshot.val() !== null) document.getElementById('notice-input').value = snapshot.val(); });
    db.ref('settings/deadline').on('value', (snapshot) => { if (snapshot.val()) document.getElementById('deadline-input').value = snapshot.val(); });
    db.ref('settings/accessCode').on('value', (snapshot) => { if (snapshot.val()) document.getElementById('code-input').value = snapshot.val(); });

    // 📋 监听预约单名单
    db.ref('reservations').on('value', (snapshot) => {
        const res = snapshot.val();
        const container = document.getElementById('admin-reservations-container');
        container.innerHTML = '';
        reservationsData = [];
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
            header.innerHTML = `<span>📝 ${submitDate} 提交的预约 (${resGroups[submitDate].length}条记录)</span> <span class="arrow">${resCollapseState[submitDate] ? '展开 ➕' : '收起 ➖'}</span>`;
            const body = document.createElement('div');
            body.className = `date-body ${resCollapseState[submitDate] ? 'collapsed' : ''}`;

            const table = document.createElement('table');
            table.innerHTML = `<thead><tr><th>时段</th><th>姓名</th><th>专属取消码</th><th>提交时间</th><th>操作</th></tr></thead><tbody></tbody>`;
            const tbody = table.querySelector('tbody');

            resGroups[submitDate].forEach(item => {
                const r = item.data;
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${r.time}</td><td><b>${r.nickname}</b></td><td style="color:#e6a23c;font-weight:bold;">${r.cancelCode || '无'}</td><td>${new Date(r.timestamp).toLocaleTimeString()}</td>
                    <td><button class="danger" style="padding:4px 8px;font-size:12px;" onclick="deleteSingleReservation('${item.key}', '${r.slotId}', '${r.nickname}')">取消该预约</button></td>`;
                tbody.appendChild(tr);
            });
            body.appendChild(table); resGroupDiv.appendChild(header); resGroupDiv.appendChild(body); container.appendChild(resGroupDiv);
        });
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

function cancelEditSlot(slotId) {
    db.ref('slots/' + slotId).once('value').then(snapshot => {
        const slot = snapshot.val(); if (!slot) return;
        document.getElementById(`slot-row-${slotId}`).innerHTML = `
            <span>${slot.time} ${slot.reserved ? '<strong style="color:red">(已约)</strong>' : '<strong style="color:green">(空闲)</strong>'}</span>
            <div class="btn-group"><button style="background:#67c23a;width:auto;padding:8px 12px;font-size:14px;" onclick="startEditSlot('${slotId}', '${slot.time}')">修改</button><button class="danger" onclick="deleteSlot('${slotId}')">删除</button></div>`;
    });
}

// 🛠️ 专家级直达根目录修改
function saveEditedSlot(slotId) {
    const newTime = document.getElementById(`edit-input-${slotId}`).value.trim();
    const dateMatch = newTime.match(/^(\d{1,2})\/(\d{1,2})/);
    if (!dateMatch) return alert('❌ 格式不正确！必须以“月/日”格式开头');
    
    const month = parseInt(dateMatch[1], 10);
    const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) return alert(`❌ 修改失败：日历中不存在 ${month}月${day}日！`);

    db.ref('reservations').once('value').then((snapshot) => {
        const res = snapshot.val();
        const updates = {};
        // 🌟 直接投递到根目录下的相应位置
        updates[`slots/${slotId}/time`] = newTime;
        if (res) {
            Object.keys(res).forEach(resKey => {
                if (res[resKey].slotId === slotId) updates[`reservations/${resKey}/time`] = newTime;
            });
        }
        db.ref().update(updates).then(() => alert('时间段修改成功！'));
    });
}

// 🛠️ 专家级直达根目录删除
function deleteSlot(slotId) {
    if (!confirm('确定要彻底删除这个时间段排班吗？（对应的学生预约单也会一并删除）')) return;
    db.ref('reservations').once('value').then((snapshot) => {
        const res = snapshot.val();
        const updates = {};
        updates[`slots/${slotId}`] = null; 
        if (res) {
            Object.keys(res).forEach(resKey => {
                if (res[resKey].slotId === slotId) updates[`reservations/${resKey}`] = null;
            });
        }
        db.ref().update(updates).then(() => alert('排班及时单数据已安全清除！'));
    });
}

function setNotice() {
    const txt = document.getElementById('notice-input').value;
    db.ref('settings').update({ notice: txt }).then(() => alert('公告更新成功！'));
}

function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    const dateMatch = time.match(/^(\d{1,2})\/(\d{1,2})/);
    if (!dateMatch) return alert('❌ 格式不正确！必须以“月/日”格式开头，例如: "6/19 14:00-15:00"');
    
    const month = parseInt(dateMatch[1], 10);
    const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) return alert(`❌ 添加失败：真实日历中可没有 ${month}月${day}日！`);
    
    const newKey = db.ref().child('slots').push().key;
    const updates = {};
    // 🌟 修正关键：直投根目录 slots
    updates[`slots/${newKey}`] = { time: time, reserved: false };
    
    db.ref().update(updates).then(() => { timeInput.value = ''; });
}

function generateDayTemplate() {
    const dateInput = document.getElementById('template-date').value;
    if (!dateInput) return alert('请先选择日期！');
    const dateObj = new Date(dateInput);
    const prefix = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
    const times = ["0800-1015", "1030-1245", "1330-1545", "1600-1815", "1900-2115"];

    if (!confirm(`确定要一键原子级生成 ${prefix} 的排班吗？`)) return;
    const updates = {};
    times.forEach(t => {
        const newKey = db.ref().child('slots').push().key;
        updates[`slots/${newKey}`] = { time: `${prefix} ${t}`, reserved: false };
    });

    db.ref().update(updates).then(() => {
        document.getElementById('template-date').value = "";
        alert('⚡ 批量排班已部署成功！');
    });
}

function setDeadline() {
    const dl = document.getElementById('deadline-input').value;
    if (!dl) return alert('请选择时间！');
    db.ref('settings').update({ deadline: dl }).then(() => alert('截止时间已保存！'));
}

function setCode() {
    const code = document.getElementById('code-input').value.trim();
    if (!code) return alert('口令不能为空！');
    db.ref('settings').update({ accessCode: code }).then(() => alert('预约口令已更新！'));
}

function deleteSingleReservation(resKey, slotId, nickname) {
    if (!confirm(`确定要取消学生 [${nickname}] 的这条预约吗？`)) return;
    const updates = {};
    updates[`slots/${slotId}/reserved`] = false;
    updates[`reservations/${resKey}`] = null;
    db.ref().update(updates).then(() => alert(`已成功取消 [${nickname}] 的预约！`));
}

function exportCSV() {
    if (reservationsData.length === 0) return alert('当前无数据可导出');
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF预约时间,姓名,专属取消码,提交时间\n";
    reservationsData.forEach(r => {
        csvContent += `${r.time},${r.nickname},${r.cancelCode || '无'},${new Date(r.timestamp).toLocaleString()}\n`;
    });
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", "课程预约花名册.csv");
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

function clearData() {
    if (!confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？')) return;
    const updates = { slots: null, reservations: null };
    db.ref().update(updates).then(() => alert('云端数据已原子级擦除！'));
}
