// admin.js
(function() {
    let isAdminAuthenticated = false;
    let initialized = false; 
    let dateCollapseState = {};
    let resCollapseState = {};
    let reservationsData = [];
    let viewingYear = "2026";
    const GROUP_CUTOFF = new Date('2026-07-26T00:00:00+08:00').getTime(); 

    let currentActiveSlotsRefMemory = null;
    let currentActiveReservationsRefMemory = null;
    let currentActiveLogsRefMemory = null;
    let currentActiveNoticeTextRefMemory = null;
    let currentActiveNoticeImgRefMemory = null;
    let currentActiveStudentListRefMemory = null;
    let currentActiveDeadlineRefMemory = null;
    let currentActiveAccessCodeRefMemory = null;

    //在核验成功的分支链中，追加会话打标共享，打通无感通行管道
    function verifyAdmin() {
        const inputPass = document.getElementById('admin-password').value.trim();
        const errorEl = document.getElementById('login-error');
        if (!inputPass) return alert('请输入密码！');

        db.ref(`admin_auth/${inputPass}`).once('value').then((snapshot) => {
            if (snapshot.exists() && snapshot.val() === true) {
                //向当前浏览器会话（Tab）中埋下通过鉴权的绿色通行证
                localStorage.setItem('admin_session_auth', 'true');

                isAdminAuthenticated = true; 
                document.getElementById('admin-login').style.display = 'none';
                document.getElementById('admin-content').style.display = 'block';
                initAdminSystem();
            } else { errorEl.textContent = '密码错误！'; }
        });
    }

    function initAdminSystem() {
        if (!isAdminAuthenticated) return; 
        if (initialized) return; initialized = true;

        db.ref('slots').once('value').then((s) => {
            db.ref('reservations').once('value').then((r) => {
                if (s.exists() || r.exists()) document.getElementById('migration-wizard-panel').style.display = 'block';
            });
        });

        SystemRouter.yearsRoot().on('value', (snapshot) => {
            if (!isAdminAuthenticated) return;
            const data = snapshot.val(); const selectEl = document.getElementById('admin-year-select');
            const savedVal = selectEl.value || SystemRouter.activeYear || "2026";
            selectEl.innerHTML = '';
            
            if (data) {
                Object.keys(data).sort().reverse().forEach(y => {
                    const opt = document.createElement('option'); opt.value = y;
                    const name = (data[y].metadata && data[y].metadata.name) ? data[y].metadata.name : `${y}学年`;
                    const suffix = (y === SystemRouter.activeYear) ? " [当前开放学年]" : " [历史归档]";
                    opt.textContent = name + suffix; selectEl.appendChild(opt);
                });
                if (data[savedVal]) selectEl.value = savedVal;
            } else {
                const opt = document.createElement('option'); opt.value = "2026"; opt.textContent = "2026学年 [当前开放学年]"; selectEl.appendChild(opt);
            }
            updateStatusTextInfo();
            handleViewingYearChange(); 
        });

        SystemRouter.system().on('value', (snap) => {
            if (!isAdminAuthenticated) return;
            const sys = snap.val();
            if (sys && sys.activeYear) {
                SystemRouter.activeYear = sys.activeYear; SystemRouter.activeName = sys.activeName; updateStatusTextInfo();
            }
        });

        handleViewingYearChange();
    }

    function updateStatusTextInfo() {
        const bar = document.getElementById('year-status-bar');
        if (bar) bar.innerHTML = `当前对学生开放的学年是：<span class="text-blue text-bold">${escapeHtml(SystemRouter.activeName)} (${SystemRouter.activeYear || '2026'}年)</span>`;
    }

    function handleViewingYearChange() {
        if (!isAdminAuthenticated) return;
        const selectEl = document.getElementById('admin-year-select');
        if (selectEl && selectEl.value) viewingYear = selectEl.value;

        if (currentActiveSlotsRefMemory) currentActiveSlotsRefMemory.off();
        if (currentActiveReservationsRefMemory) currentActiveReservationsRefMemory.off();
        if (currentActiveLogsRefMemory) currentActiveLogsRefMemory.off();
        if (currentActiveNoticeTextRefMemory) currentActiveNoticeTextRefMemory.off();
        if (currentActiveNoticeImgRefMemory) currentActiveNoticeImgRefMemory.off();
        if (currentActiveStudentListRefMemory) currentActiveStudentListRefMemory.off();
        if (currentActiveDeadlineRefMemory) currentActiveDeadlineRefMemory.off();
        if (currentActiveAccessCodeRefMemory) currentActiveAccessCodeRefMemory.off();

        currentActiveSlotsRefMemory = SystemRouter.getSlotsRef(viewingYear);
        currentActiveReservationsRefMemory = SystemRouter.getReservationsRef(viewingYear);
        currentActiveLogsRefMemory = SystemRouter.getLogsRef(viewingYear).orderByChild('timestamp').limitToLast(60); 
        currentActiveNoticeTextRefMemory = SystemRouter.getSettingsRef(viewingYear).child('notice');
        currentActiveNoticeImgRefMemory = SystemRouter.getSettingsRef(viewingYear).child('noticeImage');
        currentActiveStudentListRefMemory = db.ref(`years/${viewingYear}/studentWhitelist`);
        currentActiveDeadlineRefMemory = SystemRouter.getSettingsRef(viewingYear).child('deadline');
        currentActiveAccessCodeRefMemory = SystemRouter.getSettingsRef(viewingYear).child('accessCode');

        currentActiveNoticeTextRefMemory.on('value', snap => {
            const noticeInput = document.getElementById('notice-input');
            if (noticeInput) noticeInput.value = snap.val() || '';
        });

        currentActiveNoticeImgRefMemory.on('value', snap => {
            const imgData = snap.val();
            const btnDelImg = document.getElementById('btn-del-notice-img');
            const previewContainer = document.getElementById('notice-img-preview-container');
            const previewImg = document.getElementById('notice-img-preview');
            
            if (imgData) {
                if(previewImg) previewImg.src = imgData;
                if(previewContainer) previewContainer.style.display = 'block';
                if(btnDelImg) btnDelImg.style.display = 'inline-block';
            } else {
                if(previewImg) previewImg.src = '';
                if(previewContainer) previewContainer.style.display = 'none';
                if(btnDelImg) btnDelImg.style.display = 'none';
            }
        });

        currentActiveDeadlineRefMemory.on('value', snap => {
            const deadlineInput = document.getElementById('deadline-input');
            if (deadlineInput) {
                if (snap.val()) {
                    deadlineInput.value = snap.val();
                } else {
                    db.ref('settings/deadline').once('value').then(oldSnap => {
                        if (oldSnap.val() && !deadlineInput.value) deadlineInput.value = oldSnap.val();
                    });
                }
            }
        });

        currentActiveAccessCodeRefMemory.on('value', snap => {
            const codeInput = document.getElementById('code-input');
            if (codeInput) {
                if (snap.val()) {
                    codeInput.value = snap.val();
                } else {
                    db.ref('settings/accessCode').once('value').then(oldSnap => {
                        if (oldSnap.val() && !codeInput.value) codeInput.value = oldSnap.val();
                    });
                }
            }
        });

        loadSlotTemplates();

        currentActiveStudentListRefMemory.on('value', (snapshot) => {
            const container = document.getElementById('admin-student-whitelist-container');
            container.innerHTML = '';
            const list = snapshot.val();
            if(!list) {
                container.innerHTML = '<span class="text-gray" style="font-size:13px;">当前学年未录入准入学生，任何人都无法提交预约。</span>';
                return;
            }
            Object.keys(list).forEach(sId => {
                const sName = list[sId];
                const tag = document.createElement('span');
                tag.className = 'student-tag';
                tag.innerHTML = `<span>${escapeHtml(sName)}</span><span class="student-tag-del" data-id="${sId}" data-name="${escapeHtml(sName)}">×</span>`;
                container.appendChild(tag);
            });
            
            document.querySelectorAll('.student-tag-del').forEach(btn => {
                btn.onclick = function() {
                    const id = this.dataset.id; const name = this.dataset.name;
                    if(confirm(`确定将 [${name}] 从当前学年准入名单中移除吗？`)) {
                        db.ref(`years/${viewingYear}/studentWhitelist/${id}`).remove().then(() => {
                            SystemRouter.getLogsRef(viewingYear).push({
                                action: `移除了准入学生：[${name}]`, timestamp: firebase.database.ServerValue.TIMESTAMP
                            });
                        });
                    }
                };
            });
        });

        currentActiveSlotsRefMemory.on('value', (snapshot) => {
            const slots = snapshot.val(); const container = document.getElementById('admin-slots-container');
            container.innerHTML = ''; if (!slots) { container.innerHTML = '<p class="empty-hint">当前没有排班。</p>'; return; }

            const groups = {};
            Object.keys(slots).forEach(slotId => {
                const slot = slots[slotId]; if (!slot || !slot.time || slot.status === "hidden") return;
                
                const parsed = TimeParser.parseRawText(slot.time, viewingYear);
                const dateKey = parsed ? `${parseInt(parsed.date.split('-')[1],10)}/${parseInt(parsed.date.split('-')[2],10)}` : "其他格式";

                if (!groups[dateKey]) groups[dateKey] = []; groups[dateKey].push({ id: slotId, data: slot });
            });

            Object.keys(groups).sort((a,b) => {
                const [am, ad] = a.split('/').map(Number); const [bm, bd] = b.split('/').map(Number);
                return new Date(parseInt(viewingYear), am - 1, ad) - new Date(parseInt(viewingYear), bm - 1, bd);
            }).forEach(dateKey => {
                const dateGroupDiv = document.createElement('div'); dateGroupDiv.className = 'date-group';
                if (dateCollapseState[dateKey] === undefined) dateCollapseState[dateKey] = true; 

                const header = document.createElement('div'); header.className = 'date-header';
                header.innerHTML = `<span>${escapeHtml(dateKey)} 排班</span> <span class="arrow-indicator">${dateCollapseState[dateKey] ? '展开 +' : '收起 -'}</span>`;
                const body = document.createElement('div'); body.className = `date-body ${dateCollapseState[dateKey] ? 'collapsed' : ''}`;

                header.onclick = () => {
                    dateCollapseState[dateKey] = !dateCollapseState[dateKey]; body.classList.toggle('collapsed');
                    header.querySelector('.arrow-indicator').textContent = dateCollapseState[dateKey] ? '展开 +' : '收起 -';
                };

                groups[dateKey].forEach(item => {
                    const slotDiv = document.createElement('div'); slotDiv.className = 'slot-item'; slotDiv.id = `slot-row-${item.id}`; 
                    
                    const p = TimeParser.parseRawText(item.data.time, viewingYear);
                    const displayLabel = p ? p.formattedSlotText : item.data.time;

                    slotDiv.innerHTML = `
                        <span class="slot-text-span">${escapeHtml(displayLabel)} ${item.data.reserved ? '<strong class="text-red">(已约)</strong>' : '<strong class="text-green">(空闲)</strong>'}</span>
                        <div class="btn-group">
                            <button class="btn-edit slot-edit-btn" data-id="${item.id}" data-time="${escapeHtml(item.data.time)}">修改</button>
                            <button class="btn-delete danger" data-id="${item.id}">删除</button>
                        </div>`;
                    body.appendChild(slotDiv);
                });
                dateGroupDiv.appendChild(header); dateGroupDiv.appendChild(body); container.appendChild(dateGroupDiv);
            });
            bindDynamicGridButtons();
        });

        currentActiveReservationsRefMemory.on('value', (snapshot) => {
            const res = snapshot.val(); const container = document.getElementById('admin-reservations-container');
            const pendingPanel = document.getElementById('pending-approval-panel');
            const cancelPanel = document.getElementById('cancel-approval-panel');

            container.innerHTML = '';
            if (pendingPanel) pendingPanel.style.display = 'none';
            if (cancelPanel) cancelPanel.style.display = 'none';
            reservationsData = [];
            if (!res) { container.innerHTML = '<p class="empty-hint">当前没有预约记录。</p>'; return; }

            const resGroups = {};

            Object.keys(res).forEach(resKey => {
                const r = res[resKey]; if (!r) return;
                r.id = resKey; reservationsData.push(r);

                // 已手动归档的强制进历史归档，否则按上课时间判断
                let groupKey;
                if (r.archived) {
                    groupKey = '历史归档';
                } else {
                    let lessonTs = null;
                    if (r.time) {
                        const parsed = TimeParser.parseRawText(r.time, viewingYear);
                        if (parsed && parsed.date) lessonTs = new Date(parsed.date + 'T00:00:00+08:00').getTime();
                    }
                    if (lessonTs === null && r.slotId) {
                        lessonTs = decodePushIdTimestamp(r.slotId);
                    }
                    if (lessonTs === null && r.timestamp) {
                        lessonTs = new Date(r.timestamp).getTime();
                    }
                    groupKey = (lessonTs !== null && lessonTs >= GROUP_CUTOFF) ? '当前排课' : '历史归档';
                }

                if (!resGroups[groupKey]) resGroups[groupKey] = [];
                resGroups[groupKey].push({ key: resKey, data: r });
            });

            // 组内按上课时间倒序（最近的在最上面）
            const sortByLessonTime = (a, b) => {
                const getTs = (r) => {
                    if (r.time) { const p = TimeParser.parseRawText(r.time, viewingYear); if (p && p.date) return new Date(p.date + 'T00:00:00+08:00').getTime(); }
                    if (r.slotId) return decodePushIdTimestamp(r.slotId) || 0;
                    return r.timestamp || 0;
                };
                return getTs(b.data) - getTs(a.data);
            };

            ['当前排课', '历史归档'].forEach(groupKey => {
                if (!resGroups[groupKey]) return;
                const groupRecords = resGroups[groupKey].sort(sortByLessonTime);
                const resGroupDiv = document.createElement('div'); resGroupDiv.className = 'date-group res-group';
                if (resCollapseState[groupKey] === undefined) resCollapseState[groupKey] = true;

                const isCurrent = groupKey === '当前排课';
                const header = document.createElement('div'); header.className = 'date-header';
                header.style.background = isCurrent ? '#ecf5ff' : '#f4f4f5';
                header.style.color = isCurrent ? '#409eff' : '#909399';
                header.innerHTML = `<span>${escapeHtml(groupKey)} (${groupRecords.length} 条)</span> <span class="arrow-indicator">${resCollapseState[groupKey] ? '展开 +' : '收起 -'}</span>`;
                const body = document.createElement('div'); body.className = `date-body ${resCollapseState[groupKey] ? 'collapsed' : ''}`;
                body.style.overflowX = 'auto';

                header.onclick = () => {
                    resCollapseState[groupKey] = !resCollapseState[groupKey]; body.classList.toggle('collapsed');
                    header.querySelector('.arrow-indicator').textContent = resCollapseState[groupKey] ? '展开 +' : '收起 -';
                };

                const table = document.createElement('table');
                table.innerHTML = `<thead><tr><th style="width:30px;"><input type="checkbox" class="batch-check-all" title="全选/取消"></th><th>时间</th><th>姓名</th><th>状态</th><th>取消码</th><th>操作</th></tr></thead><tbody></tbody>`;
                const tbody = table.querySelector('tbody');

                groupRecords.forEach(item => {
                    const r = item.data;
                    const currentStatus = r.status || 'booked';
                    const statusOptions = [
                        { val: 'booked', label: '已预约', color: '#e6a23c' },
                        { val: 'confirmed', label: '已确认', color: '#409eff' },
                        { val: 'completed', label: '已完成', color: '#67c23a' },
                        { val: 'canceled', label: '已取消', color: '#909399' }
                    ];
                    const selectedOpt = statusOptions.find(o => o.val === currentStatus);
                    const statusColor = selectedOpt ? selectedOpt.color : '#909399';

                    let selectHtml = `<select class="status-select-admin" data-key="${item.key}" data-oldstatus="${currentStatus}" style="color:${statusColor};">`;
                    statusOptions.forEach(opt => {
                        selectHtml += `<option value="${opt.val}" ${opt.val === currentStatus ? 'selected' : ''} style="color:${opt.color};">${opt.label}</option>`;
                    });
                    selectHtml += '</select>';

                    let archiveBtnHtml = '';
                    if (isCurrent) {
                        archiveBtnHtml = `<button class="btn-archive btn-archive-res" data-key="${item.key}">归档</button>`;
                    } else if (r.archived) {
                        archiveBtnHtml = `<button class="btn-unarchive btn-unarchive-res" data-key="${item.key}">移回当前</button>`;
                    }

                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td><input type="checkbox" class="batch-check-item" data-key="${item.key}"></td><td>${escapeHtml(r.time)}</td>
                        <td><span class="editable-name" data-key="${item.key}" data-oldname="${escapeHtml(r.nickname)}"><b>${escapeHtml(r.nickname || '不详')}</b></span></td>
                        <td>${selectHtml}</td><td>${escapeHtml(r.cancelCode || '-')}</td>
                        <td>${archiveBtnHtml}<button class="danger btn-force-del" data-key="${item.key}" data-slotid="${r.slotId}" data-name="${escapeHtml(r.nickname || '未定')}">删除</button></td>`;
                    tbody.appendChild(tr);
                });

                // 绑定全选
                const checkAll = table.querySelector('.batch-check-all');
                if (checkAll) {
                    checkAll.onclick = function() {
                        table.querySelectorAll('.batch-check-item').forEach(cb => { cb.checked = this.checked; });
                        updateBatchBar();
                    };
                }
                body.appendChild(table); resGroupDiv.appendChild(header); resGroupDiv.appendChild(body); container.appendChild(resGroupDiv);
            });
            bindStatusDropdownEvents();
            bindDeleteReservationButtons();
            bindArchiveButtons();
            bindBatchCheckEvents();
            bindNameEditEvents();
        });

        currentActiveLogsRefMemory.on('value', (snapshot) => {
            const logs = snapshot.val(); const container = document.getElementById('admin-logs-container');
            if (!logs) { container.innerHTML = "<div>暂无日志。</div>"; return; }
            let logHtml = "";
            Object.keys(logs).sort().reverse().forEach(k => {
                const t = logs[k].timestamp ? new Date(logs[k].timestamp).toLocaleString() : '未知时段';
                logHtml += `<div>[${t}] - ${escapeHtml(logs[k].action)}</div>`;
            });
            container.innerHTML = logHtml;
        });
    }

    function bindNameEditEvents() {
        document.querySelectorAll('.editable-name').forEach(el => {
            el.ondblclick = function() {
                const resKey = this.dataset.key; const oldName = this.dataset.oldname;
                const newName = prompt(`将该同学的名字修改为真实姓名（方便导入课时费）：`, oldName);
                if (newName && newName.trim() !== "" && newName.trim() !== oldName) {
                    const cleanName = newName.trim(); if (cleanName.includes(',')) return alert('姓名中不能包含逗号！');
                    SystemRouter.getReservationsRef(viewingYear).child(resKey).update({ nickname: cleanName }).then(() => {
                        SystemRouter.getLogsRef(viewingYear).push({
                            action: `管理员将预约单据 [${resKey}] 的姓名由 [${oldName}] 修改为 [${cleanName}]`, timestamp: firebase.database.ServerValue.TIMESTAMP
                        });
                    });
                }
            };
        });
    }

    function addNewStudentToWhitelist() {
        const input = document.getElementById('new-student-name'); const name = input.value.trim();
        if(!name) return alert('请输入名字！'); if(name.includes(',')) return alert('名字里不能带逗号！');

        db.ref(`years/${viewingYear}/studentWhitelist`).once('value').then(snap => {
            const exist = snap.val() || {}; const isDup = Object.values(exist).some(v => v === name);
            if(isDup) return alert('该同学已经在名单中了！');

            db.ref(`years/${viewingYear}/studentWhitelist`).push(name).then(() => {
                SystemRouter.getLogsRef(viewingYear).push({
                    action: `新增准入白名单学生：[${name}]`, timestamp: firebase.database.ServerValue.TIMESTAMP
                });
                input.value = '';
            });
        });
    }

    // 显示每学生课时统计
    function showStudentStats() {
        if (reservationsData.length === 0) return alert('当前没有预约记录！');
        const stats = {};
        reservationsData.forEach(r => {
            const name = r.nickname || '未知';
            if (!stats[name]) stats[name] = { total: 0, completed: 0, booked: 0, confirmed: 0, canceled: 0 };
            const hours = TimeParser.calcHours(r.time);
            stats[name].total++;
            switch (r.status || 'booked') {
                case 'completed': stats[name].completed += hours; break;
                case 'booked': stats[name].booked++; break;
                case 'confirmed': stats[name].confirmed++; break;
                case 'canceled': stats[name].canceled++; break;
            }
        });

        const sorted = Object.entries(stats).sort((a, b) => b[1].completed - a[1].completed);
        let html = `<table style="width:100%; border-collapse:collapse; font-size:13px;">
            <tr style="background:#f5f7fa;"><th>学生</th><th>已完成(h)</th><th>已确认</th><th>已预约</th><th>已取消</th><th>总次数</th></tr>`;
        sorted.forEach(([name, s]) => {
            html += `<tr><td><b>${escapeHtml(name)}</b></td>
                <td><span class="text-green text-bold">${s.completed.toFixed(2)}</span></td>
                <td>${s.confirmed}</td><td>${s.booked}</td>
                <td class="text-gray">${s.canceled}</td><td>${s.total}</td></tr>`;
        });
        html += '</table>';
        const panel = document.getElementById('stats-panel');
        panel.innerHTML = html;
        panel.style.display = 'block';
        panel.scrollIntoView({ behavior: 'smooth' });
    }

    function exportTutorFeeJSON() {
        if (reservationsData.length === 0) return alert('当前没有预约记录可以导出！');
        // 只有「已完成」才算有效课时
        const validReservations = reservationsData.filter(r => r.status === "completed");
        if (validReservations.length === 0) return alert('当前没有已完成的课时可用于记账。');

        const outputRecords = [];
        validReservations.forEach(r => {
            let itemDate = new Date().toISOString().split('T')[0]; 
            let calculatedHours = 2.0; 
            
            if (r.slotSnapshot && r.slotSnapshot.date) {
                itemDate = r.slotSnapshot.date; 
            } else if (r.time) {
                const p = TimeParser.parseRawText(r.time, viewingYear);
                if (p) itemDate = p.date;
            }
            
            const rawTimeStr = r.time || (r.slotSnapshot ? r.slotSnapshot.rawTime : '') || '';
            const timeMatch = rawTimeStr.match(/(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})/);
            if (timeMatch) {
                const startMinutes = parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
                const endMinutes = parseInt(timeMatch[3], 10) * 60 + parseInt(timeMatch[4], 10);
                const diffMinutes = endMinutes - startMinutes;
                
                if (diffMinutes > 0) {
                    calculatedHours = Number((diffMinutes / 60).toFixed(2)); 
                }
            }

            outputRecords.push({
                id: "imported_" + (r.id || Math.random().toString(36).substring(2, 9)),
                studentId: "", studentName: r.nickname || "未知学生", date: itemDate,
                hours: calculatedHours, rate: 0, total: 0 
            });
        });

        const packageData = {
            source: "class_optic_booking_system", exportYear: viewingYear,
            exportedAt: new Date().toLocaleString(), records: outputRecords 
        };

        const dataStr = JSON.stringify(packageData, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url;
        link.download = `课时费对接包_${viewingYear}学年.json`;
        document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
    }

    // === 旧审批函数已废弃，状态通过状态下拉框自由切换 (changeReservationStatus) ===

    function cancelEditSlot(slotId) {
        SystemRouter.getSlotsRef(viewingYear).child(slotId).once('value').then(snapshot => {
            const slot = snapshot.val(); if (!slot) return;
            const row = document.getElementById(`slot-row-${slotId}`);
            const p = TimeParser.parseRawText(slot.time, viewingYear);
            const displayLabel = p ? p.formattedSlotText : slot.time;

            row.innerHTML = `<span class="slot-text-span">${escapeHtml(displayLabel)} ${slot.reserved ? '<strong class="text-red">(已约)</strong>' : '<strong class="text-green">(空闲)</strong>'}</span>
                <div class="btn-group">
                    <button class="btn-edit slot-edit-btn" data-id="${slotId}" data-time="${escapeHtml(slot.time)}">修改</button>
                    <button class="btn-delete danger" data-id="${slotId}">删除</button>
                </div>`;
            bindDynamicGridButtons();
        });
    }

    function startEditSlot(slotId, currentTime) {
        const row = document.getElementById(`slot-row-${slotId}`);
        row.innerHTML = `<input type="text" class="edit-input" id="edit-input-${slotId}" value="${escapeHtml(currentTime)}">
            <div class="btn-group">
                <button class="slot-save-btn" onclick="saveEditedSlot('${slotId}')">保存</button>
                <button class="slot-cancel-btn" onclick="cancelEditSlot('${slotId}')">取消</button>
            </div>`;
    }

    window.saveEditedSlot = function(slotId) {
        const newTime = document.getElementById('edit-input-' + slotId).value.trim();
        const validationParser = TimeParser.parseRawText(newTime, viewingYear);
        if (!validationParser) return alert('格式错误（例：6/19 1400-1500）');

        SystemRouter.getSlotsRef(viewingYear).once('value').then(snap => {
            const data = snap.val() || {};
            const isDup = Object.keys(data).some(id => id !== slotId && data[id].time === validationParser.formattedSlotText && data[id].status !== "hidden");
            if (isDup) return alert('该时间段已存在排班！');

            SystemRouter.getSlotsRef(viewingYear).child(slotId).update({ time: validationParser.formattedSlotText }).then(() => {
                
                SystemRouter.getReservationsRef(viewingYear).once('value').then((resSnap) => {
                    const reservations = resSnap.val();
                    if (reservations) {
                        const batchUpdates = {};
                        Object.keys(reservations).forEach(resKey => {
                            if (reservations[resKey].slotId === slotId) {
                                batchUpdates[`years/${viewingYear}/reservations/${resKey}/time`] = validationParser.formattedSlotText;
                                batchUpdates[`years/${viewingYear}/reservations/${resKey}/slotSnapshot`] = validationParser;
                            }
                        });
                        db.ref().update(batchUpdates);
                    }
                });

                SystemRouter.getLogsRef(viewingYear).push({ action: `修改排班时间并同步了历史预约 -> ${validationParser.formattedSlotText}`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                alert('修改成功！相关的预约单据时间已自动同步。');
            });
        });
    };

    function setNotice() {
        const noticeText = document.getElementById('notice-input').value;
        const fileInput = document.getElementById('notice-image-input'); const file = fileInput.files[0];
        const targetRef = SystemRouter.getSettingsRef(viewingYear);

        if (file) {
            const reader = new FileReader(); reader.onload = function(e) {
                const img = new Image(); img.onload = function() {
                    const canvas = document.createElement('canvas'); let width = img.width; let height = img.height;
                    const MAX_WIDTH = 600; if (width > MAX_WIDTH) { height = Math.round((height * MAX_WIDTH) / width); width = MAX_WIDTH; }
                    canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
                    const compressedBase64 = canvas.toDataURL('image/jpeg', 0.6);
                    targetRef.child('notice').set(noticeText).then(() => {
                        targetRef.child('noticeImage').set(compressedBase64).then(() => { fileInput.value = ''; alert('公告发布成功。'); }).catch(() => { alert('图片上传失败，请重试。'); });
                    }).catch(() => { alert('公告保存失败，请重试。'); });
                }; img.src = e.target.result;
            }; reader.readAsDataURL(file);
        } else { targetRef.child('notice').set(noticeText).then(() => alert('公告保存成功。')).catch(() => { alert('公告保存失败，请重试。'); }); }
    }

    // 加载排班模板（从 Firebase 设置中读取）
    function loadSlotTemplates() {
        SystemRouter.getSettingsRef(viewingYear).child('slotTemplates').once('value').then(snap => {
            const vals = snap.val();
            if (vals && Array.isArray(vals)) {
                vals.forEach((v, i) => {
                    const el = document.getElementById(`tpl-time-${i + 1}`);
                    if (el && v) el.value = v;
                });
            }
        });
    }

    // 保存排班模板到 Firebase
    function saveSlotTemplates() {
        const templates = [];
        for (let i = 1; i <= 5; i++) {
            templates.push(document.getElementById(`tpl-time-${i}`).value.trim());
        }
        SystemRouter.getSettingsRef(viewingYear).child('slotTemplates').set(templates).then(() => {
            alert('模板已保存。');
        }).catch(() => { alert('保存失败。'); });
    }

    function addSlot() {
        const timeInput = document.getElementById('new-slot-time'); const time = timeInput.value.trim();
        const validationParser = TimeParser.parseRawText(time, viewingYear);
        if (!validationParser) return alert('格式错误（例：6/19 1400-1500）');
        
        SystemRouter.getSlotsRef(viewingYear).once('value').then(snap => {
            const current = snap.val() || {};
            const isDup = Object.values(current).some(s => s.time === validationParser.formattedSlotText && s.status !== "hidden");
            if (isDup) return alert('该时间已存在排班。');
            
            SystemRouter.getSlotsRef(viewingYear).push({ time: validationParser.formattedSlotText, reserved: false, status: "active" }).then(() => {
                SystemRouter.getLogsRef(viewingYear).push({ action: `新增排班：[${validationParser.formattedSlotText}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                timeInput.value = '';
            }).catch(() => { alert('新增排班失败，请重试。'); });
        });
    }

    function generateDayTemplate() {
        const dateInput = document.getElementById('template-date').value; if (!dateInput) return alert('请选择日期。');
        const dateObj = new Date(dateInput);
        if (isNaN(dateObj.getTime())) return alert('日期格式无效！');
        const prefix = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
        const templates = []; for (let i = 1; i <= 5; i++) { const val = document.getElementById(`tpl-time-${i}`).value.trim(); if (val) templates.push(val); }

        SystemRouter.getSlotsRef(viewingYear).once('value').then(snap => {
            const existData = snap.val() || {}; const atomicUpdates = {}; let okCount = 0; let failCount = 0;
            templates.forEach(t => {
                const rawCheck = `${prefix} ${t}`;
                const normalizedParser = TimeParser.parseRawText(rawCheck, viewingYear);
                if (!normalizedParser) return;

                const isDup = Object.values(existData).some(s => s.time === normalizedParser.formattedSlotText && s.status !== "hidden");
                if (isDup) { failCount++; } else {
                    okCount++; 
                    const newKey = SystemRouter.getSlotsRef(viewingYear).push().key; 
                    atomicUpdates[`years/${viewingYear}/slots/${newKey}`] = { time: normalizedParser.formattedSlotText, reserved: false, status: "active" };
                }
            });
            
            if (okCount === 0) return alert('这些时间段都已经存在了。');
            
            if (confirm('确定要批量添加排班吗？')) {
                db.ref().update(atomicUpdates).then(() => {
                    SystemRouter.getLogsRef(viewingYear).push({ action: `批量新增了 ${okCount} 个排班`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                    document.getElementById('template-date').value = ""; alert('批量排班成功。');
                }).catch(() => {
                    alert('批量排班失败，请重试。');
                });
            }
        });
    }

    function deleteSlot(slotId) {
        if (confirm('确定要删除这个排班吗？')) {
            SystemRouter.getSlotsRef(viewingYear).child(slotId).once('value').then(snapshot => {
                const slot = snapshot.val();
                if (slot && slot.reserved) {
                    SystemRouter.getSlotsRef(viewingYear).child(slotId).update({ status: "hidden" }).then(() => {
                        SystemRouter.getLogsRef(viewingYear).push({ action: `隐藏已预约的排班: [${slot.time}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                        alert('由于已有学生预约，该时段已在学生端隐藏。');
                    }).catch(() => { alert('操作失败，请重试。'); });
                } else {
                    SystemRouter.getSlotsRef(viewingYear).child(slotId).remove().then(() => alert('删除成功。')).catch(() => { alert('删除失败，请重试。'); });
                }
            }).catch(() => { alert('读取排班信息失败，请重试。'); });
        }
    }

    function deleteSingleReservation(resKey, slotId, nickname) {
        if (confirm(`确定要删除 ${nickname} 的预约记录吗？`)) {
            SystemRouter.getSlotsRef(viewingYear).child(slotId).once('value').then(slotSnap => {
                const slot = slotSnap.val();
                const finalAbsoluteUpdates = {};
                finalAbsoluteUpdates[`years/${viewingYear}/reservations/${resKey}`] = null;

                if (slot) {
                    if (slot.status === "hidden") finalAbsoluteUpdates[`years/${viewingYear}/slots/${slotId}`] = null;
                    else finalAbsoluteUpdates[`years/${viewingYear}/slots/${slotId}/reserved`] = false;
                }

                db.ref().update(finalAbsoluteUpdates).then(() => {
                    SystemRouter.getLogsRef(viewingYear).push({ action: `删除了学生的预约记录: [${nickname}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                }).catch((err) => {
                    console.error('删除预约记录失败:', err);
                    alert('删除失败，请重试。');
                });
            });
        }
    }

    function setAsActiveYear() {
        const targetY = document.getElementById('admin-year-select').value; if (!targetY) return;
        if (confirm(`确定要把 ${targetY} 设为当前对学生开放的学年吗？`)) {
            const customName = prompt("请输入学生端显示的标题：", `${targetY}级硕士专业课辅导`);
            if (!customName) return alert('标题不能为空。');
            
            SystemRouter.system().update({ activeYear: targetY, activeName: customName }).then(() => {
                SystemRouter.getLogsRef(targetY).push({ action: `将本学年设为当前开放学年`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                alert('设置成功！学生端已同步。');
            });
        }
    }

    function createNewYearNode() {
        const newY = prompt("请输入要新建的4位年份（如 2027 ）：");
        if (!newY || !/^\d{4}$/.test(newY)) return alert('请输入4位数字的年份！');
        
        SystemRouter.yearsRoot().child(newY).once('value').then(snap => {
            if (snap.exists()) return alert('该学年已经存在！');
            
            const secureRandomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            const initTitleName = `${newY}级硕士专业课辅导`;
            const initialPack = {};
            
            initialPack[`years/${newY}/metadata`] = { name: initTitleName, archived: false, schemaVersion: 2, createdAt: firebase.database.ServerValue.TIMESTAMP };
            initialPack[`years/${newY}/settings/accessCode`] = secureRandomCode; 

            db.ref().update(initialPack).then(() => {
                SystemRouter.getLogsRef(newY).push({ action: `新建了学年`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                alert(`新建学年成功！\n默认口令是：【 ${secureRandomCode} 】\n请在下拉框中切换并开始排班。`);
            });
        });
    }

    function setDeadline() {
        const d = document.getElementById('deadline-input').value; if (!d) return alert('请选择时间');
        SystemRouter.getSettingsRef(viewingYear).update({ deadline: d }).then(() => alert('截止时间保存成功！'));
    }
    function setCode() {
        const c = document.getElementById('code-input').value.trim(); if (!c) return alert('口令不能为空');
        SystemRouter.getSettingsRef(viewingYear).update({ accessCode: c }).then(() => alert('口令修改成功！'));
    }

    window.destroyCurrentYearData = function() {
        if (viewingYear === SystemRouter.activeYear) {
            return alert('不能删除正在对外开放的学年！\n如需删除，请先将其他学年设为【当前开放学年】。');
        }
        
        const confirmMsg = prompt(`确定要彻底删除 ${viewingYear} 学年吗？这会清空该学年的所有数据！\n请输入 ${viewingYear} 确认：`);
        
        if (confirmMsg === viewingYear) {
            db.ref(`years/${viewingYear}`).remove().then(() => {
                alert('该学年已彻底删除。');
                document.getElementById('admin-year-select').value = "2026";
                handleViewingYearChange();
            }).catch(err => {
                alert('删除失败：' + err.message);
            });
        } else if (confirmMsg !== null) {
            alert('输入不匹配，已取消删除。');
        }
    };

    function exportCSV() {
        if (reservationsData.length === 0) return alert('没有数据可导出');
        const sorted = [...reservationsData].sort((a,b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

        let csvContent = "\"预约时段\",\"学生姓名\",\"状态\",\"取消凭证\",\"提交时间\"\n";
        sorted.forEach(r => {
            let textS = r.status || "booked";
            switch(textS) {
                case "booked": textS = "已预约"; break; case "confirmed": textS = "已确认"; break;
                case "canceled": textS = "已取消"; break; case "completed": textS = "已完成"; break;
            }
            const readableSubmitTime = r.timestamp ? new Date(r.timestamp).toLocaleString() : "未知";
            csvContent += `"${(r.time || '').replace(/"/g, '""')}","${(r.nickname || '不详').replace(/"/g, '""')}","${textS}","${(r.cancelCode || '-').replace(/"/g, '""')}","${readableSubmitTime}"\n`;
        });
        
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
        
        const link = document.createElement("a"); 
        link.href = URL.createObjectURL(blob);
        link.setAttribute("download", `预约数据_${viewingYear}.csv`);
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
    }

    function clearCurrentYearData() {
        if (confirm('确定要清空当前年份的所有排班和单据吗？')) {
            const clearPacks = {};
            clearPacks[`years/${viewingYear}/slots`] = null;
            clearPacks[`years/${viewingYear}/reservations`] = null;
            clearPacks[`years/${viewingYear}/operationLog`] = null;
            clearPacks[`years/${viewingYear}/settings/deadline`] = null;
            clearPacks[`years/${viewingYear}/settings/notice`] = null;
            clearPacks[`years/${viewingYear}/settings/noticeImage`] = null;
            db.ref().update(clearPacks).then(() => {
                alert('清空完成。');
            });
        }
    }

    window.toggleLogCollapse = function() {
        const wrapper = document.getElementById('admin-logs-wrapper');
        const indicator = document.getElementById('log-arrow-indicator');
        if (wrapper.classList.contains('collapsed')) {
            wrapper.classList.remove('collapsed');
            indicator.textContent = '收起 -';
        } else {
            wrapper.classList.add('collapsed');
            indicator.textContent = '展开 +';
        }
    };

    window.clearOperationLogs = function() {
        if (confirm('确定要清空当前学年的所有日志吗？')) {
            SystemRouter.getLogsRef(viewingYear).remove();
        }
    };

    function bindDynamicGridButtons() {
        document.querySelectorAll('.btn-edit').forEach(b => {
            b.onclick = function() { startEditSlot(this.dataset.id, this.dataset.time); }
        });
        document.querySelectorAll('.btn-delete').forEach(b => {
            b.onclick = function() { deleteSlot(this.dataset.id); }
        });
    }

    // 状态下拉框自由切换
    // 解码 Firebase push ID 中的创建时间戳（前8位为 base64 编码的毫秒时间）
    function decodePushIdTimestamp(pushId) {
        if (!pushId || pushId.length < 8) return null;
        const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
        let timestamp = 0;
        for (let i = 0; i < 8; i++) {
            const idx = PUSH_CHARS.indexOf(pushId.charAt(i));
            if (idx === -1) return null;
            timestamp = timestamp * 64 + idx;
        }
        return timestamp;
    }

    // 手动归档 / 取消归档
    function toggleArchiveReservation(resKey, setArchived) {
        const ref = SystemRouter.getReservationsRef(viewingYear).child(resKey);
        ref.update({ archived: setArchived || null }).then(() => {
            SystemRouter.getLogsRef(viewingYear).push({
                action: setArchived ? '将预约归档到历史' : '将预约移回当前排课',
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
        }).catch(() => { alert('操作失败，请重试。'); });
    }

    function bindArchiveButtons() {
        document.querySelectorAll('.btn-archive-res').forEach(b => {
            b.onclick = function() { toggleArchiveReservation(this.dataset.key, true); };
        });
        document.querySelectorAll('.btn-unarchive-res').forEach(b => {
            b.onclick = function() { toggleArchiveReservation(this.dataset.key, false); };
        });
    }

    function bindStatusDropdownEvents() {
        document.querySelectorAll('.status-select-admin').forEach(select => {
            select.onchange = function() {
                changeReservationStatus(this.dataset.key, this.value, this.dataset.oldstatus);
            };
        });
    }

    // 删除按钮绑定
    // 批量操作
    function updateBatchBar() {
        const checked = document.querySelectorAll('.batch-check-item:checked');
        const bar = document.getElementById('batch-action-bar');
        const countEl = document.getElementById('batch-count');
        if (bar) bar.style.display = checked.length > 0 ? 'flex' : 'none';
        if (countEl) countEl.textContent = checked.length;
    }

    function applyBatchStatus() {
        const checked = document.querySelectorAll('.batch-check-item:checked');
        const newStatus = document.getElementById('batch-target-status').value;
        if (!newStatus) return alert('请选择目标状态！');
        if (checked.length === 0) return alert('请先勾选记录！');

        const statusLabels = { booked: '已预约', confirmed: '已确认', completed: '已完成', canceled: '已取消' };
        if (!confirm(`确定将 ${checked.length} 条记录改为「${statusLabels[newStatus]}」吗？`)) return;

        const updates = {};
        checked.forEach(cb => {
            const key = cb.dataset.key;
            updates[`years/${viewingYear}/reservations/${key}/status`] = newStatus;
        });

        db.ref().update(updates).then(() => {
            SystemRouter.getLogsRef(viewingYear).push({
                action: `批量修改 ${checked.length} 条记录状态为 [${statusLabels[newStatus]}]`,
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
            document.getElementById('batch-target-status').value = '';
        }).catch(() => { alert('操作失败，请重试。'); });
    }

    // 绑定 checkbox 变化和批量按钮
    function bindBatchCheckEvents() {
        document.querySelectorAll('.batch-check-item').forEach(cb => {
            cb.onchange = updateBatchBar;
        });
    }

    function bindDeleteReservationButtons() {
        document.querySelectorAll('.btn-force-del').forEach(b => {
            b.onclick = function() { deleteSingleReservation(this.dataset.key, this.dataset.slotid, this.dataset.name); }
        });
    }

    // 管理端自由切换预约状态
    function changeReservationStatus(resKey, newStatus, oldStatus) {
        if (newStatus === oldStatus) return;
        const statusLabels = { booked: '已预约', confirmed: '已确认', completed: '已完成', canceled: '已取消' };
        const newLabel = statusLabels[newStatus] || newStatus;
        const oldLabel = statusLabels[oldStatus] || oldStatus;

        const updates = {};
        updates[`years/${viewingYear}/reservations/${resKey}/status`] = newStatus;

        // 如果改为已取消，释放排班 slot
        if (newStatus === 'canceled') {
            SystemRouter.getReservationsRef(viewingYear).child(resKey).once('value').then(snap => {
                const r = snap.val();
                if (r && r.slotId) {
                    updates[`years/${viewingYear}/slots/${r.slotId}/reserved`] = false;
                }
                applyStatusUpdate();
            }).catch(() => { alert('读取预约信息失败，请重试。'); });
        } else {
            applyStatusUpdate();
        }

        function applyStatusUpdate() {
            db.ref().update(updates).then(() => {
                SystemRouter.getLogsRef(viewingYear).push({
                    action: `管理员将预约状态从 [${oldLabel}] 改为 [${newLabel}]`,
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                });
                // 更新下拉框颜色
                const selectEl = document.querySelector(`.status-select-admin[data-key="${resKey}"]`);
                if (selectEl) {
                    selectEl.dataset.oldstatus = newStatus;
                    const colors = { booked: '#e6a23c', confirmed: '#409eff', completed: '#67c23a', canceled: '#909399' };
                    selectEl.style.color = colors[newStatus] || '#909399';
                }
            }).catch(() => {
                alert('状态修改失败，请重试。');
                const selectEl = document.querySelector(`.status-select-admin[data-key="${resKey}"]`);
                if (selectEl) selectEl.value = oldStatus;
            });
        }
    }

    document.getElementById('btn-del-notice-img').onclick = function() {
        if (confirm('确定要删除公告图片吗？')) {
            SystemRouter.getSettingsRef(viewingYear).child('noticeImage').remove().then(() => {
                document.getElementById('notice-image-input').value = ''; 
            });
        }
    };

    //原版迁移对账业务逻辑完全予以保留
    window.purgeOldRootNodes = function() {
        if (confirm("高危清理核密防线触发：\n历史数据已被安全平移到 years/2026 树状独立数据库中并对账完毕。\n当前操作将彻底粉碎物理根目录残留的旧版 /slots, /reservations, /settings 节点。\n该操作不可逆，确认清盘？")) {
            const purgePacks = {};
            purgePacks['slots'] = null;
            purgePacks['reservations'] = null;
            purgePacks['settings'] = null;
            
            db.ref().update(purgePacks).then(() => {
                document.getElementById('migration-wizard-panel').style.display = 'none';
            }).catch(err => {
                alert("清理失败，阻断报错: " + err.message);
            });
        }
    };

    function executeDataMigration() {
        const logEl = document.getElementById('migration-log'); 
        logEl.style.color = "#333";
        logEl.textContent = "检查完成，准备迁移...";
        
        db.ref('slots').once('value').then(sSnap => {
            db.ref('reservations').once('value').then(rSnap => {
                db.ref('settings').once('value').then(setSnap => {
                    const oldSlots = sSnap.val() || {}; const oldRes = rSnap.val() || {}; const oldSet = setSnap.val() || {};
                    
                    const oldSlotsStr = JSON.stringify(oldSlots);
                    const oldResStr = JSON.stringify(oldRes);

                    const migrationPacks = {};
                    migrationPacks['years/2026/slots'] = oldSlots;
                    migrationPacks['years/2026/reservations'] = oldRes;
                    migrationPacks['years/2026/settings'] = oldSet;
                    migrationPacks['years/2026/metadata'] = { name: "2026年历史数据", archived: true, schemaVersion: 1 };
                    migrationPacks['system'] = { activeYear: "2026", activeName: "专业课辅导" };

                    db.ref().update(migrationPacks).then(() => {
                        SystemRouter.yearsRoot().child('2026').once('value').then(verifySnap => {
                            const v = verifySnap.val();
                            const newSlotsStr = JSON.stringify(v.slots || {});
                            const newResStr = JSON.stringify(v.reservations || {});
                            
                            if (newSlotsStr === oldSlotsStr && newResStr === oldResStr) {
                                logEl.style.color = "#67c23a";
                                logEl.textContent = `迁移成功，对账一致。可以安全清空扁平老节点了。`;
                                document.getElementById('purge-old-btn').removeAttribute('disabled');
                                document.getElementById('purge-old-btn').style.background = "#f56c6c";
                                document.getElementById('purge-old-btn').textContent = "清除旧版扁平根节点数据";
                            } else {
                                logEl.style.color = "red"; 
                                logEl.textContent = "警告：数据对账不匹配，迁移取消！";
                            }
                        }).catch(err => {
                            logEl.style.color = "red"; logEl.textContent = `读取失败: ${err.message}`;
                        });
                    }).catch(err => {
                        logEl.style.color = "red"; logEl.textContent = `写入被拦截: ${err.message}`;
                    });
                }).catch(err => { logEl.style.color = "red"; logEl.textContent = `读取失败: ${err.message}`; });
            }).catch(err => { logEl.style.color = "red"; logEl.textContent = `读取失败: ${err.message}`; });
        }).catch(err => { logEl.style.color = "red"; logEl.textContent = `读取失败: ${err.message}`; });
    }

    // 注意：escapeHtml 由 config/firebase-env.js 全局提供，此处不再重复定义

    document.getElementById('admin-login-submit').onclick = verifyAdmin;
    document.getElementById('admin-password').onkeypress = (e) => { if (e.key === 'Enter') verifyAdmin(); };
    document.getElementById('admin-year-select').onchange = handleViewingYearChange;
    document.getElementById('btn-set-active').onclick = setAsActiveYear;
    document.getElementById('btn-create-year').onclick = createNewYearNode;
    document.getElementById('btn-set-notice').onclick = setNotice;
    document.getElementById('btn-gen-tpl').onclick = generateDayTemplate;
    document.getElementById('btn-save-tpl').onclick = saveSlotTemplates;
    document.getElementById('btn-batch-apply').onclick = applyBatchStatus;
    document.getElementById('btn-show-stats').onclick = showStudentStats;
    document.getElementById('btn-add-slot').onclick = addSlot;
    document.getElementById('btn-set-deadline').onclick = setDeadline;
    document.getElementById('btn-set-code').onclick = setCode;
    document.getElementById('btn-export-csv').onclick = exportCSV;
    document.getElementById('btn-export-tutor-json').onclick = exportTutorFeeJSON; 
    document.getElementById('btn-clear-year').onclick = clearCurrentYearData;
    document.getElementById('btn-destroy-year').onclick = destroyCurrentYearData; 
    document.getElementById('mgr-start-btn').onclick = executeDataMigration;
    document.getElementById('purge-old-btn').onclick = function() { window.purgeOldRootNodes(); }; 
    document.getElementById('btn-toggle-logs').onclick = toggleLogCollapse;
    document.getElementById('btn-clear-logs').onclick = clearOperationLogs;
    document.getElementById('btn-add-student').onclick = addNewStudentToWhitelist;
    document.getElementById('new-student-name').onkeypress = (e) => { if (e.key === 'Enter') addNewStudentToWhitelist(); };

})();
