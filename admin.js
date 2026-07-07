// admin.js
(function() {
    let isAdminAuthenticated = false;
    let initialized = false; 
    let dateCollapseState = {}; 
    let resCollapseState = {}; 
    let reservationsData = []; 
    let viewingYear = "2026"; 

    let currentActiveSlotsRefMemory = null;
    let currentActiveReservationsRefMemory = null;
    let currentActiveLogsRefMemory = null;
    let currentActiveNoticeTextRefMemory = null;
    let currentActiveNoticeImgRefMemory = null;
    let currentActiveStudentListRefMemory = null;
    let currentActiveDeadlineRefMemory = null;
    let currentActiveAccessCodeRefMemory = null;

    // 🌟 核心核验改造点：在验证成功的分支链中，追加会话打标共享
    window.verifyAdmin = function() {
        const inputPass = document.getElementById('admin-password').value.trim();
        const errorEl = document.getElementById('login-error');
        if (!inputPass) return alert('请输入密码！');

        db.ref(`admin_auth/${inputPass}`).once('value').then((snapshot) => {
            if (snapshot.exists() && snapshot.val() === true) {
                
                // 🌟 核心拦截机制：顺带向当前浏览器 Tab 写入绿色通行凭证
                sessionStorage.setItem('admin_session_auth', 'true');

                isAdminAuthenticated = true; 
                document.getElementById('admin-login').style.display = 'none';
                document.getElementById('admin-content').style.display = 'block';
                initAdminSystem();
            } else { errorEl.textContent = '密码错误！'; }
        });
    };

    document.getElementById('admin-password').onkeypress = (e) => { if (e.key === 'Enter') verifyAdmin(); };

    function writeSystemLog(logText) {
        if (!SystemRouter.activeYear) return;
        const logItem = {
            timestamp: new Date().getTime(),
            formattedTime: new Date().toLocaleString(),
            text: logText
        };
        SystemRouter.getLogsRef(viewingYear).push(logItem);
    }

    function initAdminSystem() {
        if (!isAdminAuthenticated) return; 
        if (initialized) return; initialized = true;

        SystemRouter.system().on('value', (snapshot) => {
            const sys = snapshot.val();
            if (sys && sys.activeYear) {
                if (!viewingYear) { viewingYear = sys.activeYear; }
                renderYearSelectorDropdown(sys.activeYear);
            }
        });
    }

    function renderYearSelectorDropdown(currentActiveYear) {
        SystemRouter.yearsRoot().once('value').then((snapshot) => {
            const select = document.getElementById('admin-year-select');
            select.innerHTML = "";
            if (snapshot.exists()) {
                Object.keys(snapshot.val()).forEach(yr => {
                    const opt = document.createElement('option');
                    opt.value = yr;
                    opt.textContent = yr + " 学年" + (yr === currentActiveYear ? " (当前激活)" : "");
                    if (yr === viewingYear) opt.selected = true;
                    select.appendChild(opt);
                });
            }
            switchViewingYearContext();
        });
    }

    function switchViewingYearContext() {
        if (currentActiveSlotsRefMemory) currentActiveSlotsRefMemory.off();
        if (currentActiveReservationsRefMemory) currentActiveReservationsRefMemory.off();
        if (currentActiveLogsRefMemory) currentActiveLogsRefMemory.off();
        if (currentActiveNoticeTextRefMemory) currentActiveNoticeTextRefMemory.off();
        if (currentActiveNoticeImgRefMemory) currentActiveNoticeImgRefMemory.off();
        if (currentActiveStudentListRefMemory) currentActiveStudentListRefMemory.off();
        if (currentActiveDeadlineRefMemory) currentActiveDeadlineRefMemory.off();
        if (currentActiveAccessCodeRefMemory) currentActiveAccessCodeRefMemory.off();

        const year = viewingYear;
        
        currentActiveNoticeTextRefMemory = SystemRouter.getSettingsRef(year).child('notice');
        currentActiveNoticeTextRefMemory.on('value', (s) => {
            document.getElementById('notice-input').value = s.val() || "";
        });

        currentActiveNoticeImgRefMemory = SystemRouter.getSettingsRef(year).child('noticeImgHtml');
        currentActiveNoticeImgRefMemory.on('value', (s) => {
            const val = s.val() || "";
            if (val) {
                const match = val.match(/src="([^"]+)"/);
                document.getElementById('notice-img-input').value = match ? match[1] : "";
            } else {
                document.getElementById('notice-img-input').value = "";
            }
        });

        currentActiveDeadlineRefMemory = SystemRouter.getSettingsRef(year).child('deadline');
        currentActiveDeadlineRefMemory.on('value', (s) => {
            document.getElementById('deadline-input').value = s.val() || "";
        });

        currentActiveAccessCodeRefMemory = SystemRouter.getSettingsRef(year).child('accessCode');
        currentActiveAccessCodeRefMemory.on('value', (s) => {
            document.getElementById('access-code-input').value = s.val() || "";
        });

        currentActiveStudentListRefMemory = SystemRouter.getStudentWhitelistRef(year);
        currentActiveStudentListRefMemory.on('value', renderWhitelistUI);

        currentActiveSlotsRefMemory = SystemRouter.getSlotsRef(year);
        currentActiveReservationsRefMemory = SystemRouter.getReservationsRef(year);

        currentActiveReservationsRefMemory.on('value', (resSnap) => {
            reservationsData = [];
            if (resSnap.exists()) {
                resSnap.forEach((child) => {
                    reservationsData.push({ key: child.key, ...child.val() });
                });
            }
            fetchAndRenderSlotsAndReservationsDashboard();
        });

        currentActiveLogsRefMemory = SystemRouter.getLogsRef(year);
        currentActiveLogsRefMemory.on('value', (logSnap) => {
            const container = document.getElementById('admin-logs-container');
            if (!logSnap.exists()) {
                container.innerHTML = "暂无系统日志记录。";
                return;
            }
            let htmlBuilder = "";
            logSnap.forEach((child) => {
                const item = child.val();
                htmlBuilder += `[${item.formattedTime}] ${escapeHtml(item.text)}\n`;
            });
            container.innerHTML = htmlBuilder;
            container.scrollTop = container.scrollHeight;
        });
    }

    function handleViewingYearChange() {
        viewingYear = document.getElementById('admin-year-select').value;
        switchViewingYearContext();
    }

    function setAsActiveYear() {
        if (!confirm(`确定要将 ${viewingYear} 学年设定为系统当前对外提供服务的激活学年吗？`)) return;
        SystemRouter.system().update({ activeYear: viewingYear }).then(() => {
            writeSystemLog(`将系统当前对外激活学年变更为: ${viewingYear}`);
            alert('系统激活学年变更成功！');
        });
    }

    function createNewYearNode() {
        const newYr = prompt("请输入要新建的数据学年节点名称 (例如: 2027):");
        if (!newYr) return;
        if (!/^\d{4}$/.test(newYr)) return alert("学年名称必须为4位纯数字！");

        SystemRouter.yearsRoot().child(newYr).once('value').then((snap) => {
            if (snap.exists()) return alert("该学年节点已存在，请勿重复创建！");
            
            const initNode = {
                settings: { notice: `欢迎来到 ${newYr} 学年专业课辅导系统`, deadline: "" },
                slots: { init: true }
            };
            SystemRouter.yearsRoot().child(newYr).set(initNode).then(() => {
                viewingYear = newYr;
                SystemRouter.system().update({ activeYear: newYr }).then(() => {
                    writeSystemLog(`新建了新学年数据树，并直接挂载激活: ${newYr}`);
                    alert(`学年数据树 ${newYr} 创建并激活成功！`);
                });
            });
        });
    }

    function renderWhitelistUI(snapshot) {
        const container = document.getElementById('whitelist-display');
        if (!snapshot.exists()) {
            container.innerHTML = `<span style="color:#999; font-size:13px;">当前学年白名单内暂无准入同学。</span>`;
            return;
        }
        let htmlBuilder = "";
        snapshot.forEach((child) => {
            htmlBuilder += `
                <div class="whitelist-item">
                    <span>${escapeHtml(child.val())}</span>
                    <span class="remove-btn" onclick="removeStudentFromWhitelist('${child.key}', '${escapeHtml(child.val())}')">×</span>
                </div>`;
        });
        container.innerHTML = htmlBuilder;
    }

    window.addNewStudentToWhitelist = function() {
        const nameInput = document.getElementById('new-student-name');
        const name = nameInput.value.trim();
        if (!name) return alert("请输入要添加的同学姓名！");

        SystemRouter.getStudentWhitelistRef(viewingYear).push(name).then(() => {
            writeSystemLog(`向学生准入白名单中追加了同学: ${name}`);
            nameInput.value = "";
        });
    };

    window.removeStudentFromWhitelist = function(key, name) {
        if (!confirm(`确定要将同学 [ ${name} ] 从当前的白名单中移除吗？`)) return;
        SystemRouter.getStudentWhitelistRef(viewingYear).child(key).remove().then(() => {
            writeSystemLog(`将同学从学生准入白名单中移除: ${name}`);
        });
    };

    function setNotice() {
        const text = document.getElementById('notice-input').value.trim();
        const imgUrl = document.getElementById('notice-img-input').value.trim();
        const imgHtml = imgUrl ? `<br><img src="${imgUrl}" style="max-width:100%; border-radius:6px; margin-top:10px; border:1px solid #ffb036;">` : "";

        SystemRouter.getSettingsRef(viewingYear).update({
            notice: text,
            noticeImgHtml: imgHtml
        }).then(() => {
            writeSystemLog(`变更更新了看板公告公告内容`);
            alert('公告变更同步就绪！');
        });
    }

    function generateDayTemplate() {
        const dateText = document.getElementById('batch-date-text').value.trim();
        if (!dateText) return alert('请输入排班日期文本！');

        const templates = ["08:30-09:30", "09:30-10:30", "10:30-11:30", "14:00-15:00", "15:00-16:00", "16:00-17:00", "19:00-20:00", "20:00-21:00"];
        if (!confirm(`确定要在 ${dateText} 批量自动铺设这 ${templates.length} 个标准辅导班次吗？`)) return;

        const promises = templates.map(timeRange => {
            const rawString = `${dateText} ${timeRange}`;
            const parsedObj = TimeParser.parseRawText(rawString, viewingYear);
            if (!parsedObj) return Promise.resolve();

            const nodeKey = parsedObj.formattedSlotText.replace(/\//g, '-').replace(/\s+/g, '_');
            return SystemRouter.getSlotsRef(viewingYear).child(nodeKey).set({
                timeText: parsedObj.formattedSlotText,
                date: parsedObj.date,
                startTime: parsedObj.startTime,
                endTime: parsedObj.endTime,
                status: "available"
            });
        });

        Promise.all(promises).then(() => {
            writeSystemLog(`一键批量铺设了 ${dateText} 的全天标准班次排班`);
            alert('批量标准班次铺设完成！');
        });
    }

    function addSlot() {
        const text = document.getElementById('slot-time-text').value.trim();
        if (!text) return alert('请输入特定的排班文本！');

        const parsedObj = TimeParser.parseRawText(text, viewingYear);
        if (!parsedObj) return alert('排班文本格式不规范，自适应解析器拦截！请严格按照 "月/日 时:分-时:分" 格式输入。');

        const nodeKey = parsedObj.formattedSlotText.replace(/\//g, '-').replace(/\s+/g, '_');
        SystemRouter.getSlotsRef(viewingYear).child(nodeKey).set({
            timeText: parsedObj.formattedSlotText,
            date: parsedObj.date,
            startTime: parsedObj.startTime,
            endTime: parsedObj.endTime,
            status: "available"
        }).then(() => {
            writeSystemLog(`追加追加了单点独立排班排班: ${parsedObj.formattedSlotText}`);
            document.getElementById('slot-time-text').value = "";
            alert('单点辅导排班追加成功！');
        });
    }

    function setDeadline() {
        const dl = document.getElementById('deadline-input').value;
        if (!dl) return alert('请选择具体的截止时刻！');

        SystemRouter.getSettingsRef(viewingYear).update({ deadline: dl }).then(() => {
            writeSystemLog(`调整了预约网格系统的动态截止截止死线为: ${dl}`);
            alert('系统截止时刻设置完成！');
        });
    }

    function setCode() {
        const code = document.getElementById('access-code-input').value.trim().toUpperCase();
        SystemRouter.getSettingsRef(viewingYear).update({ accessCode: code }).then(() => {
            writeSystemLog(`重置了全局约课特征暗号为: ${code || '未设限制'}`);
            alert('特征暗号变更成功！');
        });
    }

    function fetchAndRenderSlotsAndReservationsDashboard() {
        SystemRouter.getSlotsRef(viewingYear).once('value').then((slotsSnap) => {
            const container = document.getElementById('admin-reservations-container');
            if (!slotsSnap.exists()) {
                container.innerHTML = `<p style="text-align:center; color:#999; padding:20px;">当前学年暂无排班网格信息，请先在上方进行排班。</p>`;
                return;
            }

            let sortedGroupedMap = {};
            slotsSnap.forEach((child) => {
                if (child.key === 'init') return;
                const slot = child.val();
                const dText = slot.timeText.split(' ')[0];
                if (!sortedGroupedMap[dText]) sortedGroupedMap[dText] = [];
                sortedGroupedMap[dText].push({ slotKey: child.key, ...slot });
            });

            const sortedDatesArray = Object.keys(sortedGroupedMap).sort((a, b) => {
                const pa = a.split('/'); const pb = b.split('/');
                return (parseInt(pa[0], 10) - parseInt(pb[0], 10)) || (parseInt(pa[1], 10) - parseInt(pb[1], 10));
            });

            let htmlBuilder = "";
            sortedDatesArray.forEach(dText => {
                const slotsList = sortedGroupedMap[dText].sort((a, b) => a.startTime.localeCompare(b.startTime));
                const isCollapsed = dateCollapseState[dText] === true;

                htmlBuilder += `
                    <div class="date-group">
                        <div class="date-header" onclick="toggleDateGroupCollapse('${dText}')">
                            <span>📅 日期：${dText}（共 ${slotsList.length} 个辅导班次）</span>
                            <span class="arrow-indicator">${isCollapsed ? '展开 +' : '收起 -'}</span>
                        </div>
                        <div class="date-body ${isCollapsed ? 'collapsed' : ''}">`;

                slotsList.forEach(slot => {
                    const matchedResList = reservationsData.filter(r => r.slotKey === slot.slotKey);
                    let slotStatusText = "🟢 空闲中";
                    if (slot.status === 'locked') slotStatusText = "🔴 已约满";
                    if (slot.status === 'disabled') slotStatusText = "⚪ 教师已屏蔽";

                    htmlBuilder += `
                        <div style="border: 1px solid #eaebec; padding: 12px; border-radius: 6px; margin-bottom: 12px; background: #fff;">
                            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid #f1f2f3; padding-bottom:6px; margin-bottom:10px;">
                                <span style="font-weight:bold; color:#333;">⏱ 时段：${slot.timeText.split(' ')[1]}</span>
                                <span style="font-size:13px;">状态状态：<b>${slotStatusText}</b></span>
                                <div>
                                    <button class="danger" style="padding:3px 8px; font-size:11px; width:auto;" onclick="purgeWholeSlotBlock('${slot.slotKey}')">彻底删除本时段</button>
                                </div>
                            </div>`;

                    if (matchedResList.length === 0) {
                        htmlBuilder += `<p style="color:#999; font-size:13px; padding:5px 0;">当前时段尚无同学填报预约。</p>`;
                    } else {
                        matchedResList.forEach(res => {
                            let badgeClass = "status-pending"; let statusName = "待确认";
                            if (res.status === 'confirmed') { badgeClass = "status-confirmed"; statusName = "正式确诊/通过"; }
                            if (res.status === 'cancelled') { badgeClass = "status-cancelled"; statusName = "已取消"; }
                            if (res.status === 'completed') { badgeClass = "status-completed"; statusName = "辅导圆满完成"; }

                            let actionButtonsHtml = "";
                            if (res.status === 'pending') {
                                actionButtonsHtml = `
                                    <button style="background:#67c23a; width:auto; padding:4px 10px; font-size:12px;" onclick="updateReservationStatus('${res.key}', 'confirmed')">确诊通过</button>
                                    <button class="danger" style="padding:4px 10px; font-size:12px;" onclick="updateReservationStatus('${res.key}', 'cancelled')">驳回取消</button>`;
                            } else if (res.status === 'confirmed') {
                                actionButtonsHtml = `
                                    <button style="background:#409eff; width:auto; padding:4px 10px; font-size:12px;" onclick="updateReservationStatus('${res.key}', 'completed')">标记结课</button>
                                    <button class="danger" style="padding:4px 10px; font-size:12px;" onclick="updateReservationStatus('${res.key}', 'cancelled')">紧急取消</button>`;
                            }

                            const isHistoryCollapsed = resCollapseState[res.key] !== false;

                            actionButtonsHtml += `
                                <button style="background:#909399; width:auto; padding:4px 10px; font-size:12px; margin-left:5px;" onclick="toggleStudentHistoryCollapse('${res.key}')">
                                    ${isHistoryCollapsed ? '展开查阅此人历史行为 +' : '收起历史盘 -'}
                                </button>`;

                            htmlBuilder += `
                                <div class="reservation-item">
                                    <div class="reservation-meta">
                                        <div><b>学生大名：</b><span style="font-size:15px; color:#111;">${escapeHtml(res.name)}</span></div>
                                        <div><b>联系电话：</b>${escapeHtml(res.phone)}</div>
                                        <div><b>当前单据状态：</b><span class="status-badge ${badgeClass}">${statusName}</span></div>
                                        <div><b>取消私钥：</b><code>${escapeHtml(res.cancelCode)}</code></div>
                                    </div>
                                    <div style="font-size:14px; color:#475569; background:#fff; padding:8px; border-radius:4px; border:1px solid #e2e8f0; margin-bottom:8px;">
                                        <b>📝 提交的困惑/备考痛点：</b><br>${escapeHtml(res.problem).replace(/\n/g, '<br>')}
                                    </div>
                                    <div style="text-align:right;">${actionButtonsHtml}</div>
                                    <div id="history-wrapper-${res.key}" style="margin-top:10px; display:${isHistoryCollapsed ? 'none':'block'}; border-top:1px dashed #ccc; padding-top:10px;">
                                        <div style="font-weight:bold; color:#718096; margin-bottom:5px; font-size:12px;">📊 交叉对账：系统抓取到的该生在当前学年的所有填报历史痕迹：</div>
                                        <div id="history-box-${res.key}"><span style="color:#999; font-size:12px;">拉取记录中...</span></div>
                                    </div>
                                </div>`;

                            if (!isHistoryCollapsed) {
                                setTimeout(() => { injectStudentHistoryTraceList(res.name, res.key); }, 50);
                            }
                        });
                    }
                    htmlBuilder += `</div>`;
                });
                htmlBuilder += `</div></div>`;
            });
            container.innerHTML = htmlBuilder;
        });
    }

    window.toggleDateGroupCollapse = function(dText) {
        dateCollapseState[dText] = !dateCollapseState[dText];
        fetchAndRenderSlotsAndReservationsDashboard();
    };

    window.toggleStudentHistoryCollapse = function(resKey) {
        if (resCollapseState[resKey] === undefined) resCollapseState[resKey] = false;
        else resCollapseState[resKey] = !resCollapseState[resKey];
        fetchAndRenderSlotsAndReservationsDashboard();
    };

    function injectStudentHistoryTraceList(studentName, resKey) {
        const box = document.getElementById(`history-box-${resKey}`);
        if (!box) return;

        const matchedHistory = reservationsData.filter(r => r.name === studentName);
        if (matchedHistory.length === 0) {
            box.innerHTML = `<span style="color:#999; font-size:12px;">无历史记录。</span>`;
            return;
        }

        let htmlBuilder = "";
        matchedHistory.forEach(h => {
            let statusText = "待确认";
            if (h.status === 'confirmed') statusText = "已确诊通过";
            if (h.status === 'cancelled') statusText = "已取消/已驳回";
            if (h.status === 'completed') statusText = "已圆满结课";

            htmlBuilder += `
                <div class="history-card">
                    <div class="card-row"><b>辅导时段:</b> <span style="color:#409eff;">${escapeHtml(h.time)}</span></div>
                    <div class="card-row"><b>单据状态:</b> <span>${statusText}</span></div>
                    <div class="card-row" style="color:#718096; font-size:11px;"><b>提报困惑:</b> ${escapeHtml(h.problem)}</div>
                </div>`;
        });
        box.innerHTML = htmlBuilder;
    }

    window.updateReservationStatus = function(resKey, newStatus) {
        const item = reservationsData.find(r => r.key === resKey);
        if (!item) return;

        let actionText = newStatus === 'confirmed' ? "确诊批准通过" : (newStatus === 'completed' ? "标记圆满结课" : "执行强行驳回取消");
        if (!confirm(`确定要为 [ ${item.name} ] 同学的这笔单据执行 [ ${actionText} ] 操作吗？`)) return;

        SystemRouter.getReservationsRef(viewingYear).child(resKey).update({ status: newStatus }).then(() => {
            writeSystemLog(`将 [ ${item.name} ] 同学在 [ ${item.time} ] 的单据变更为: [ ${actionText} ]`);
            
            if (newStatus === 'cancelled') {
                SystemRouter.getSlotsRef(viewingYear).child(item.slotKey).update({ status: "available" });
            }
        });
    };

    window.purgeWholeSlotBlock = function(slotKey) {
        if (!confirm("⚠️ 危险警告：\n删除本排班时次将同步物理擦除该时段下所有关联的学生约课单据，确定执行吗？")) return;
        
        SystemRouter.getSlotsRef(viewingYear).child(slotKey).remove().then(() => {
            writeSystemLog(`物理彻底删除了辅导时段节点: ${slotKey}`);
            const matchedRes = reservationsData.filter(r => r.slotKey === slotKey);
            matchedRes.forEach(r => {
                SystemRouter.getReservationsRef(viewingYear).child(r.key).remove();
            });
        });
    };

    window.toggleLogCollapse = function() {
        const wrapper = document.getElementById('admin-logs-wrapper');
        const arrow = document.getElementById('log-arrow-indicator');
        if (wrapper.classList.contains('collapsed')) {
            wrapper.classList.remove('collapsed');
            arrow.textContent = "收起 -";
        } else {
            wrapper.classList.add('collapsed');
            arrow.textContent = "展开 +";
        }
    };

    window.clearOperationLogs = function() {
        if (!confirm("确定要彻底销毁清空当前学年的所有操作运行日志吗？")) return;
        SystemRouter.getLogsRef(viewingYear).remove();
    };

    window.clearCurrentYearData = function() {
        if (prompt(`🚨 极限危险操作警告：\n当前正在尝试清空 [ ${viewingYear} ] 学年的全部数据！\n请输入大写字母 "PURGE" 以授权执行：`) !== "PURGE") {
            return alert("授权码校验失败，强行终止清除！");
        }
        SystemRouter.getSlotsRef(viewingYear).set({ init: true });
        SystemRouter.getReservationsRef(viewingYear).remove();
        SystemRouter.getLogsRef(viewingYear).remove();
        alert('当前年度排班与单据数据已全部回滚纯净态！');
    };

    window.exportCSV = function(isLocalDump = false) {
        if (reservationsData.length === 0) return alert('当前学年暂无任何有效预约名册可供导出！');
        
        let csvBuilder = "\uFEFF预约时段,学生姓名,联系电话,预约状态,提交问题,交卷/提报时间\n";
        reservationsData.forEach(r => {
            let statusText = "待确认";
            if (r.status === 'confirmed') statusText = "已确认";
            if (r.status === 'cancelled') statusText = "已取消";
            if (r.status === 'completed') statusText = "已完成";

            let cleanProblem = r.problem ? r.problem.replace(/"/g, '""').replace(/\n/g, ' ') : "";
            csvBuilder += `"${r.time}","${r.name}","${r.phone}","${statusText}","${cleanProblem}","${r.timestamp ? new Date(r.timestamp).toLocaleString() : '未知'}"\n`;
        });

        const blob = new Blob([csvBuilder], { type: 'text/csv;charset=utf-8;' });
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = `预约辅导名册汇总_${viewingYear}学年.csv`;
        a.click();
        setTimeout(() => { URL.revokeObjectURL(dlUrl); }, 1000);
    };

    window.exportTutorFeeJSON = function() {
        const completedRes = reservationsData.filter(r => r.status === 'completed');
        if (completedRes.length === 0) return alert('当前学年暂无已标记结课（completed）的单据，账单流水归零，拦截导出！');

        const studentMappingSummary = completedRes.map(r => ({
            studentName: r.name,
            courseTimeText: r.time,
            billingDurationUnit: "1 小时",
            billingTimestamp: r.timestamp || null
        }));

        const finalBillPayload = {
            billingYearContext: viewingYear,
            exportTimestamp: new Date().getTime(),
            exportFormattedTime: new Date().toLocaleString(),
            totalCompletedLessonsCount: completedRes.length,
            currencyUnit: "RMB",
            estimatedTutorFeeTotal: completedRes.length * 100, 
            lessonDetailsRecords: studentMappingSummary
        };

        const blob = new Blob([JSON.stringify(finalBillPayload, null, 2)], { type: 'application/json' });
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = `导师课酬对账账单流水_${viewingYear}学年.json`;
        a.click();
        setTimeout(() => { URL.revokeObjectURL(dlUrl); }, 1000);
    };

    function escapeHtml(string) {
        const entityMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '/': '&#x2F;' };
        return String(string).replace(/[&<>"'\/]/g, s => entityMap[s]);
    }

    // 绑定基础操作触发源
    document.getElementById('admin-year-select').onchange = handleViewingYearChange;
    document.getElementById('btn-set-active').onclick = setAsActiveYear;
    document.getElementById('btn-create-year').onclick = createNewYearNode;
    document.getElementById('btn-set-notice').onclick = setNotice;
    document.getElementById('btn-gen-tpl').onclick = generateDayTemplate;
    document.getElementById('btn-add-slot').onclick = addSlot;
    document.getElementById('btn-set-deadline').onclick = setDeadline;
    document.getElementById('btn-set-code').onclick = setCode;
    document.getElementById('btn-export-csv').onclick = function() { exportCSV(false); };
    document.getElementById('btn-export-tutor-json').onclick = exportTutorFeeJSON; 
    document.getElementById('btn-clear-year').onclick = clearCurrentYearData;
    document.getElementById('btn-toggle-logs').onclick = toggleLogCollapse;
    document.getElementById('btn-clear-logs').onclick = clearOperationLogs;
    document.getElementById('btn-add-student').onclick = addNewStudentToWhitelist;
    document.getElementById('new-student-name').onkeypress = (e) => { if (e.key === 'Enter') addNewStudentToWhitelist(); };

})();
