// admin.js
(function() {
    let isAdminAuthenticated = false;
    let initialized = false; 
    let dateCollapseState = {};
    let resCollapseState = {};
    let reservationsData = [];
    let studentHoursCache = {};
    let dashboardSlots = {};
    let dashboardReservations = {};
    let dashboardStudentHours = {};
    let viewingYear = "2026";
    const ADMIN_SESSION_KEY = 'admin_session_auth_v2';
    const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;
    const INVALID_FIREBASE_KEY_CHARS = /[.#$\/\[\]\u0000-\u001F\u007F]/;
    let adminLoginFailures = 0;
    let adminLoginBlockedUntil = 0;
    // 「当前排课 / 历史归档」按查看学年动态取分界（7月26日），避免未来学年被旧常量一锅端进当前
    const getGroupCutoff = () => new Date(+viewingYear, 6, 26).getTime();

    function localDateKey(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function dashboardStatusText(status) {
        return { booked: '已预约', confirmed: '已确认', completed: '已完成', canceled: '已取消' }[status] || '未知状态';
    }

    function renderTodayDashboard() {
        const dateEl = document.getElementById('today-dashboard-date');
        const todayEl = document.getElementById('today-course-list');
        const upcomingEl = document.getElementById('upcoming-course-list');
        const warningEl = document.getElementById('today-warning-list');
        if (!dateEl || !todayEl || !upcomingEl || !warningEl) return;

        const now = new Date();
        const todayKey = localDateKey(now);
        const activeYear = String(viewingYear || '');
        const canShowToday = activeYear === String(now.getFullYear());
        dateEl.textContent = canShowToday ? `${activeYear} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日` : `${activeYear} 学年 · 当前设备日期不在本学年`;

        const slotById = dashboardSlots || {};
        const reservations = Object.keys(dashboardReservations || {}).map(key => ({
            key,
            data: dashboardReservations[key]
        })).filter(item => item.data && item.data.status !== 'canceled');
        const parsedItems = reservations.map(item => {
            const parsed = TimeParser.parseRawText(item.data.time, activeYear);
            return { ...item, parsed, date: parsed ? parsed.date : '', start: parsed ? parsed.startTime : '' };
        }).filter(item => item.parsed);
        const todayItems = canShowToday ? parsedItems.filter(item => item.date === todayKey).sort((a, b) => a.start.localeCompare(b.start)) : [];
        const futureEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const futureItems = canShowToday ? parsedItems.filter(item => item.date > todayKey && item.date <= localDateKey(futureEnd)).sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`)).slice(0, 12) : [];
        const feeItems = parsedItems.filter(item => item.data.status === 'completed' && item.data.feeStatus !== 'posted');
        const pendingItems = parsedItems.filter(item => item.data.status === 'booked');

        document.getElementById('today-count').textContent = todayItems.length;
        document.getElementById('today-pending-count').textContent = todayItems.filter(item => item.data.status === 'booked').length;
        document.getElementById('today-fee-count').textContent = feeItems.length;

        const renderCourseItems = (items, showDate) => {
            if (!items.length) return '<p class="today-empty">暂无课程</p>';
            return items.map(item => {
                const status = item.data.status || 'booked';
                const hours = TimeParser.calcHours(item.data.time);
                const datePrefix = showDate ? `${escapeHtml(item.date.slice(5))} ` : '';
                const action = status === 'booked'
                    ? `<button type="button" class="today-confirm-btn" data-key="${escapeHtml(item.key)}">确认</button>`
                    : status === 'confirmed'
                        ? `<button type="button" class="today-complete-btn" data-key="${escapeHtml(item.key)}">完成</button>`
                        : '';
                return `<div class="today-course-item">
                    <div class="today-course-info">
                        <div class="today-course-time">${datePrefix}${escapeHtml(item.parsed.startTime)}–${escapeHtml(item.parsed.endTime)}</div>
                        <div class="today-course-name">${escapeHtml(item.data.nickname || '未填写姓名')}</div>
                        <div class="today-course-meta">${hours.toFixed(2)} 小时 · ${item.data.feeStatus === 'posted' ? '已入账' : status === 'completed' ? '待入账' : '预约'}</div>
                        <span class="today-status today-status-${status}">${dashboardStatusText(status)}</span>
                    </div>
                    <div class="today-course-actions">${action}</div>
                </div>`;
            }).join('');
        };

        todayEl.innerHTML = renderCourseItems(todayItems, false);
        upcomingEl.innerHTML = renderCourseItems(futureItems, true);
        todayEl.querySelectorAll('.today-confirm-btn, .today-complete-btn').forEach(button => {
            button.onclick = async () => {
                const targetStatus = button.classList.contains('today-confirm-btn') ? 'confirmed' : 'completed';
                button.disabled = true;
                try {
                    const result = await updateReservationStatusSafe(viewingYear, button.dataset.key, targetStatus);
                    if (!result.ok) alert('状态更新失败，请刷新后重试。');
                } catch (error) {
                    console.error('今日工作台更新失败:', error);
                    alert('状态更新失败，请检查网络。');
                } finally {
                    button.disabled = false;
                }
            };
        });
        upcomingEl.querySelectorAll('.today-confirm-btn, .today-complete-btn').forEach(button => {
            button.onclick = async () => {
                const targetStatus = button.classList.contains('today-confirm-btn') ? 'confirmed' : 'completed';
                button.disabled = true;
                try { await updateReservationStatusSafe(viewingYear, button.dataset.key, targetStatus); }
                catch (error) { alert('状态更新失败，请检查网络。'); }
                finally { button.disabled = false; }
            };
        });

        const warnings = [];
        Object.keys(slotById).forEach(slotId => {
            const slot = slotById[slotId];
            if (slot && slot.reserved && slot.reservationId && !dashboardReservations[slot.reservationId]) {
                warnings.push(`排班 ${slot.time || slotId} 显示已占用，但找不到对应预约。`);
            }
        });
        feeItems.slice(0, 5).forEach(item => warnings.push(`${item.data.nickname || '未填写姓名'} 的已完成课程尚未入账。`));
        const usedByStudent = {};
        parsedItems.forEach(item => {
            const name = item.data.nickname || '未填写姓名';
            usedByStudent[name] = (usedByStudent[name] || 0) + TimeParser.calcHours(item.data.time);
        });
        Object.keys(usedByStudent).forEach(name => {
            const total = Number(dashboardStudentHours[name]);
            if (Number.isFinite(total) && total > 0 && usedByStudent[name] > total + 0.001) warnings.push(`${name} 已预约 ${usedByStudent[name].toFixed(2)} 小时，超过总课时 ${total.toFixed(2)} 小时。`);
        });
        if (!canShowToday && !futureItems.length) warnings.push('当前查看学年不是设备当前年份，今日工作台暂不显示日期课程。');
        document.getElementById('today-warning-count').textContent = warnings.length;
        warningEl.innerHTML = warnings.length ? warnings.slice(0, 8).map(text => `<div class="today-warning-item">${escapeHtml(text)}</div>`).join('') : '<p class="today-empty">暂无异常</p>';
    }

    let currentActiveSlotsRefMemory = null;
    let currentActiveReservationsRefMemory = null;
    let currentActiveLogsRefMemory = null;
    let currentActiveNoticeTextRefMemory = null;
    let currentActiveNoticeImgRefMemory = null;
    let currentActiveStudentListRefMemory = null;
    let currentActiveStudentHoursRefMemory = null;
    let currentActiveDeadlineRefMemory = null;
    let currentActiveAccessCodeRefMemory = null;

    function isValidStudentName(name) {
        return typeof name === 'string' && name.length > 0 && name.length <= 50 && !INVALID_FIREBASE_KEY_CHARS.test(name) && !name.includes(',');
    }

    function generateSecureCode(length) {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
    }

    function inlineArg(value) {
        return escapeHtml(JSON.stringify(String(value ?? '')));
    }

    function registerAdminLoginFailure(errorEl) {
        adminLoginFailures++;
        if (adminLoginFailures >= 5) {
            adminLoginFailures = 0;
            adminLoginBlockedUntil = Date.now() + 30 * 1000;
            errorEl.textContent = '尝试过多，请 30 秒后重试。';
        } else {
            errorEl.textContent = '密码错误！';
        }
    }

    // 核验成功后只向当前标签页签发 30 分钟会话标记，供教师端无感通行。
    function verifyAdmin() {
        const inputPass = document.getElementById('admin-password').value.trim();
        const errorEl = document.getElementById('login-error');
        if (Date.now() < adminLoginBlockedUntil) {
            errorEl.textContent = `尝试过多，请 ${Math.ceil((adminLoginBlockedUntil - Date.now()) / 1000)} 秒后重试。`;
            return;
        }
        if (!inputPass) return alert('请输入密码！');
        if (inputPass.length > 128 || INVALID_FIREBASE_KEY_CHARS.test(inputPass)) return errorEl.textContent = '密码格式不合法。';

        db.ref(`admin_auth/${inputPass}`).once('value').then((snapshot) => {
            if (snapshot.exists() && snapshot.val() === true) {
                adminLoginFailures = 0;
                localStorage.removeItem('admin_session_auth');
                sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({ expiresAt: Date.now() + ADMIN_SESSION_TTL_MS }));

                isAdminAuthenticated = true; 
                document.getElementById('admin-login').style.display = 'none';
                document.getElementById('admin-content').style.display = 'block';
                initAdminSystem();
            } else {
                registerAdminLoginFailure(errorEl);
            }
        }).catch(error => {
            if (String(error && error.code || '').toUpperCase().includes('PERMISSION_DENIED')) registerAdminLoginFailure(errorEl);
            else errorEl.textContent = '网络错误，请检查连接后重试。';
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
            const savedVal = selectEl.value || viewingYear || SystemRouter.activeYear || "2026";
            selectEl.innerHTML = '';

            const yearKeys = data ? Object.keys(data).filter(y => /^\d{4}$/.test(y)).sort().reverse() : [];
            if (yearKeys.length > 0) {
                yearKeys.forEach(y => {
                    const opt = document.createElement('option'); opt.value = y;
                    const name = (data[y].metadata && data[y].metadata.name) ? data[y].metadata.name : `${y}学年`;
                    const suffix = (y === SystemRouter.activeYear) ? " [当前]" : "";
                    opt.textContent = name + suffix; selectEl.appendChild(opt);
                });
                selectEl.value = data[savedVal] ? savedVal : yearKeys[0];
            } else {
                const opt = document.createElement('option'); opt.value = "2026"; opt.textContent = "2026学年 [当前]"; selectEl.appendChild(opt);
            }
            updateStatusTextInfo();
            handleViewingYearChange();
        });

        SystemRouter.system().on('value', (snap) => {
            if (!isAdminAuthenticated) return;
            const sys = snap.val();
            if (sys && /^\d{4}$/.test(String(sys.activeYear || ''))) {
                SystemRouter.activeYear = sys.activeYear; SystemRouter.activeName = sys.activeName;
                updateStatusTextInfo();
                // 刷新下拉框标签（[当前开放学年] vs [历史归档]）
                refreshYearDropdownLabels();
            }
        });

        handleViewingYearChange();
    }

    function refreshYearDropdownLabels() {
        const selectEl = document.getElementById('admin-year-select');
        if (!selectEl) return;
        Array.from(selectEl.options).forEach(opt => {
            const y = opt.value;
            const isActive = y === SystemRouter.activeYear;
            const baseName = opt.textContent.replace(' [当前]', '').replace(' [历史]', '');
            opt.textContent = baseName + (isActive ? ' [当前]' : '');
        });
    }

    function updateStatusTextInfo() {
        const bar = document.getElementById('year-status-bar');
        if (bar) bar.innerHTML = `当前对学生开放的学年是：<span class="text-blue text-bold">${escapeHtml(SystemRouter.activeName)} (${SystemRouter.activeYear || '2026'}年)</span>`;
    }

    function handleViewingYearChange(forceYear) {
        if (!isAdminAuthenticated) return;
        const selectEl = document.getElementById('admin-year-select');
        // forceYear 仅当程序化传入了字符串年份才生效（onchange 事件传的是 Event 对象）
        if (typeof forceYear === 'string') {
            viewingYear = forceYear;
            if (selectEl) selectEl.value = forceYear;
        } else if (selectEl && selectEl.value) {
            viewingYear = selectEl.value;
        }

        if (currentActiveSlotsRefMemory) currentActiveSlotsRefMemory.off();
        if (currentActiveReservationsRefMemory) currentActiveReservationsRefMemory.off();
        if (currentActiveLogsRefMemory) currentActiveLogsRefMemory.off();
        if (currentActiveNoticeTextRefMemory) currentActiveNoticeTextRefMemory.off();
        if (currentActiveNoticeImgRefMemory) currentActiveNoticeImgRefMemory.off();
        if (currentActiveStudentListRefMemory) currentActiveStudentListRefMemory.off();
        if (currentActiveStudentHoursRefMemory) currentActiveStudentHoursRefMemory.off();
        if (currentActiveDeadlineRefMemory) currentActiveDeadlineRefMemory.off();
        if (currentActiveAccessCodeRefMemory) currentActiveAccessCodeRefMemory.off();

        currentActiveSlotsRefMemory = SystemRouter.getSlotsRef(viewingYear);
        currentActiveReservationsRefMemory = SystemRouter.getReservationsRef(viewingYear);
        currentActiveLogsRefMemory = SystemRouter.getLogsRef(viewingYear).orderByChild('timestamp').limitToLast(60);
        currentActiveNoticeTextRefMemory = SystemRouter.getSettingsRef(viewingYear).child('notice');
        currentActiveNoticeImgRefMemory = SystemRouter.getSettingsRef(viewingYear).child('noticeImage');
        currentActiveStudentListRefMemory = db.ref(`years/${viewingYear}/studentWhitelist`);
        currentActiveStudentHoursRefMemory = db.ref(`years/${viewingYear}/studentHours`);
        currentActiveDeadlineRefMemory = SystemRouter.getSettingsRef(viewingYear).child('deadline');
        currentActiveAccessCodeRefMemory = SystemRouter.getSettingsRef(viewingYear).child('accessCode');
        dashboardSlots = {};
        dashboardReservations = {};
        dashboardStudentHours = {};
        renderTodayDashboard();

        currentActiveNoticeTextRefMemory.on('value', snap => {
            const noticeInput = document.getElementById('notice-input');
            if (noticeInput) noticeInput.value = snap.val() || '';
        });

        currentActiveNoticeImgRefMemory.on('value', snap => {
            const imgData = snap.val();
            const btnDelImg = document.getElementById('btn-del-notice-img');
            const previewContainer = document.getElementById('notice-img-preview-container');
            const previewImg = document.getElementById('notice-img-preview');
            
            const safeImgData = typeof imgData === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(imgData) && imgData.length <= 4 * 1024 * 1024 ? imgData : '';
            if (safeImgData) {
                if(previewImg) previewImg.src = safeImgData;
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
            if (deadlineInput && snap.val()) deadlineInput.value = snap.val();
        });

        currentActiveAccessCodeRefMemory.on('value', snap => {
            const codeInput = document.getElementById('code-input');
            if (codeInput && snap.val()) codeInput.value = snap.val();
        });

        loadSlotTemplates();

        let currentStudentList = null;
        studentHoursCache = {};

        function renderWhitelist() {
            const container = document.getElementById('admin-student-whitelist-container');
            if (!container) return;
            container.innerHTML = '';
            if (!currentStudentList || Object.keys(currentStudentList).length === 0) {
                container.innerHTML = '<span class="text-gray" style="font-size:13px;">当前学年未录入准入学生，任何人都无法提交预约。</span>';
                return;
            }
            Object.keys(currentStudentList).forEach(sId => {
                const sName = currentStudentList[sId];
                const total = studentHoursCache[sName];
                const hasHours = total !== undefined && total !== null && Number(total) > 0;
                const hoursText = `<span class="student-tag-hours ${hasHours ? '' : 'tag-hours-none'}" data-name="${escapeHtml(sName)}" title="点击修改总时长">(${hasHours ? Number(total) + 'h' : '未设'})</span>`;
                const tag = document.createElement('span');
                tag.className = 'student-tag';
                tag.innerHTML = `<span class="student-tag-name" data-name="${escapeHtml(sName)}" title="双击修改总时长">${escapeHtml(sName)}</span>${hoursText}<span class="student-tag-del" data-id="${escapeHtml(sId)}" data-name="${escapeHtml(sName)}">×</span>`;
                container.appendChild(tag);
            });

            document.querySelectorAll('.student-tag-del').forEach(btn => {
                btn.onclick = function() {
                    const id = this.dataset.id; const name = this.dataset.name;
                    if(confirm(`确定将 [${name}] 从当前学年准入名单中移除吗？`)) {
                        const updates = {};
                        updates[`years/${viewingYear}/studentWhitelist/${id}`] = null;
                        updates[`years/${viewingYear}/studentHours/${name}`] = null;
                        db.ref().update(updates).then(() => {
                            SystemRouter.getLogsRef(viewingYear).push({
                                action: `移除了准入学生：[${name}]`, timestamp: firebase.database.ServerValue.TIMESTAMP
                            });
                        }).catch(() => alert('移除失败，请重试。'));
                    }
                };
            });

            document.querySelectorAll('.student-tag-hours').forEach(span => {
                span.onclick = function() { editStudentHours(this.dataset.name); };
            });

            document.querySelectorAll('.student-tag-name').forEach(span => {
                span.ondblclick = function() { editStudentHours(this.dataset.name); };
            });
        }

        // 修改同学总时长：双击名字或点 (XXh)，弹窗内显示历史课时供参考
        function editStudentHours(name) {
            const current = studentHoursCache[name];
            const totalNow = (current !== undefined && current !== null && Number(current) > 0) ? Number(current) : 0;

            // 从本学年预约记录缓存中统计该同学的已用/已完成课时
            let usedHours = 0, completedHours = 0;
            reservationsData.forEach(r => {
                if (!r || r.nickname !== name || r.status === 'canceled') return;
                const h = TimeParser.calcHours(r.time);
                usedHours += h;
                if (r.status === 'completed') completedHours += h;
            });

            const infoLines = [`当前总时长：${totalNow > 0 ? totalNow + ' 小时' : '未设置'}`];
            if (usedHours > 0 || completedHours > 0) {
                infoLines.push(`本学年已用：${usedHours.toFixed(2)} 小时${completedHours > 0 ? `（其中已完成 ${completedHours.toFixed(2)} 小时）` : ''}`);
            } else {
                infoLines.push('本学年暂无课时记录');
            }

            const raw = prompt(
                `设置 [${name}] 的总时长（小时），留空或填 0 表示不限制：\n\n${infoLines.join('\n')}`,
                totalNow > 0 ? totalNow : ''
            );
            if (raw === null) return;
            const v = parseFloat(raw);
            const hoursRef = db.ref(`years/${viewingYear}/studentHours/${name}`);
            if (isNaN(v) || v <= 0) {
                hoursRef.remove().then(() => {
                    SystemRouter.getLogsRef(viewingYear).push({
                        action: `清除了学生 [${name}] 的总时长限制`, timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                });
            } else {
                hoursRef.set(v).then(() => {
                    SystemRouter.getLogsRef(viewingYear).push({
                        action: `设置学生 [${name}] 总时长为 ${v} 小时`, timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                });
            }
        }

        currentActiveStudentHoursRefMemory.on('value', (snap) => {
            studentHoursCache = snap.val() || {};
            dashboardStudentHours = studentHoursCache;
            renderWhitelist();
            renderTodayDashboard();
        });

        currentActiveStudentListRefMemory.on('value', (snapshot) => {
            currentStudentList = snapshot.val() || null;
            renderWhitelist();
        });

        currentActiveSlotsRefMemory.on('value', (snapshot) => {
            const slots = snapshot.val(); const container = document.getElementById('admin-slots-container');
            dashboardSlots = slots || {};
            renderTodayDashboard();
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
                            <button class="btn-edit slot-edit-btn" data-id="${escapeHtml(item.id)}" data-time="${escapeHtml(item.data.time)}">修改</button>
                            <button class="btn-delete danger" data-id="${escapeHtml(item.id)}">删除</button>
                        </div>`;
                    body.appendChild(slotDiv);
                });
                dateGroupDiv.appendChild(header); dateGroupDiv.appendChild(body); container.appendChild(dateGroupDiv);
            });
            bindDynamicGridButtons();
        });

        currentActiveReservationsRefMemory.on('value', (snapshot) => {
            const res = snapshot.val(); const container = document.getElementById('admin-reservations-container');
            dashboardReservations = res || {};
            renderTodayDashboard();

            container.innerHTML = '';
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
                    groupKey = (lessonTs !== null && lessonTs >= getGroupCutoff()) ? '当前排课' : '历史归档';
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

                    let selectHtml = `<select class="status-select-admin" data-key="${escapeHtml(item.key)}" data-oldstatus="${escapeHtml(currentStatus)}" style="color:${statusColor};">`;
                    statusOptions.forEach(opt => {
                        selectHtml += `<option value="${opt.val}" ${opt.val === currentStatus ? 'selected' : ''} style="color:${opt.color};">${opt.label}</option>`;
                    });
                    selectHtml += '</select>';

                    let archiveBtnHtml = '';
                    if (isCurrent) {
                        archiveBtnHtml = `<button class="btn-archive btn-archive-res" data-key="${escapeHtml(item.key)}">归档</button>`;
                    } else if (r.archived) {
                        archiveBtnHtml = `<button class="btn-unarchive btn-unarchive-res" data-key="${escapeHtml(item.key)}">移回当前</button>`;
                    }

                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td><input type="checkbox" class="batch-check-item" data-key="${escapeHtml(item.key)}"></td><td>${escapeHtml(r.time)}</td>
                        <td><span class="editable-name" data-key="${escapeHtml(item.key)}" data-oldname="${escapeHtml(r.nickname)}"><b>${escapeHtml(r.nickname || '不详')}</b></span></td>
                        <td>${selectHtml}</td><td>${escapeHtml(r.cancelCode || '-')}</td>
                        <td>${archiveBtnHtml}<button class="danger btn-force-del" data-key="${escapeHtml(item.key)}" data-slotid="${escapeHtml(r.slotId || '')}" data-name="${escapeHtml(r.nickname || '未定')}">删除</button></td>`;
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
                    const cleanName = newName.trim();
                    if (!isValidStudentName(cleanName)) return alert('姓名格式不合法（最多50字，不能包含逗号或路径特殊字符）！');
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
        const hoursInput = document.getElementById('new-student-hours');
        if(!name) return alert('请输入名字！');
        if (!isValidStudentName(name)) return alert('姓名格式不合法（最多50字，不能包含逗号或路径特殊字符）！');
        const hoursRaw = hoursInput ? hoursInput.value.trim() : '';
        const parsedHours = hoursRaw === '' ? null : parseFloat(hoursRaw);
        const validHours = parsedHours !== null && !isNaN(parsedHours) && parsedHours > 0;

        db.ref(`years/${viewingYear}/studentWhitelist`).once('value').then(snap => {
            const exist = snap.val() || {}; const isDup = Object.values(exist).some(v => v === name);
            if(isDup) return alert('该同学已经在名单中了！');

            const studentKey = db.ref(`years/${viewingYear}/studentWhitelist`).push().key;
            const updates = {};
            updates[`years/${viewingYear}/studentWhitelist/${studentKey}`] = name;
            if (validHours) updates[`years/${viewingYear}/studentHours/${name}`] = parsedHours;
            db.ref().update(updates).then(() => {
                SystemRouter.getLogsRef(viewingYear).push({
                    action: `新增准入白名单学生：[${name}]${validHours ? `，总时长 ${parsedHours} 小时` : ''}`, timestamp: firebase.database.ServerValue.TIMESTAMP
                });
                input.value = '';
                if (hoursInput) hoursInput.value = '';
            }).catch(() => alert('新增学生失败，请重试。'));
        });
    }

    // 显示/隐藏每学生课时统计
    function showStudentStats() {
        const panel = document.getElementById('stats-panel');
        // 已展开则收起
        if (panel.classList.contains('show')) {
            panel.classList.remove('show');
            panel.style.display = 'none';
            return;
        }
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
            <tr style="background:#f5f7fa;"><th>学生</th><th>已完成/总时长(h)</th><th>已确认</th><th>已预约</th><th>已取消</th><th>总次数</th></tr>`;
        sorted.forEach(([name, s]) => {
            const totalHours = studentHoursCache[name];
            const hasTotal = totalHours !== undefined && totalHours !== null && Number(totalHours) > 0;
            const completedCell = hasTotal ? `${s.completed.toFixed(2)}/${Number(totalHours)}` : `${s.completed.toFixed(2)}<span class="text-gray">/未设</span>`;
            html += `<tr><td><b>${escapeHtml(name)}</b></td>
                <td><span class="text-green text-bold">${completedCell}</span></td>
                <td>${s.confirmed}</td><td>${s.booked}</td>
                <td class="text-gray">${s.canceled}</td><td>${s.total}</td></tr>`;
        });
        html += '</table>';
        panel.innerHTML = html;
        panel.style.display = 'block';
        panel.classList.add('show');
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
            
            const hours = TimeParser.calcHours(r.time);
            if (hours > 0) calculatedHours = hours;

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
                    <button class="btn-edit slot-edit-btn" data-id="${escapeHtml(slotId)}" data-time="${escapeHtml(slot.time)}">修改</button>
                    <button class="btn-delete danger" data-id="${escapeHtml(slotId)}">删除</button>
                </div>`;
            bindDynamicGridButtons();
        });
    }

    function startEditSlot(slotId, currentTime) {
        const row = document.getElementById(`slot-row-${slotId}`);
        row.innerHTML = `<input type="text" class="edit-input" id="edit-input-${slotId}" value="${escapeHtml(currentTime)}">
            <div class="btn-group">
                <button class="slot-save-btn" onclick="saveEditedSlot(${inlineArg(slotId)})">保存</button>
                <button class="slot-cancel-btn" onclick="cancelEditSlot(${inlineArg(slotId)})">取消</button>
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

            return SystemRouter.getReservationsRef(viewingYear).once('value').then((resSnap) => {
                const reservations = resSnap.val() || {};
                const batchUpdates = {};
                batchUpdates[`years/${viewingYear}/slots/${slotId}/time`] = validationParser.formattedSlotText;
                Object.keys(reservations).forEach(resKey => {
                    if (reservations[resKey] && reservations[resKey].slotId === slotId) {
                        batchUpdates[`years/${viewingYear}/reservations/${resKey}/time`] = validationParser.formattedSlotText;
                        batchUpdates[`years/${viewingYear}/reservations/${resKey}/slotSnapshot`] = validationParser;
                    }
                });
                return db.ref().update(batchUpdates);
            }).then(() => {
                SystemRouter.getLogsRef(viewingYear).push({ action: `修改排班时间并同步了历史预约 -> ${validationParser.formattedSlotText}`, timestamp: firebase.database.ServerValue.TIMESTAMP });
            }).catch(() => alert('修改排班失败，请重试。'));
        }).catch(() => alert('读取排班失败，请重试。'));
    };

    function setNotice() {
        const noticeText = document.getElementById('notice-input').value;
        const fileInput = document.getElementById('notice-image-input'); const file = fileInput.files[0];
        const targetRef = SystemRouter.getSettingsRef(viewingYear);

        if (file) {
            if (file.size > 8 * 1024 * 1024) return alert('公告图片过大，最多允许 8 MB。');
            const reader = new FileReader(); reader.onload = function(e) {
                const img = new Image(); img.onload = function() {
                    const canvas = document.createElement('canvas'); let width = img.width; let height = img.height;
                    const MAX_WIDTH = 600; if (width > MAX_WIDTH) { height = Math.round((height * MAX_WIDTH) / width); width = MAX_WIDTH; }
                    canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
                    const compressedBase64 = canvas.toDataURL('image/jpeg', 0.6);
                    targetRef.update({ notice: noticeText, noticeImage: compressedBase64 }).then(() => { fileInput.value = ''; }).catch(() => { alert('公告保存失败，请重试。'); });
                }; img.src = e.target.result;
            }; reader.readAsDataURL(file);
        } else { targetRef.child('notice').set(noticeText).catch(() => { alert('公告保存失败，请重试。'); }); }
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
        SystemRouter.getSettingsRef(viewingYear).child('slotTemplates').set(templates).catch(() => { alert('保存失败。'); });
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
            const existData = snap.val() || {}; const atomicUpdates = {}; const plannedTimes = new Set(); let okCount = 0; let failCount = 0;
            templates.forEach(t => {
                const rawCheck = `${prefix} ${t}`;
                const normalizedParser = TimeParser.parseRawText(rawCheck, viewingYear);
                if (!normalizedParser) return;

                const normalizedTime = normalizedParser.formattedSlotText;
                const isDup = plannedTimes.has(normalizedTime) || Object.values(existData).some(s => s.time === normalizedTime && s.status !== "hidden");
                if (isDup) { failCount++; } else {
                    plannedTimes.add(normalizedTime);
                    okCount++; 
                    const newKey = SystemRouter.getSlotsRef(viewingYear).push().key; 
                    atomicUpdates[`years/${viewingYear}/slots/${newKey}`] = { time: normalizedParser.formattedSlotText, reserved: false, status: "active" };
                }
            });
            
            if (okCount === 0) return alert('这些时间段都已经存在了。');
            
            if (confirm('确定要批量添加排班吗？')) {
                db.ref().update(atomicUpdates).then(() => {
                    SystemRouter.getLogsRef(viewingYear).push({ action: `批量新增了 ${okCount} 个排班`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                    document.getElementById('template-date').value = "";
                }).catch(() => {
                    alert('批量排班失败，请重试。');
                });
            }
        });
    }

    function deleteSlot(slotId) {
        if (confirm('确定要删除这个排班吗？')) {
            const slotRef = SystemRouter.getSlotsRef(viewingYear).child(slotId);
            // 先以事务写入 hidden，阻止学生端在“读取后删除”窗口内抢到该时段。
            slotRef.transaction(slot => {
                if (!slot) return slot;
                slot.status = "hidden";
                return slot;
            }, (err, committed) => {
                if (err || !committed) return alert(err ? '操作失败，请重试。' : '该排班已不存在。');
                slotRef.once('value').then(snapshot => {
                    const slot = snapshot.val();
                    if (slot && slot.reserved) {
                        SystemRouter.getLogsRef(viewingYear).push({ action: `隐藏已预约的排班: [${slot.time}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                        alert('由于已有学生预约，该时段已在学生端隐藏。');
                    } else {
                        slotRef.remove().then(() => {
                            SystemRouter.getLogsRef(viewingYear).push({ action: `删除排班: [${slot && slot.time ? slot.time : slotId}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                        }).catch(() => alert('删除失败，请重试。'));
                    }
                }).catch(() => alert('读取排班信息失败，请重试。'));
            });
        }
    }

    function releaseSlotIfOwned(year, slotId, reservationId) {
        if (!slotId) return Promise.resolve({ committed: true, legacy: false });
        return SystemRouter.getSlotsRef(year).child(slotId).transaction(slot => {
            // 旧排班没有所有权标记时不自动释放，避免把别人的预约重新开放。
            if (!slot || !slot.reserved || slot.reservationId !== reservationId) return;
            slot.reserved = false;
            delete slot.reservationId;
            return slot;
        });
    }

    function reserveSlotForReservation(year, slotId, reservationId) {
        if (!slotId) return Promise.resolve({ committed: false, reason: 'missing-slot' });
        return SystemRouter.getSlotsRef(year).child(slotId).transaction(slot => {
            if (!slot || slot.status === 'hidden') return;
            if (slot.reserved && slot.reservationId !== reservationId) return;
            slot.reserved = true;
            slot.reservationId = reservationId;
            return slot;
        });
    }

    // 所有状态变化都经过所有权校验，避免取消一条旧记录时释放后来者的时段。
    async function updateReservationStatusSafe(year, resKey, newStatus) {
        const reservationRef = SystemRouter.getReservationsRef(year).child(resKey);
        const snapshot = await reservationRef.once('value');
        const reservation = snapshot.val();
        if (!reservation) return { ok: false, reason: 'missing' };
        const oldStatus = reservation.status || 'booked';
        if (oldStatus === newStatus) {
            if (newStatus !== 'canceled') return { ok: true, changed: false };
            const released = await releaseSlotIfOwned(year, reservation.slotId, resKey);
            return { ok: true, changed: false, slotConflict: !!reservation.slotId && !released.committed };
        }

        if (newStatus === 'canceled') {
            const result = await reservationRef.transaction(current => {
                if (!current || current.status === 'canceled') return;
                current.status = 'canceled';
                return current;
            });
            if (!result.committed) return { ok: false, reason: 'stale' };
            const released = await releaseSlotIfOwned(year, reservation.slotId, resKey);
            return { ok: true, changed: true, slotConflict: !!reservation.slotId && !released.committed };
        }

        if (oldStatus === 'canceled') {
            const reserved = await reserveSlotForReservation(year, reservation.slotId, resKey);
            if (!reserved.committed) return { ok: false, reason: reserved.reason || 'slot-conflict' };
            try {
                const result = await reservationRef.transaction(current => {
                    if (!current || current.status !== 'canceled') return;
                    current.status = newStatus;
                    return current;
                });
                if (!result.committed) {
                    await releaseSlotIfOwned(year, reservation.slotId, resKey);
                    return { ok: false, reason: 'stale' };
                }
            } catch (e) {
                await releaseSlotIfOwned(year, reservation.slotId, resKey).catch(() => {});
                throw e;
            }
            return { ok: true, changed: true };
        }

        const result = await reservationRef.transaction(current => {
            // 快照读取后学生可能刚好取消；此分支不能绕过“重新占用排班”的流程复活预约。
            if (!current || current.status === 'canceled' || current.status === newStatus) return;
            current.status = newStatus;
            return current;
        });
        return { ok: result.committed, changed: result.committed };
    }

    function deleteSingleReservation(resKey, slotId, nickname) {
        if (!confirm(`确定要删除 ${nickname} 的预约记录吗？`)) return;
        updateReservationStatusSafe(viewingYear, resKey, 'canceled').then(result => {
            if (!result.ok) {
                alert(result.reason === 'slot-conflict' ? '该时段已被其他预约占用，未删除记录，请先处理冲突。' : '删除失败，请重试。');
                throw { silent: true };
            }
            if (result.slotConflict) {
                alert('预约已标记为取消，但排班所有权异常，记录暂不删除，请先修复排班。');
                throw { silent: true };
            }
            return SystemRouter.getReservationsRef(viewingYear).child(resKey).remove();
        }).then(() => {
            SystemRouter.getLogsRef(viewingYear).push({ action: `删除了学生的预约记录: [${nickname}]`, timestamp: firebase.database.ServerValue.TIMESTAMP });
        }).catch((err) => {
            if (err && err.silent) return;
            console.error('删除预约记录失败:', err);
            alert('删除失败，请重试。');
        });
    }

    function setAsActiveYear() {
        const targetY = document.getElementById('admin-year-select').value; if (!targetY) return;
        if (confirm(`确定要把 ${targetY} 设为当前对学生开放的学年吗？`)) {
            const customName = prompt("请输入学生端显示的标题：", `${targetY}级硕士专业课辅导`);
            if (!customName) return alert('标题不能为空。');
            
            SystemRouter.system().update({ activeYear: targetY, activeName: customName }).then(() => {
                SystemRouter.getLogsRef(targetY).push({ action: `将本学年设为当前开放学年`, timestamp: firebase.database.ServerValue.TIMESTAMP });
            });
        }
    }

    function createNewYearNode() {
        const newY = prompt("请输入要新建的4位年份（如 2027 ）：");
        if (!newY || !/^\d{4}$/.test(newY)) return alert('请输入4位数字的年份！');
        
        SystemRouter.yearsRoot().child(newY).once('value').then(snap => {
            if (snap.exists()) return alert('该学年已经存在！');
            
            const secureRandomCode = generateSecureCode(6);
            const initTitleName = `${newY}级硕士专业课辅导`;
            const initialPack = {};
            
            initialPack[`years/${newY}/metadata`] = { name: initTitleName, archived: false, schemaVersion: 2, createdAt: firebase.database.ServerValue.TIMESTAMP };
            initialPack[`years/${newY}/settings/accessCode`] = secureRandomCode; 

            db.ref().update(initialPack).then(() => {
                SystemRouter.getLogsRef(newY).push({ action: `新建了学年，初始口令: ${secureRandomCode}`, timestamp: firebase.database.ServerValue.TIMESTAMP });
                handleViewingYearChange(newY);
            });
        });
    }

    function setDeadline() {
        const d = document.getElementById('deadline-input').value; if (!d) return alert('请选择时间');
        SystemRouter.getSettingsRef(viewingYear).update({ deadline: d }).catch(() => alert('保存失败，请重试。'));
    }
    function setCode() {
        const c = document.getElementById('code-input').value.trim(); if (!c) return alert('口令不能为空');
        if (c.length > 128) return alert('口令不能超过128个字符');
        SystemRouter.getSettingsRef(viewingYear).update({ accessCode: c }).catch(() => alert('保存失败，请重试。'));
    }

    window.destroyCurrentYearData = function() {
        if (viewingYear === SystemRouter.activeYear) {
            return alert('不能删除正在对外开放的学年！\n如需删除，请先将其他学年设为【当前开放学年】。');
        }
        
        const confirmMsg = prompt(`确定要彻底删除 ${viewingYear} 学年吗？这会清空该学年的所有数据！\n请输入 ${viewingYear} 确认：`);
        
        if (confirmMsg === viewingYear) {
            db.ref(`years/${viewingYear}`).remove().then(() => {
                handleViewingYearChange(SystemRouter.activeYear || '2026');
            }).catch(err => { alert('删除失败：' + err.message); });
        } else if (confirmMsg !== null) {
            alert('输入不匹配，已取消删除。');
        }
    };

    function exportCSV() {
        if (reservationsData.length === 0) return alert('没有数据可导出');
        const sorted = [...reservationsData].sort((a,b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        const csvCell = value => {
            let text = String(value ?? '');
            if (/^[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
        };

        let csvContent = "\"预约时段\",\"学生姓名\",\"状态\",\"取消凭证\",\"提交时间\"\n";
        sorted.forEach(r => {
            let textS = r.status || "booked";
            switch(textS) {
                case "booked": textS = "已预约"; break; case "confirmed": textS = "已确认"; break;
                case "canceled": textS = "已取消"; break; case "completed": textS = "已完成"; break;
            }
            // 统一格式化为标准日期
            let timeDisplay = r.time || '';
            const p = TimeParser.parseRawText(r.time, viewingYear);
            if (p) timeDisplay = `${p.date} ${p.startTime}-${p.endTime}`;
            const readableSubmitTime = r.timestamp ? new Date(r.timestamp).toLocaleString() : "未知";
            csvContent += [timeDisplay, r.nickname || '不详', textS, r.cancelCode || '-', readableSubmitTime].map(csvCell).join(',') + '\n';
        });
        
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
        
        const link = document.createElement("a"); 
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.setAttribute("download", `预约数据_${viewingYear}.csv`);
        document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
    }

    // 导出整个数据库备份（system + 所有学年数据），用于本地留档/迁移
    function exportAllDataJSON() {
        Promise.all([db.ref('system').once('value'), db.ref('years').once('value')]).then(([sSnap, ySnap]) => {
            const pkg = {
                source: "class_optic_full_backup",
                exportedAt: new Date().toLocaleString(),
                system: sSnap.val() || null,
                years: ySnap.val() || null
            };
            const dataStr = JSON.stringify(pkg, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `预约系统全量备份_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(link); link.click(); document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }).catch(err => alert('导出失败：' + err.message));
    }

    function triggerRestoreFile() {
        document.getElementById('restore-file-input').click();
    }

    // 从全量备份 JSON 还原（覆盖 system 与 years；按学年逐节点写入以兼容当前安全规则）
    document.getElementById('restore-file-input').onchange = function(e) {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 64 * 1024 * 1024) return alert('备份文件过大，最多允许 64 MB。');
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const parsed = JSON.parse(evt.target.result);
                if (parsed.source !== "class_optic_full_backup") return alert('这不是本系统的全量备份文件。');
                if (parsed.years !== undefined && (!parsed.years || typeof parsed.years !== 'object' || Array.isArray(parsed.years))) return alert('备份中的学年数据格式不合法。');
                const backupYears = Object.keys(parsed.years || {});
                if (backupYears.some(y => !/^\d{4}$/.test(y))) return alert('备份包含非法学年键。');
                const hasSystem = parsed.system !== undefined && parsed.system !== null;
                if (backupYears.length === 0 && !hasSystem) return alert('备份文件中没有可还原的数据。');
                if (!confirm(`还原将覆盖数据库中当前的 system 与全部学年数据（备份含 ${backupYears.length} 个学年），不可撤销！\n\n请确认你已先导出当前数据备份。继续？`)) return;

                db.ref('years').once('value').then(ySnap => {
                    const restoreUpdates = {};
                    // 删除备份中不存在的学年
                    Object.keys(ySnap.val() || {}).filter(y => !backupYears.includes(y)).forEach(y => {
                        restoreUpdates[`years/${y}`] = null;
                    });
                    // 写入备份中的学年
                    backupYears.forEach(y => { restoreUpdates[`years/${y}`] = parsed.years[y]; });
                    if (hasSystem) restoreUpdates.system = parsed.system;
                    // 单次多路径更新，避免 Promise.all 造成“恢复一半”的混合数据库。
                    return db.ref().update(restoreUpdates);
                }).then(() => {
                    alert('还原完成。');
                }).catch(err => alert('还原失败：' + err.message));
            } catch (err) {
                alert('解析失败：' + err.message);
            }
        };
        reader.readAsText(file);
    };

    function clearCurrentYearData() {
        if (confirm('确定要清空当前年份的所有排班和单据吗？')) {
            const clearPacks = {};
            clearPacks[`years/${viewingYear}/slots`] = null;
            clearPacks[`years/${viewingYear}/reservations`] = null;
            clearPacks[`years/${viewingYear}/operationLog`] = null;
            clearPacks[`years/${viewingYear}/settings/deadline`] = null;
            clearPacks[`years/${viewingYear}/settings/notice`] = null;
            clearPacks[`years/${viewingYear}/settings/noticeImage`] = null;
            db.ref().update(clearPacks).then(() => alert('当前学年数据已清空。')).catch(() => alert('清空失败，请重试。'));
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
        if (bar) bar.classList.toggle('show', checked.length > 0);
        if (countEl) countEl.textContent = checked.length;
    }

    function applyBatchStatus() {
        const checked = document.querySelectorAll('.batch-check-item:checked');
        const newStatus = document.getElementById('batch-target-status').value;
        if (!newStatus) return alert('请选择目标状态！');
        if (checked.length === 0) return alert('请先勾选记录！');

        const statusLabels = { booked: '已预约', confirmed: '已确认', completed: '已完成', canceled: '已取消' };
        if (!confirm(`确定将 ${checked.length} 条记录改为「${statusLabels[newStatus]}」吗？`)) return;

        const keys = Array.from(checked).map(cb => cb.dataset.key);
        Promise.all(keys.map(key => updateReservationStatusSafe(viewingYear, key, newStatus)))
            .then(results => {
                const failed = results.filter(r => !r.ok);
                const conflicts = results.filter(r => r.slotConflict);
                const succeeded = results.filter(r => r.ok && r.changed).length;
                if (failed.length || conflicts.length) {
                    alert(`已处理 ${succeeded} 条；${failed.length} 条因时段冲突或记录变化未处理，${conflicts.length} 条取消记录存在排班所有权异常，请单独检查。`);
                }
                if (succeeded > 0) {
                    SystemRouter.getLogsRef(viewingYear).push({
                        action: `批量修改 ${succeeded} 条记录状态为 [${statusLabels[newStatus]}]`,
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                }
                document.getElementById('batch-target-status').value = '';
                handleViewingYearChange(viewingYear);
            }).catch(() => { alert('批量操作失败，请重试。'); });
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

        updateReservationStatusSafe(viewingYear, resKey, newStatus).then(result => {
            if (!result.ok) {
                alert(result.reason === 'slot-conflict' ? '该时段已被其他预约占用，无法恢复。' : '状态修改失败，请重试。');
                const selectEl = document.querySelector(`.status-select-admin[data-key="${resKey}"]`);
                if (selectEl) selectEl.value = oldStatus;
                return;
            }
            SystemRouter.getLogsRef(viewingYear).push({
                action: `管理员将预约状态从 [${oldLabel}] 改为 [${newLabel}]${result.slotConflict ? '（排班所有权异常）' : ''}`,
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });
            if (result.slotConflict) alert('状态已取消，但排班所有权异常，未自动释放时段。');
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
    document.getElementById('today-refresh-btn').onclick = () => {
        handleViewingYearChange(viewingYear);
    };
    document.getElementById('mgr-start-btn').onclick = executeDataMigration;
    document.getElementById('purge-old-btn').onclick = function() { window.purgeOldRootNodes(); }; 
    document.getElementById('btn-toggle-logs').onclick = toggleLogCollapse;
    document.getElementById('btn-clear-logs').onclick = clearOperationLogs;
    document.getElementById('btn-add-student').onclick = addNewStudentToWhitelist;
    document.getElementById('new-student-name').onkeypress = (e) => { if (e.key === 'Enter') addNewStudentToWhitelist(); };
    const newStudentHoursInput = document.getElementById('new-student-hours');
    if (newStudentHoursInput) newStudentHoursInput.onkeypress = (e) => { if (e.key === 'Enter') addNewStudentToWhitelist(); };
    document.getElementById('btn-export-all').onclick = exportAllDataJSON;
    document.getElementById('btn-restore-all').onclick = triggerRestoreFile;

})();
