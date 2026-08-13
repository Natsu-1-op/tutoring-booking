// exam_student.js — 学生考试与复查端

// 断网保护 banner
(function setupOfflineGuard() {
    const banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;background:#fff3cd;color:#856404;text-align:center;padding:8px;font-weight:bold;font-size:13px;z-index:99999;';
    banner.textContent = '当前处于离线状态，答案已保存到本地，恢复网络后继续答题';
    document.body.appendChild(banner);

    window.addEventListener('offline', () => { banner.style.display = 'block'; });
    window.addEventListener('online', () => { banner.style.display = 'none'; });
    if (!navigator.onLine) banner.style.display = 'block';
})();

let examPaperData = null;
let studentNameVerified = "";
let currentQuestionIndex = 0;
let studentAnswers = {};
let cropperInstance = null;
let currentTargetQuestionId = null;
let timerInterval = null;
let totalElapsedSeconds = 0;
let activeReviewPackageData = null;
const STEALTH_SECRET_SALT = "ClassOpticSecurePaperKey2026";

window.openGlobalLightbox = function(imgSrc) {
    document.getElementById('global-lightbox-img').src = imgSrc;
    document.getElementById('global-lightbox').style.display = 'flex';
};
window.closeGlobalLightbox = function() {
    document.getElementById('global-lightbox').style.display = 'none';
};

function decryptStealthPayload(cipherText, salt) {
    try {
        const rawData = atob(cipherText); let result = '';
        for (let i = 0; i < rawData.length; i++) {
            result += String.fromCharCode(rawData.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
        }
        return JSON.parse(decodeURIComponent(result));
    } catch (err) { return null; }
}

function triggerSaveStatusLight() {
    const light = document.getElementById('save-light');
    light.classList.add('show');
    setTimeout(() => { light.classList.remove('show'); }, 1200);
}

function triggerLiveAntiDisasterBackup() {
    if (!examPaperData || !studentNameVerified) return;
    const backupPayload = {
        paperTitle: examPaperData.paperTitle,
        studentName: studentNameVerified,
        examTimeWindow: `开始: ${examPaperData.startTime} / 结束: ${examPaperData.endTime}`,
        totalElapsedSeconds: totalElapsedSeconds,
        answers: studentAnswers
    };
    try { localStorage.setItem("exam_answer_backup", JSON.stringify(backupPayload)); } catch(e) {}
    triggerSaveStatusLight();
}

function toggleOverlayUIMode(mode) {
    document.getElementById('tab-mode-exam').classList.toggle('active', mode === 'exam');
    document.getElementById('tab-mode-review').classList.toggle('active', mode === 'review');
    document.getElementById('view-box-exam').style.display = (mode === 'exam') ? 'block' : 'none';
    document.getElementById('view-box-review').style.display = (mode === 'review') ? 'block' : 'none';
    document.getElementById('auth-error').textContent = "";
}

document.getElementById('input-paper-json').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const json = JSON.parse(evt.target.result);
            if (json.isEncrypted && json.cipher) {
                const decryptedData = decryptStealthPayload(json.cipher, STEALTH_SECRET_SALT);
                if (!decryptedData) {
                    document.getElementById('auth-error').textContent = "解密失败：试卷数据损坏或密钥不匹配。";
                    return;
                }
                examPaperData = decryptedData;
                document.getElementById('student-name-zone').style.display = 'block';
                document.getElementById('auth-error').textContent = "";
            } else { alert("试卷格式错误。"); }
        } catch (err) { alert("解析失败。"); }
    }; reader.readAsText(file);
};

