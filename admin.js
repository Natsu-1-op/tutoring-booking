// admin.js

function verifyAdmin() {
    const inputPass = document.getElementById('admin-password').value.trim();
    const errorEl = document.getElementById('login-error');
    if (!inputPass) return alert('请输入密码！');

    db.ref('settings').once('value').then((snapshot) => {
        document.getElementById('admin-login').style.display = 'none';
        document.getElementById('admin-content').style.display = 'block';
        initAdminSystem();
    }).catch((error) => {
        errorEl.textContent = '密码验证失败，拒绝访问！';
    });
}

document.getElementById('admin-password').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') verifyAdmin();
});

let dateCollapseState = {};

function initAdminSystem() {
    // 监听并按 mm/dd 进行高级折叠渲染
    db.ref('slots').on('value', (snapshot) => {
        const slots = snapshot.val();
        const container = document.getElementById('admin-slots-container');
        container.innerHTML = '';
        
        if (!slots) {
            container.innerHTML = '<p>暂无排班时间段。</p>';
            return;
        }

        const groups = {};
        Object.keys(slots).forEach(slotId => {
            const slot = slots[slotId];
            const match = slot.time.match(/^(\d{1,2}\/\d{1,2})/);
            const dateKey = match ? match[1] : "其他日期格式";
            
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push({ id: slotId, data: slot });
        });

        Object.keys(groups).sort().forEach(dateKey => {
            const dateGroupDiv = document.createElement('div');
            dateGroupDiv.className = 'date-group';

            if (dateCollapseState[dateKey] === undefined) {
                dateCollapseState[dateKey] = false; 
            }

            const header = document.createElement('div');
            header.className = 'date-header';
            header.innerHTML = `<span>📅 ${dateKey} 排班列表</span> <span>${dateCollapseState[dateKey] ? '展开 ➕' : '收起 ➖'}</span>`;
            
            const body = document.createElement('div');
            body.className = `date-body ${dateCollapseState[dateKey] ? 'collapsed' : ''}`;

            header.onclick = () => {
                dateCollapseState[dateKey] = !dateCollapseState[dateKey];
                body.classList.toggle('collapsed');
                header.querySelector('span:last-child').textContent = dateCollapseState[dateKey] ? '展开 ➕' : '收起 ➖';
            };

            groups[dateKey].forEach(item => {
                const slotDiv = document.createElement('div');
                slotDiv.className = 'slot-item';
                slotDiv.innerHTML = `
                    <span>${item.data.time} ${item.data.reserved ? '<strong style="color:red">(已约)</strong>' : '<strong style="color:green">(空闲)</strong>'}</span>
                    <button class="danger" onclick="deleteSlot('${item.id}')">删除排班</button>
                `;
                body.appendChild(slotDiv);
            });

            dateGroupDiv.appendChild(header);
            dateGroupDiv.appendChild(body);
            container.appendChild(dateGroupDiv);
        });
    });

    // 📢 新增：监听公告内容并填入后台输入框
    db.ref('settings/notice').on('value', (snapshot) => {
        if (snapshot.val() !== null) {
            document.getElementById('notice-input').value = snapshot.val();
        }
    });

    // 监听与设置截止时间
    db.ref('settings/deadline').on('value', (snapshot) => {
        if (snapshot.val()) document.getElementById('deadline-input').value = snapshot.val();
    });

    // 监听与设置口令
    db.ref('settings/accessCode').on('value', (snapshot) => {
        if (snapshot.val()) document.getElementById('code-input').value = snapshot.val();
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

// 📢 新增：发布/更新公告函数
function setNotice() {
    const noticeText = document.getElementById('notice-input').value;
    db.ref('settings/notice').set(noticeText).then(() => {
        alert('公告更新成功！同学端已实时同步。');
    });
}

function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    const datePattern = /^\d{1,2}\/\d{1,2}/;
    if (!datePattern.test(time)) {
        return alert('❌ 格式不正确！必须以“月/日”格式开头，例如: "6/19 14:00-15:00"');
    }
    db.ref('slots').push({ time: time, reserved: false });
    timeInput.value = '';
}

function generateDayTemplate() {
    const dateInput = document.getElementById('template-date').value;
    if (!dateInput) return alert('请先选择需要批量排班的日期！');

    const dateObj = new Date(dateInput);
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();
    const prefix = `${month}/${day}`;

    const templates = [
        "0800-1015",
        "1030-1245",
        "1330-1545",
        "1600-1815",
        "1930-2145"
    ];

    if (confirm(`确定要一键生成 ${prefix} 的这 ${templates.length} 个标准辅导时间段吗？`)) {
        templates.forEach(t => {
            db.ref('slots').push({
                time: `${prefix} ${t}`,
                reserved: false
            });
        });
        alert(`⚡ ${prefix} 的排班模板已一键部署成功！`);
    }
}

function deleteSlot(slotId) {
    if (confirm('确定要彻底删除这个时间段排班吗？')) {
        db.ref('slots/' + slotId).remove();
    }
}

function setDeadline() {
    const deadline = document.getElementById('deadline-input').value;
    if (!deadline) return alert('请选择时间！');
    db.ref('settings/deadline').set(deadline);
    alert('截止时间已保存！');
}

function setCode() {
    const newCode = document.getElementById('code-input').value.trim();
    if (!newCode) return alert('口令不能为空！');
    db.ref('settings/accessCode').set(newCode);
    alert('预约口令已更新！');
}

function deleteSingleReservation(resKey, slotId, nickname) {
    if (confirm(`确定要取消学生 [${nickname}] 的这条预约吗？`)) {
        db.ref('slots/' + slotId + '/reserved').set(false).then(() => {
            db.ref('reservations/' + resKey).remove().then(() => {
                alert(`已成功取消 [${nickname}] 的预约，名额已释放！`);
            });
        });
    }
}

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

function clearData() {
    if (confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？')) {
        db.ref('slots').remove();
        db.ref('reservations').remove();
        alert('数据已清空！');
    }
}
