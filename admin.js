// admin.js

// 🔑 1. V2.1 动态云端密码验证
function verifyAdmin() {
    const inputPass = document.getElementById('admin-password').value.trim();
    const errorEl = document.getElementById('login-error');
    
    if (!inputPass) return alert('请输入密码！');

    // 关键升级：尝试用输入的密码当做令牌去读取云端
    // 只有在下一步的 Firebase 规则配置正确时，这里才会生效
    db.ref('settings').once('value').then((snapshot) => {
        // 如果能成功读取到设置，说明密码是对的（因为规则放行了）
        document.getElementById('admin-login').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        initAdminSystem();
    }).catch((error) => {
        // 如果密码错误，云端拒绝读取，就会走到这里
        errorEl.textContent = '密码验证失败，拒绝访问！';
    });
}

// 监听密码框回车键
document.getElementById('admin-password').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') verifyAdmin();
});

// 🛠️ 2. 系统核心初始化（只有验证成功才会调用）
function initAdminSystem() {
    // 监听并显示时间段
    db.ref('slots').on('value', (snapshot) => {
        const slots = snapshot.val();
        const container = document.getElementById('admin-slots-container');
        container.innerHTML = '';
        
        if (slots) {
            Object.keys(slots).forEach(slotId => {
                const slot = slots[slotId];
                const div = document.createElement('div');
                div.className = 'slot-item';
                div.innerHTML = `
                    <span>${slot.time} ${slot.reserved ? '<strong style="color:red">(已约)</strong>' : '<strong style="color:green">(空闲)</strong>'}</span>
                    <button class="danger" onclick="deleteSlot('${slotId}')">删除排班</button>
                `;
                container.appendChild(div);
            });
        } else {
            container.innerHTML = '<p>暂无排班时间段。</p>';
        }
    });

    // 监听与设置截止时间
    db.ref('settings/deadline').on('value', (snapshot) => {
        if (snapshot.val()) {
            document.getElementById('deadline-input').value = snapshot.val();
        }
    });

    // 监听与设置口令
    db.ref('settings/accessCode').on('value', (snapshot) => {
        if (snapshot.val()) {
            document.getElementById('code-input').value = snapshot.val();
        }
    });

    // 监听并显示预约名单
    db.ref('reservations').on('value', (snapshot) => {
        const res = snapshot.val();
        const tbody = document.getElementById('reservations-body');
        tbody.innerHTML = '';
        reservationsData = [];
        
        if (res) {
            Object.keys(res).forEach(resKey => {
                const r = res[resKey];
                reservationsData.push(r); 
                
                const tr = document.createElement('tr');
                const date = new Date(r.timestamp).toLocaleString();
                tr.innerHTML = `
                    <td>${r.time}</td>
                    <td><b>${r.nickname}</b></td>
                    <td>${date}</td>
                    <td>
                        <button class="danger" style="padding:4px 8px; font-size:12px;" onclick="deleteSingleReservation('${resKey}', '${r.slotId}', '${r.nickname}')">取消该预约</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#999;">暂无同学预约</td></tr>';
        }
    });
}

// 🕒 3. 添加时间段
function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    if (!time) return alert('请输入时间格式！');
    db.ref('slots').push({ time: time, reserved: false });
    timeInput.value = '';
}

// 🗑️ 4. 删除整个时间段排班
function deleteSlot(slotId) {
    if (confirm('确定要彻底删除这个时间段排班吗？')) {
        db.ref('slots/' + slotId).remove();
    }
}

// ⏳ 5. 设置截止时间
function setDeadline() {
    const deadline = document.getElementById('deadline-input').value;
    if (!deadline) return alert('请选择时间！');
    db.ref('settings/deadline').set(deadline);
    alert('截止时间已保存！');
}

// 🔑 6. 设置口令
function setCode() {
    const newCode = document.getElementById('code-input').value.trim();
    if (!newCode) return alert('口令不能为空！');
    db.ref('settings/accessCode').set(newCode);
    alert('预约口令已更新！');
}

// ❌ 7. 单次切除单条学生预约
function deleteSingleReservation(resKey, slotId, nickname) {
    if (confirm(`确定要取消学生 [${nickname}] 的这条预约吗？`)) {
        db.ref('slots/' + slotId + '/reserved').set(false).then(() => {
            db.ref('reservations/' + resKey).remove().then(() => {
                alert(`已成功取消 [${nickname}] 的预约，名额已释放！`);
            });
        });
    }
}

// 📊 8. 导出 CSV
let reservationsData = [];
function exportCSV() {
    if (reservationsData.length === 0) return alert('当前无数据可导出');
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF预约时间,昵称,提交时间\n";
    reservationsData.forEach(r => {
        const date = new Date(r.timestamp).toLocaleString();
        csvContent += `${r.time},${r.nickname},${date}\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "预约名单.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ⚠️ 9. 清空所有数据
function clearData() {
    if (confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？')) {
        db.ref('slots').remove();
        db.ref('reservations').remove();
        alert('数据已清空！');
    }
}