function verifyAndStartExam() {
    const nameInput = document.getElementById('student-name').value.trim();
    if (!nameInput) return alert("请输入姓名！");
    const targetYear = SystemRouter.activeYear || "2026";

    const safePaperPath = encodeURIComponent(examPaperData.paperTitle).replace(/\./g, '%2E');
    const safeStudentPath = encodeURIComponent(nameInput).replace(/\./g, '%2E');

    db.ref(`submittedExamLocks/${safePaperPath}/${safeStudentPath}`).once('value').then((lockSnapshot) => {
        if (lockSnapshot.exists()) {
            document.getElementById('auth-error').textContent = `进入拦截：您(${nameInput})先前已成功提交答卷，不可重复进行考试。`;
            return;
        }

        db.ref(`years/${targetYear}/studentWhitelist`).once('value').then((snapshot) => {
            let isAllowed = snapshot.exists() ? Object.values(snapshot.val()).includes(nameInput) : true;
            if (!isAllowed) { document.getElementById('auth-error').textContent = "验证失败：您不在学生白名单内。"; return; }

            studentNameVerified = nameInput;
            document.getElementById('meta-paper-title').textContent = examPaperData.paperTitle;
            document.getElementById('meta-student-name').textContent = studentNameVerified;
            document.getElementById('meta-time-window').innerHTML = `开始: ${examPaperData.startTime.replace('T', ' ')}<br>截止: ${examPaperData.endTime.replace('T', ' ')}`;

            const now = new Date().getTime();
            if (now < new Date(examPaperData.startTime).getTime()) return alert("考试尚未开始！");
            if (now > new Date(examPaperData.endTime).getTime()) return alert("考试已经截止！");

            const localSavedBackupStr = localStorage.getItem("exam_answer_backup");
            if (localSavedBackupStr) {
                try {
                    const parsedBackup = JSON.parse(localSavedBackupStr);
                    if (parsedBackup.studentName === studentNameVerified && parsedBackup.paperTitle === examPaperData.paperTitle) {
                        if (confirm("系统检测到未完成的考试记录，是否恢复已作答的内容？")) {
                            studentAnswers = parsedBackup.answers || {};
                            totalElapsedSeconds = parsedBackup.totalElapsedSeconds || 0;
                            document.getElementById('auth-overlay').style.display = 'none';
                            document.getElementById('exam-app').style.display = 'flex';
                            initExamEngine(true);
                            return;
                        }
                    }
                } catch(err) {}
            }

            document.getElementById('auth-overlay').style.display = 'none';
            document.getElementById('exam-app').style.display = 'flex';
            initExamEngine(false);
        });
    });
}

document.getElementById('input-review-package').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const outerPayload = JSON.parse(evt.target.result);
            const pack = decryptStealthPayload(outerPayload.cipher, STEALTH_SECRET_SALT);
            if (!pack) return alert("解密失败。");
            activeReviewPackageData = pack;
            startReviewPackageWorkspace();
        } catch(err) { alert("解析失败。"); }
    }; reader.readAsText(file);
};

