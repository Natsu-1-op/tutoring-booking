// admin.js

let MASTER_PASSWORD = ""; // 动态存储管理员输入的密码作为暗道钥匙
let initialized = false; 
let dateCollapseState = {};
let resCollapseState = {}; 
let reservationsData = []; 

// 🔑 1. 探测路径登录
function verifyAdmin() {
    const inputPass = document.getElementById('admin-password').value.trim();
    const errorEl = document.getElementById('login-error');
    if (!inputPass) return alert('请输入密码！');

    // 探测 admin_auth/密码 路径是否放行
    db.ref(`admin_auth/${inputPass}`).once('value').then((snapshot) => {
        if (snapshot.exists() && snapshot.val() === true) {
            MASTER_PASSWORD = inputPass; // 锁死本次操作的暗道钥匙
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

// 🛠️ 2. 初始化系统监听
function initAdminSystem() {
    if (initialized) return;
    initialized = true;

    // 🕒 监听并按 mm/dd 进行高级折叠渲染（默认已折叠）
    db.ref('slots').on('value', (snapshot) => {
        const slots = snapshot.val();
        const container = document.getElementById('admin-slots-container');
        container.innerHTML = '';
        if (!slots) { container.innerHTML = '<p>暂无排班时间段。</p>'; return; }

        const groups = {};
        Object.keys(slots).forEach(slotId => {
            const slot = slots[slotId];
            const match = slot.time.match(/^(\d{1,2}\/\d{1,2})/);
            const dateKey = match ? match[1] : "其他日期格式";
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push({ id: slotId, data: slot });
        });

        // 📅 智能排序：按真实日期时间轴线性排列，跨月跨年不乱序
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

    // 📋 监听预约情况
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

// 🛠️ 原子级多路径更新修改时间
function saveEditedSlot(slotId) {
    const newTime = document.getElementById(`edit-input-${slotId}`).value.trim();
    if (!/^\d{1,2}\/\d{1,2}/.test(newTime)) return alert('❌ 格式不正确！必须以“月/日”格式开头');

    db.ref('reservations').once('value').then((snapshot) => {
        const res = snapshot.val();
        const updates = {};
        // 🌟 核心：穿透进对应密码路径里的独立 slots/reservations 子节点，完成原子更新
        updates[`admin_actions/${MASTER_PASSWORD}/slots/${slotId}/time`] = newTime;
        if (res) {
            Object.keys(res).forEach(resKey => {
                if (res[resKey].slotId === slotId) {
                    updates[`admin_actions/${MASTER_PASSWORD}/reservations/${resKey}/time`] = newTime;
                }
            });
        }
        
        db.ref().update(updates).then(() => {
            alert('时间段修改成功，云端已原子级同步完成！');
        }).catch(() => alert('无权操作！'));
    });
}

// 🛠️ 原子级多路径删除排班与预约单
function deleteSlot(slotId) {
    if (!confirm('确定要彻底删除这个时间段排班吗？（对应的学生预约单也会一并原子删除）')) return;
    db.ref('reservations').once('value').then((snapshot) => {
        const res = snapshot.val();
        const updates = {};
        updates[`admin_actions/${MASTER_PASSWORD}/slots/${slotId}`] = null; 
        if (res) {
            Object.keys(res).forEach(resKey => {
                if (res[resKey].slotId === slotId) updates[`admin_actions/${MASTER_PASSWORD}/reservations/${resKey}`] = null;
            });
        }
        db.ref().update(updates).then(() => {
            alert('该排班及时单数据已原子级一并安全清除！');
        }).catch(() => alert('操作失败，权限不足！'));
    });
}

function setNotice() {
    const txt = document.getElementById('notice-input').value;
    const updates = {};
    updates[`admin_actions/${MASTER_PASSWORD}/settings/notice`] = txt;
    db.ref().update(updates).then(() => alert('公告更新成功！')).catch(() => alert('权限错误！'));
}

function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    if (!/^\d{1,2}\/\d{1,2}/.test(time)) return alert('❌ 格式不正确！必须以“月/日”格式开头');
    
    const newKey = db.ref().child('slots').push().key;
    const updates = {};
    updates[`admin_actions/${MASTER_PASSWORD}/slots/${newKey}`] = { time: time, reserved: false };
    
    db.ref().update(updates).then(() => {
        timeInput.value = '';
    }).catch(() => alert('权限错误！'));
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
        updates[`admin_actions/${MASTER_PASSWORD}/slots/${newKey}`] = { time: `${prefix} ${t}`, reserved: false };
    });

    db.ref().update(updates).then(() => {
        document.getElementById('template-date').value = "";
        alert('⚡ 批量排班已原子级无缝部署！');
    }).catch(() => alert('权限错误！'));
}

function setDeadline() {
    const dl = document.getElementById('deadline-input').value;
    if (!dl) return alert('请选择时间！');
    const updates = {};
    updates[`admin_actions/${MASTER_PASSWORD}/settings/deadline`] = dl;
    db.ref().update(updates).then(() => alert('截止时间已保存！')).catch(() => alert('权限错误！'));
}

function setCode() {
    const code = document.getElementById('code-input').value.trim();
    if (!code) return alert('口令不能为空！');
    const updates = {};
    updates[`admin_actions/${MASTER_PASSWORD}/settings/accessCode`] = code;
    db.ref().update(updates).then(() => alert('预约口令已更新！')).catch(() => alert('权限错误！'));
}

function deleteSingleReservation(resKey, slotId, nickname) {
    if (!confirm(`确定要取消学生 [${nickname}] 的这条预约吗？`)) return;
    const updates = {};
    updates[`admin_actions/${MASTER_PASSWORD}/slots/${slotId}/reserved`] = false;
    updates[`admin_actions/${MASTER_PASSWORD}/reservations/${resKey}`] = null;

    db.ref().update(updates).then(() => {
        alert(`已成功原子级取消 [${nickname}] 的预约，名额已释放！`);
    }).catch(() => alert('权限错误！'));
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
    const updates = {};
    updates[`admin_actions/${MASTER_PASSWORD}/slots`] = null;
    updates[`admin_actions/${MASTER_PASSWORD}/reservations`] = null;
    db.ref().update(updates).then(() => {
        alert('云端数据已彻底原子级擦除！');
    }).catch(() => alert('权限错误！'));
}
