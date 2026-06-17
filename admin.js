// admin.js

let initialized = false; 
let dateCollapseState = {};
let resCollapseState = {}; 
let reservationsData = []; 

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
        
        if (!slots) {
            container.innerHTML = '<p>暂无排班时间段。</p>';
            return;
        }

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

            if (dateCollapseState[dateKey] === undefined) {
                dateCollapseState[dateKey] = true; 
            }

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
                    </div>
                `;
                body.appendChild(slotDiv);
            });

            dateGroupDiv.appendChild(header);
            dateGroupDiv.appendChild(body);
            container.appendChild(dateGroupDiv);
        });
    });

    db.ref('settings/notice').on('value', (snapshot) => {
        if (snapshot.val() !== null) document.getElementById('notice-input').value = snapshot.val();
    });

    db.ref('settings/deadline').on('value', (snapshot) => {
        if (snapshot.val()) document.getElementById('deadline-input').value = snapshot.val();
    });

    db.ref('settings/accessCode').on('value', (snapshot) => {
        if (snapshot.val()) document.getElementById('code-input').value = snapshot.val();
    });

    db.ref('reservations').on('value', (snapshot) => {
        const res = snapshot.val();
        const container = document.getElementById('admin-reservations-container');
        container.innerHTML = '';
        reservationsData = [];
        
        if (!res) {
            container.innerHTML = '<p style="color:#999; text-align:center; padding:20px;">暂无同学预约记录</p>';
            return;
        }

        const resGroups = {};
        Object.keys(res).forEach(resKey => {
            const r = res[resKey];
            reservationsData.push(r); 
            const submitDateStr = new Date(r.timestamp).toLocaleDateString();
            
            if (!resGroups[submitDateStr]) resGroups[submitDateStr] = [];
            resGroups[submitDateStr].push({ key: resKey, data: r });
        });

        Object.keys(resGroups).sort().reverse().forEach(submitDate => { 
            const resGroupDiv = document.createElement('div');
            resGroupDiv.className = 'date-group res-group';

            if (resCollapseState[submitDate] === undefined) {
                resCollapseState[submitDate] = true;
            }

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
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>时段</th>
                        <th>姓名</th>
                        <th>专属取消码</th>
                        <th>精确提交时间</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector('tbody');

            resGroups[submitDate].forEach(item => {
                const r = item.data;
                const tr = document.createElement('tr');
                const preciseTime = new Date(r.timestamp).toLocaleTimeString();
                tr.innerHTML = `
                    <td>${r.time}</td>
                    <td><b>${r.nickname}</b></td>
                    <td style="color:#e6a23c; font-weight:bold;">${r.cancelCode || '无'}</td>
                    <td>${preciseTime}</td>
                    <td>
                        <button class="danger" style="padding:4px 8px; font-size:12px;" onclick="deleteSingleReservation('${item.key}', '${r.slotId}', '${r.nickname}')">取消该预约</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });

            body.appendChild(table);
            resGroupDiv.appendChild(header);
            resGroupDiv.appendChild(body);
            container.appendChild(resGroupDiv);
        });
    });
}

function cancelEditSlot(slotId) {
    db.ref('slots/' + slotId).once('value').then(snapshot => {
        const slot = snapshot.val();
        if (!slot) return;
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
    if (!dateMatch) {
        return alert('❌ 格式不正确！必须以“月/日”格式开头，如 "6/19 14:00-15:00"');
    }

    const month = parseInt(dateMatch[1], 10);
    const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) {
        return alert(`❌ 修改失败：日历中不存在 ${month}月${day}日！请重新核对。`);
    }

    db.ref('slots/' + slotId).update({ time: newTime }).then(() => {
        db.ref('reservations').once('value').then((snapshot) => {
            const res = snapshot.val();
            const updates = {};
            if (res) {
                Object.keys(res).forEach(resKey => {
                    if (res[resKey].slotId === slotId) {
                        updates[`reservations/${resKey}/time`] = newTime;
                    }
                });
            }
            db.ref().update(updates).then(() => {
                alert('时间段文字修改成功，已自动同步更新相关同学的预约单！');
            });
        });
    });
}

function setNotice() {
    const noticeText = document.getElementById('notice-input').value;
    db.ref('settings/notice').set(noticeText).then(() => {
        alert('公告更新成功！同学端已实时同步。');
    });
}

function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    const dateMatch = time.match(/^(\d{1,2})\/(\d{1,2})/);
    if (!dateMatch) {
        return alert('❌ 格式不正确！必须以“月/日”格式开头，例如: "6/19 0800-1015"');
    }

    const month = parseInt(dateMatch[1], 10);
    const day = parseInt(dateMatch[2], 10);
    if (!isValidCalendarDate(month, day)) {
        return alert(`❌ 添加失败：公历中不存在 ${month}月${day}日！请检查后输入真实的日期。`);
    }

    db.ref('slots').push({ time: time, reserved: false }).then(() => {
        timeInput.value = '';
    });
}

function generateDayTemplate() {
    const dateInput = document.getElementById('template-date').value;
    if (!dateInput) return alert('请先选择需要批量排班的日期！');

    const dateObj = new Date(dateInput);
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();
    const prefix = `${month}/${day}`;

    const templates = [];
    for (let i = 1; i <= 5; i++) {
        const val = document.getElementById(`tpl-time-${i}`).value.trim();
        if (val) templates.push(val);
    }

    if (templates.length === 0) return alert('请至少填写一个时间段！');

    if (confirm(`确定要一键生成 ${prefix} 的这 ${templates.length} 个自定义辅导时间段吗？`)) {
        const updates = {};
        templates.forEach(t => {
            const newKey = db.ref().child('slots').push().key;
            updates[`slots/${newKey}`] = { time: `${prefix} ${t}`, reserved: false };
        });
        
        db.ref().update(updates).then(() => {
            document.getElementById('tpl-time-1').value = "0800-1015";
            document.getElementById('tpl-time-2').value = "1030-1245";
            document.getElementById('tpl-time-3').value = "1330-1545";
            document.getElementById('tpl-time-4').value = "1600-1815";
            document.getElementById('tpl-time-5').value = "1900-2115";
            document.getElementById('template-date').value = "";
            alert('⚡ 排班模板已成功部署！');
        });
    }
}

function deleteSlot(slotId) {
    if (confirm('确定要彻底删除这个时间段排班吗？（对应的学生预约单也会一并删除）')) {
        db.ref('slots/' + slotId).remove().then(() => {
            db.ref('reservations').once('value').then((snapshot) => {
                const res = snapshot.val();
                const updates = {};
                if (res) {
                    Object.keys(res).forEach(resKey => {
                        if (res[resKey].slotId === slotId) {
                            updates[`reservations/${resKey}`] = null;
                        }
                    });
                }
                db.ref().update(updates).then(() => {
                    alert('该时段排班与关联的学生单据已一并同步清除！');
                });
            });
        });
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
        const updates = {};
        updates[`slots/${slotId}/reserved`] = false;
        updates[`reservations/${resKey}`] = null;

        db.ref().update(updates).then(() => {
            alert(`已成功取消 [${nickname}] 的预约，名额已释放！`);
        }).catch(() => {
            alert('操作失败，请刷新后台重试。');
        });
    }
}

function clearData() {
    if (confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？')) {
        const updates = { slots: null, reservations: null };
        db.ref().update(updates).then(() => {
            alert('云端数据已彻底擦除！');
        });
    }
}