function startReviewPackageWorkspace() {
    document.getElementById('meta-paper-title').textContent = activeReviewPackageData.paperTitle;
    document.getElementById('meta-student-name').textContent = activeReviewPackageData.studentName;
    document.getElementById('meta-time-window').innerHTML = `时段: ${activeReviewPackageData.examTimeWindow.replace('开始:', '').replace('结束:', '')}`;

    const totalQCount = activeReviewPackageData.masterPaperSnapshot.questions.length;
    document.getElementById('total-idx-text').textContent = totalQCount;
    document.getElementById('exam-timer').innerHTML = `得分: <span style="color:red;font-size:18px;">${activeReviewPackageData.totalScoreResult}</span>分 | 耗时: ${activeReviewPackageData.elapsedDuration}`;

    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('exam-app').style.display = 'flex';
    document.getElementById('review-panel-trigger').style.display = 'flex';

    const wrapper = document.getElementById('questions-wrapper'); wrapper.innerHTML = "";
    const gridContainer = document.getElementById('review-grid-dots-container'); gridContainer.innerHTML = "";

    activeReviewPackageData.masterPaperSnapshot.questions.forEach((mq, idx) => {
        const sAns = activeReviewPackageData.studentAnswersSnapshot[mq.id] || { text: "未答", image: "" };
        const earnedScore = activeReviewPackageData.scoredMap[mq.id] ?? 0;
        const isWrong = earnedScore < mq.score;

        const card = document.createElement('div');
        card.className = `question-card ${idx === 0 ? 'active' : ''}`;
        card.id = `q-card-${idx}`;
        let typeName = mq.type === 'choice' ? '选择题' : (mq.type === 'judge' ? '判断题' : '填空简答题');

        let html = `<div class="question-meta">【${typeName}】 | 满分：${mq.score}分</div>`;
        html += `<div class="question-stem">${mq.stem.replace(/\\n/g, "\n")}</div>`;
        if (mq.stemImage) html += `<img src="${mq.stemImage}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)">`;

        html += `<div class="review-score-banner" style="background:${isWrong ? '#fef0f0' : '#f0f9eb'}; color:${isWrong ? '#f56c6c' : '#2b6914'}">
                <span>判定：${isWrong ? '扣分项' : '完全正确'}</span><span>实际得分：${earnedScore} / ${mq.score} 分</span>
            </div>`;

        // 教师批改评语（随评卷打分包导出，教师可修改后公开）
        const reviewFeedback = activeReviewPackageData.feedbackMap && activeReviewPackageData.feedbackMap[mq.id];
        if (reviewFeedback) {
            html += `<div class="review-teacher-feedback"><b>教师评语：</b>${escapeHtml(reviewFeedback).replace(/\n/g, '<br>')}</div>`;
        }

        if (mq.standardAnswerImage) {
            html += `<div style="margin-top:8px;"><label class="exam-img-label">标准评分细则附图 (点击查看大图)：</label><img src="${mq.standardAnswerImage}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)"></div>`;
        }

        if (mq.type === 'choice' && mq.options) {
            html += `<div class="options-list" style="margin-top:12px;">`;
            mq.options.forEach(opt => {
                const isSelected = sAns.text === opt.trim().charAt(0);
                html += `<div class="option-item ${isSelected ? 'selected' : ''}" style="pointer-events:none;">${opt} ${isSelected ? ' (已选)' : ''}</div>`;
            }); html += `</div>`;
        } else if (mq.type === 'judge') {
            html += `<div class="options-list" style="margin-top:12px;">`;
            const isYes = sAns.text === '√';
            html += `<div class="option-item ${isYes ? 'selected' : ''}" style="pointer-events:none;">正确 (√)</div>`;
            html += `<div class="option-item ${!isYes && sAns.text ? 'selected' : ''}" style="pointer-events:none;">错误 (×)</div>`;
            html += `</div>`;
        } else {
            html += `<div style="margin-top:12px;"><textarea class="text-answer-box" disabled style="background:#f4f4f5;">${escapeHtml(sAns.text) || '(无文字)'}</textarea></div>`;
            if (sAns.image) html += `<div><label class="exam-img-label">您的纸质草稿 (点图看大图)：</label><img src="${sAns.image}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)"></div>`;
        }
        if (mq.standardAnswer) html += `<div class="exam-standard-answer"><b>标准参考标答：</b>${escapeHtml(mq.standardAnswer)}</div>`;
        card.innerHTML = html; wrapper.appendChild(card);

        const dot = document.createElement('div');
        dot.className = `r-dot ${isWrong ? 'wrong' : 'correct'} ${idx === 0 ? 'active' : ''}`;
        dot.id = `r-dot-id-${idx}`; dot.textContent = idx + 1;
        dot.onclick = () => {
            if (window.MathJax) {
                const oldCard = document.getElementById(`q-card-${currentQuestionIndex}`);
                MathJax.typesetClear([oldCard]);
            }
            document.getElementById(`q-card-${currentQuestionIndex}`).classList.remove('active');
            currentQuestionIndex = idx;
            const nextActiveCard = document.getElementById(`q-card-${currentQuestionIndex}`);
            nextActiveCard.classList.add('active');
            document.getElementById('current-idx-text').textContent = currentQuestionIndex + 1;
            document.querySelectorAll('.r-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
            document.querySelector('.exam-main-content').scrollTop = 0;
            if (window.MathJax) { MathJax.typesetPromise([nextActiveCard]).catch(() => {}); }
            document.getElementById('btn-prev').style.visibility = currentQuestionIndex === 0 ? 'hidden' : 'visible';
            document.getElementById('btn-next').style.display = currentQuestionIndex === totalQCount - 1 ? 'none' : 'block';
            closeReviewNavModal();
        }; gridContainer.appendChild(dot);
    });
    if (window.MathJax) {
        MathJax.typesetClear([wrapper]);
        MathJax.typesetPromise([wrapper]).catch(() => {});
    }
    document.getElementById('btn-prev').style.visibility = 'hidden';
    updateBtnState();
}

window.openReviewNavModal = function() {
    document.getElementById('review-nav-modal').style.display = 'flex';
};
window.closeReviewNavModal = function() {
    document.getElementById('review-nav-modal').style.display = 'none';
};

function initExamEngine(isRestoreFromBackup) {
    if (isRestoreFromBackup === undefined) isRestoreFromBackup = false;
    const wrapper = document.getElementById('questions-wrapper');
    wrapper.innerHTML = "";

    const totalQuestionsLength = examPaperData.questions.length;
    document.getElementById('total-idx-text').textContent = totalQuestionsLength;

    examPaperData.questions.forEach((q, idx) => {
        const card = document.createElement('div');
        card.className = `question-card ${idx === 0 ? 'active' : ''}`;
        card.id = `q-card-${idx}`;

        if (!isRestoreFromBackup) {
            studentAnswers[q.id] = { text: "", image: "" };
        }
        const currentRestoredAnswer = studentAnswers[q.id] || { text: "", image: "" };

        let typeName = q.type === 'choice' ? '选择题' : (q.type === 'judge' ? '判断题' : '填空主观题');
        let html = `<div class="question-meta">题型：【${typeName}】 | 分值：${q.score}分</div>`;
        html += `<div class="question-stem">${q.stem.replace(/\\n/g, "\n")}</div>`;
        if (q.stemImage) html += `<img src="${q.stemImage}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)">`;

        if (q.type === 'choice' && q.options) {
            html += `<div class="options-list">`;
            q.options.forEach(opt => {
                const isSelected = currentRestoredAnswer.text === opt.trim().charAt(0);
                html += `<div class="option-item ${isSelected ? 'selected' : ''}" onclick="selectOpt('${q.id}', '${opt.trim().charAt(0)}', this)">${opt}</div>`;
            });
            html += `</div>`;
        } else if (q.type === 'judge') {
            const isYes = currentRestoredAnswer.text === '√';
            const isNo = currentRestoredAnswer.text === '×';
            html += `<div class="options-list">
                <div class="option-item ${isYes ? 'selected' : ''}" onclick="selectOpt('${q.id}', '√', this)">正确 (√)</div>
                <div class="option-item ${isNo ? 'selected' : ''}" onclick="selectOpt('${q.id}', '×', this)">错误 (×)</div>
            </div>`;
        } else {
            html += `<textarea class="text-answer-box" placeholder="请输入文字答案，公式无法打字可上传图片"
                oninput="updateTextAnswer('${q.id}', this.value)">${currentRestoredAnswer.text || ''}</textarea>
                <div class="upload-section"><div class="upload-placeholder" onclick="activateCamera('${q.id}')">点击上传</div>
                    <div class="preview-wrapper" id="prev-box-${q.id}" style="${currentRestoredAnswer.image ? 'display:inline-block' : 'display:none'}">
                        <button class="btn-remove-img" onclick="removeImg('${q.id}')">×</button>
                        <img class="click-zoom-img" id="img-view-${q.id}" src="${currentRestoredAnswer.image || ''}" onclick="openGlobalLightbox(this.src)">
                    </div>
                </div>`;
        }
        card.innerHTML = html; wrapper.appendChild(card);
    });
    const firstActiveCard = document.getElementById('q-card-0');
    if (window.MathJax) MathJax.typesetPromise([firstActiveCard]).catch(() => {});

    startCountUpTimer();
    document.getElementById('btn-prev').style.visibility = 'hidden';
    updateBtnState();
}

window.selectOpt = function(qId, val, el) {
    studentAnswers[qId].text = val;
    el.parentElement.querySelectorAll('.option-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    triggerLiveAntiDisasterBackup();
};
window.updateTextAnswer = function(qId, val) {
    studentAnswers[qId].text = val.trim();
    triggerLiveAntiDisasterBackup();
};

window.changeQuestion = function(dir) {
    const totalLen = activeReviewPackageData
        ? activeReviewPackageData.masterPaperSnapshot.questions.length
        : examPaperData.questions.length;

    if (activeReviewPackageData) {
        // 复查模式：通过答题面板点切换
        let target = currentQuestionIndex + dir;
        if (target >= 0 && target < totalLen) {
            document.getElementById(`r-dot-id-${target}`).click();
        }
        return;
    }

    // 考试模式：切换题目卡片
    if (window.MathJax) {
        const oldCard = document.getElementById(`q-card-${currentQuestionIndex}`);
        MathJax.typesetClear([oldCard]);
    }
    document.getElementById(`q-card-${currentQuestionIndex}`).classList.remove('active');
    currentQuestionIndex += dir;
    const nextActiveCard = document.getElementById(`q-card-${currentQuestionIndex}`);
    nextActiveCard.classList.add('active');
    document.getElementById('current-idx-text').textContent = currentQuestionIndex + 1;
    document.querySelector('.exam-main-content').scrollTop = 0;
    if (window.MathJax) { MathJax.typesetPromise([nextActiveCard]).catch(() => {}); }
    updateBtnState();
};

function updateBtnState() {
    const totalLen = activeReviewPackageData
        ? activeReviewPackageData.masterPaperSnapshot.questions.length
        : examPaperData.questions.length;
    document.getElementById('btn-prev').style.visibility = currentQuestionIndex === 0 ? 'hidden' : 'visible';

    if (activeReviewPackageData) {
        document.getElementById('btn-next').style.display = currentQuestionIndex === totalLen - 1 ? 'none' : 'block';
        document.getElementById('btn-finish').style.display = 'none';
    } else {
        document.getElementById('btn-next').style.display = currentQuestionIndex === totalLen - 1 ? 'none' : 'block';
        document.getElementById('btn-finish').style.display = currentQuestionIndex === totalLen - 1 ? 'block' : 'none';
    }
}

window.activateCamera = function(qId) {
    currentTargetQuestionId = qId;
    document.getElementById('hidden-camera-input').click();
};

document.getElementById('hidden-camera-input').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
        alert("照片过大（超过12MB）。请调低拍照分辨率后重新上传。");
        e.target.value = ""; return;
    }
    const reader = new FileReader();
    reader.onload = function(evt) {
        document.getElementById('cropper-modal').style.display = 'flex';
        const image = document.getElementById('cropper-image');
        image.src = evt.target.result;
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = new Cropper(image, { viewMode: 1, autoCropArea: 0.8 });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
};

window.closeCropperModal = function() {
    document.getElementById('cropper-modal').style.display = 'none';
    if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
    document.getElementById('cropper-image').src = "";
};
window.rotateImage = function() {
    if (cropperInstance) cropperInstance.rotate(90);
};
window.saveCroppedResult = function() {
    if (!currentTargetQuestionId) return;
    const canvas = cropperInstance.getCroppedCanvas({ width: 1024 });
    const base64 = canvas.toDataURL('image/jpeg', 0.5);
    studentAnswers[currentTargetQuestionId].image = base64;
    document.getElementById(`img-view-${currentTargetQuestionId}`).src = base64;
    document.getElementById(`prev-box-${currentTargetQuestionId}`).style.display = 'inline-block';
    closeCropperModal();
    triggerLiveAntiDisasterBackup();
};
window.removeImg = function(qId) {
    studentAnswers[qId].image = "";
    document.getElementById(`prev-box-${qId}`).style.display = 'none';
    triggerLiveAntiDisasterBackup();
};

function startCountUpTimer() {
    const timerEl = document.getElementById('exam-timer');
    const endTimestamp = new Date(examPaperData.endTime).getTime();
    timerInterval = setInterval(() => {
        if (new Date().getTime() >= endTimestamp) {
            clearInterval(timerInterval);
            timerEl.textContent = "考试时间到！";
            timerEl.style.color = "red";
            alert("考试时间已到，已自动交卷并生成答案包。");
            triggerManualSubmit(true);
            return;
        }
        totalElapsedSeconds++;
        const mins = Math.floor(totalElapsedSeconds / 60);
        const secs = totalElapsedSeconds % 60;
        timerEl.textContent = `已答题 ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

        // 每 10 秒更新一次 localStorage 中的耗时，防止刷新丢进度
        if (totalElapsedSeconds % 10 === 0) {
            try {
                const localB = localStorage.getItem("exam_answer_backup");
                if (localB) {
                    let parsed = JSON.parse(localB);
                    parsed.totalElapsedSeconds = totalElapsedSeconds;
                    localStorage.setItem("exam_answer_backup", JSON.stringify(parsed));
                }
            } catch(e) {}
        }
    }, 1000);
}

function triggerManualSubmit(isForceSystemTimeout) {
    if (isForceSystemTimeout === undefined) isForceSystemTimeout = false;
    if (!isForceSystemTimeout && !confirm("确定要交卷吗？")) return;

    const safePaperPath = encodeURIComponent(examPaperData.paperTitle).replace(/\./g, '%2E');
    const safeStudentPath = encodeURIComponent(studentNameVerified).replace(/\./g, '%2E');

    db.ref(`submittedExamLocks/${safePaperPath}/${safeStudentPath}`).transaction((currentValue) => {
        if (currentValue !== null) { return; }
        return firebase.database.ServerValue.TIMESTAMP;
    }, (error, committed) => {
        if (error || !committed) {
            alert("提交拦截错误：\n系统检测到云端已存在您的交卷流水。您先前已成功交卷，不可重复提交答卷！");
            return;
        }

        clearInterval(timerInterval);
        const payload = {
            paperTitle: examPaperData.paperTitle,
            studentName: studentNameVerified,
            examTimeWindow: `开始: ${examPaperData.startTime} / 结束: ${examPaperData.endTime}`,
            elapsedDuration: `${Math.floor(totalElapsedSeconds / 60)}分${totalElapsedSeconds % 60}秒`,
            submitTime: new Date().toLocaleString(),
            answers: studentAnswers
        };
        try { localStorage.setItem("exam_answer_backup", JSON.stringify(payload)); } catch(e) {}

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `答案_${studentNameVerified}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { URL.revokeObjectURL(downloadUrl); }, 1200);
        try { localStorage.removeItem("exam_answer_backup"); } catch(e) {}

        // 重置所有状态
        Object.keys(studentAnswers).forEach(k => { studentAnswers[k].image = ""; });
        examPaperData = null; studentNameVerified = "";
        currentQuestionIndex = 0; studentAnswers = {}; totalElapsedSeconds = 0;
        currentTargetQuestionId = null;

        document.getElementById('questions-wrapper').innerHTML = "";
        document.getElementById('input-paper-json').value = "";
        document.getElementById('student-name').value = "";
        document.getElementById('student-name-zone').style.display = 'none';
        document.getElementById('exam-app').style.display = 'none';
        document.getElementById('auth-overlay').style.display = 'flex';
    });
}
