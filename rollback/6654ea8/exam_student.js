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
let examSubmitToken = '';
let currentExamReceipt = null;
const STEALTH_SECRET_SALT = "ClassOpticSecurePaperKey2026";
const MAX_PAPER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_FILE_BYTES = 16 * 1024 * 1024;
const MAX_QUESTIONS = 200;
const MAX_TEXT_LENGTH = 20000;
const ALLOWED_QUESTION_TYPES = new Set(['choice', 'judge', 'blank-auto', 'blank-hand', 'calculation']);
const INVALID_FIREBASE_KEY_CHARS = /[.#$\/\[\]<>\u0000-\u001F\u007F]/;
const activeYearReady = SystemRouter.system().once('value').then(snapshot => {
    const sys = snapshot.val();
    if (sys && /^\d{4}$/.test(String(sys.activeYear || ''))) SystemRouter.activeYear = String(sys.activeYear);
}).catch(error => {
    console.error('读取当前学年失败，将使用兼容默认学年:', error);
});

function safeImageDataUrl(value) {
    return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value) ? value : '';
}

function safeJsArg(value) {
    return escapeHtml(JSON.stringify(String(value ?? '')));
}

function validatePaperImage(value) {
    return !value || (safeImageDataUrl(value) && value.length <= 3 * 1024 * 1024);
}

function validateMasterPaperShape(paper) {
    if (!paper || typeof paper !== 'object') return '试卷不是对象。';
    if (typeof paper.paperTitle !== 'string' || !paper.paperTitle.trim() || paper.paperTitle.length > 200) return '试卷名称为空或过长。';
    const start = new Date(paper.startTime).getTime();
    const end = new Date(paper.endTime).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '考试时间窗口不合法。';
    if (!Array.isArray(paper.questions) || paper.questions.length === 0 || paper.questions.length > MAX_QUESTIONS) return `题目数量必须在 1～${MAX_QUESTIONS} 之间。`;
    const ids = new Set();
    for (let i = 0; i < paper.questions.length; i++) {
        const q = paper.questions[i];
        if (!q || typeof q !== 'object' || typeof q.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(q.id) || ids.has(q.id)) return `第 ${i + 1} 题题号不合法或重复。`;
        ids.add(q.id);
        if (!ALLOWED_QUESTION_TYPES.has(q.type)) return `第 ${i + 1} 题题型不受支持。`;
        if (typeof q.stem !== 'string' || !q.stem.trim() || q.stem.length > MAX_TEXT_LENGTH) return `第 ${i + 1} 题题干为空或过长。`;
        const score = Number(q.score);
        if (!Number.isFinite(score) || score <= 0 || score > 1000) return `第 ${i + 1} 题分值不合法。`;
        if (typeof q.standardAnswer !== 'undefined' && String(q.standardAnswer).length > MAX_TEXT_LENGTH) return `第 ${i + 1} 题参考答案过长。`;
        if (q.type === 'choice' && (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 20 || q.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 500))) return `第 ${i + 1} 题选项不合法。`;
        if (!validatePaperImage(q.stemImage) || !validatePaperImage(q.standardAnswerImage)) return `第 ${i + 1} 题图片格式或大小不合法。`;
    }
    return '';
}

function isValidStudentName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 50 && !INVALID_FIREBASE_KEY_CHARS.test(name);
}

function rejectOversizedFile(file, maxBytes) {
    if (!file || file.size <= maxBytes) return false;
    alert(`文件过大，最多允许 ${(maxBytes / 1024 / 1024).toFixed(0)} MB。`);
    return true;
}

function getExamSubmitToken(paperTitle, studentName) {
    const key = `exam_submit_token_${encodeURIComponent(paperTitle)}_${encodeURIComponent(studentName)}`;
    let token = '';
    try { token = localStorage.getItem(key) || ''; } catch (e) {}
    if (!token) {
        token = (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        try { localStorage.setItem(key, token); } catch (e) {}
    }
    return token;
}

function generateExamReceiptId() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return `EX-${Array.from(bytes, value => alphabet[value % alphabet.length]).join('').slice(0, 6)}-${Array.from(bytes, value => alphabet[(value + 7) % alphabet.length]).join('').slice(0, 6)}`;
}

function showExamSubmitReceipt(receipt) {
    currentExamReceipt = { ...receipt };
    const authCard = document.getElementById('exam-auth-card');
    const receiptEl = document.getElementById('exam-submit-receipt');
    if (authCard) authCard.style.display = 'none';
    if (!receiptEl) return;
    document.getElementById('exam-receipt-paper').textContent = receipt.paperTitle;
    document.getElementById('exam-receipt-student').textContent = receipt.studentName;
    document.getElementById('exam-receipt-time').textContent = receipt.submittedAt;
    document.getElementById('exam-receipt-id').textContent = receipt.receiptId;
    receiptEl.style.display = 'block';
}

function closeExamSubmitReceipt() {
    currentExamReceipt = null;
    const receiptEl = document.getElementById('exam-submit-receipt');
    const authCard = document.getElementById('exam-auth-card');
    if (receiptEl) receiptEl.style.display = 'none';
    if (authCard) authCard.style.display = 'block';
}

async function copyExamReceiptId() {
    if (!currentExamReceipt) return;
    try {
        await navigator.clipboard.writeText(currentExamReceipt.receiptId);
        alert('交卷流水号已复制。');
    } catch (error) {
        alert(`请手动记录交卷流水号：${currentExamReceipt.receiptId}`);
    }
}

function downloadExamReceipt() {
    if (!currentExamReceipt) return;
    const text = [
        '模拟考试交卷凭证',
        `试卷：${currentExamReceipt.paperTitle}`,
        `姓名：${currentExamReceipt.studentName}`,
        `交卷时间：${currentExamReceipt.submittedAt}`,
        `交卷流水号：${currentExamReceipt.receiptId}`
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `交卷凭证_${currentExamReceipt.receiptId}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function runTransaction(ref, updateFn) {
    return new Promise((resolve, reject) => {
        ref.transaction(updateFn, (error, committed, snapshot) => {
            if (error) reject(error);
            else resolve({ committed, snapshot });
        });
    });
}

window.openGlobalLightbox = function(imgSrc) {
    const safeSrc = safeImageDataUrl(imgSrc);
    if (!safeSrc) return;
    document.getElementById('global-lightbox-img').src = safeSrc;
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
    if (!light) return;
    light.textContent = '已自动保存';
    light.style.color = '';
    light.classList.add('show');
    setTimeout(() => { light.classList.remove('show'); }, 1200);
}

function showWatermark(name) {
    removeWatermark();
    if (!name) return;
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 220;
    const ctx = canvas.getContext('2d');
    ctx.translate(180, 110);
    ctx.rotate(-20 * Math.PI / 180);
    ctx.font = 'bold 22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 0, 0);
    const layer = document.createElement('div');
    layer.id = 'exam-watermark-layer';
    layer.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;pointer-events:none;' +
        'background-image:url("' + canvas.toDataURL('image/png') + '");background-repeat:repeat;';
    document.body.appendChild(layer);
}

function removeWatermark() {
    const oldLayer = document.getElementById('exam-watermark-layer');
    if (oldLayer) oldLayer.remove();
}

function triggerLiveAntiDisasterBackup() {
    if (!examPaperData || !studentNameVerified) return false;
    const backupPayload = {
        paperTitle: examPaperData.paperTitle,
        studentName: studentNameVerified,
        examTimeWindow: `开始: ${examPaperData.startTime} / 结束: ${examPaperData.endTime}`,
        totalElapsedSeconds: totalElapsedSeconds,
        answers: studentAnswers
    };
    try {
        localStorage.setItem("exam_answer_backup", JSON.stringify(backupPayload));
        triggerSaveStatusLight();
        return true;
    } catch(e) {
        const light = document.getElementById('save-light');
        if (light) {
            light.textContent = '本地备份失败，请立即交卷或删除大图';
            light.style.color = '#d93025';
            light.classList.add('show');
        }
        console.error('本地答案备份失败:', e);
        return false;
    }
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
    if (rejectOversizedFile(file, MAX_PAPER_FILE_BYTES)) { e.target.value = ''; return; }
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
                const validationError = validateMasterPaperShape(decryptedData);
                if (validationError) {
                    document.getElementById('auth-error').textContent = `试卷格式错误：${validationError}`;
                    return;
                }
                examPaperData = decryptedData;
                document.getElementById('student-name-zone').style.display = 'block';
                document.getElementById('auth-error').textContent = "";
            } else { alert("试卷格式错误。"); }
        } catch (err) { alert("解析失败。"); }
    }; reader.readAsText(file);
};

async function verifyAndStartExam() {
    const nameInput = document.getElementById('student-name').value.trim();
    if (!nameInput) return alert("请输入姓名！");
    if (!isValidStudentName(nameInput)) return alert('姓名格式不合法（最多50字，不能包含路径特殊字符）！');
    if (!examPaperData || validateMasterPaperShape(examPaperData)) return alert('试卷状态无效，请重新导入。');
    await activeYearReady;
    const targetYear = SystemRouter.activeYear || "2026";

    const safePaperPath = encodeURIComponent(examPaperData.paperTitle).replace(/\./g, '%2E');
    const safeStudentPath = encodeURIComponent(nameInput).replace(/\./g, '%2E');

    db.ref(`submittedExamLocks/${safePaperPath}/${safeStudentPath}`).once('value').then((lockSnapshot) => {
        const existingLock = lockSnapshot.val();
        // 兼容旧版数字时间戳；新版 pending 只代表一次可恢复的提交流程。
        if (existingLock !== null && (typeof existingLock !== 'object' || existingLock.status === 'submitted')) {
            if (existingLock && existingLock.status === 'submitted' && existingLock.receiptId) {
                showExamSubmitReceipt({
                    paperTitle: examPaperData.paperTitle,
                    studentName: nameInput,
                    submittedAt: existingLock.submittedAt ? new Date(existingLock.submittedAt).toLocaleString() : '已确认',
                    receiptId: existingLock.receiptId
                });
                return;
            }
            document.getElementById('auth-error').textContent = `进入拦截：您(${nameInput})先前已成功提交答卷，不可重复进行考试。`;
            return;
        }

        db.ref(`years/${targetYear}/studentWhitelist`).once('value').then((snapshot) => {
            const isAllowed = snapshot.exists() && Object.values(snapshot.val()).includes(nameInput);
            if (!isAllowed) { document.getElementById('auth-error').textContent = "验证失败：您不在学生白名单内。"; return; }

            studentNameVerified = nameInput;
            examSubmitToken = getExamSubmitToken(examPaperData.paperTitle, studentNameVerified);
            document.getElementById('meta-paper-title').textContent = examPaperData.paperTitle;
            document.getElementById('meta-student-name').textContent = studentNameVerified;
            document.getElementById('meta-time-window').innerHTML = `开始: ${escapeHtml(String(examPaperData.startTime || '').replace('T', ' '))}<br>截止: ${escapeHtml(String(examPaperData.endTime || '').replace('T', ' '))}`;

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
    if (rejectOversizedFile(file, MAX_REVIEW_FILE_BYTES)) { e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const outerPayload = JSON.parse(evt.target.result);
            const pack = decryptStealthPayload(outerPayload.cipher, STEALTH_SECRET_SALT);
            if (!pack || validateMasterPaperShape(pack.masterPaperSnapshot) || !pack.studentAnswersSnapshot || typeof pack.studentAnswersSnapshot !== 'object' || Array.isArray(pack.studentAnswersSnapshot)) return alert("复查包格式错误或已损坏。");
            activeReviewPackageData = pack;
            startReviewPackageWorkspace();
        } catch(err) { alert("解析失败。"); }
    }; reader.readAsText(file);
};

function startReviewPackageWorkspace() {
    document.getElementById('meta-paper-title').textContent = activeReviewPackageData.paperTitle;
    document.getElementById('meta-student-name').textContent = activeReviewPackageData.studentName;
    document.getElementById('meta-time-window').innerHTML = `时段: ${escapeHtml(String(activeReviewPackageData.examTimeWindow || '').replace('开始:', '').replace('结束:', ''))}`;

    const totalQCount = activeReviewPackageData.masterPaperSnapshot.questions.length;
    document.getElementById('total-idx-text').textContent = totalQCount;
    document.getElementById('exam-timer').innerHTML = `得分: <span style="color:red;font-size:18px;">${escapeHtml(activeReviewPackageData.totalScoreResult)}</span>分 | 耗时: ${escapeHtml(activeReviewPackageData.elapsedDuration)}`;

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
        html += `<div class="question-stem">${escapeHtml(String(mq.stem || '')).replace(/\\n|\n/g, '<br>')}</div>`;
        const reviewStemImage = safeImageDataUrl(mq.stemImage);
        if (reviewStemImage) html += `<img src="${escapeHtml(reviewStemImage)}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)">`;

        html += `<div class="review-score-banner" style="background:${isWrong ? '#fef0f0' : '#f0f9eb'}; color:${isWrong ? '#f56c6c' : '#2b6914'}">
                <span>判定：${isWrong ? '扣分项' : '完全正确'}</span><span>实际得分：${earnedScore} / ${mq.score} 分</span>
            </div>`;

        // 教师批改评语（随评卷打分包导出，教师可修改后公开）
        const reviewFeedback = activeReviewPackageData.feedbackMap && activeReviewPackageData.feedbackMap[mq.id];
        if (reviewFeedback) {
            html += `<div class="review-teacher-feedback"><b>教师评语：</b>${escapeHtml(reviewFeedback).replace(/\n/g, '<br>')}</div>`;
        }

        const standardImage = safeImageDataUrl(mq.standardAnswerImage);
        if (standardImage) {
            html += `<div style="margin-top:8px;"><label class="exam-img-label">标准评分细则附图 (点击查看大图)：</label><img src="${escapeHtml(standardImage)}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)"></div>`;
        }

        if (mq.type === 'choice' && mq.options) {
            html += `<div class="options-list" style="margin-top:12px;">`;
            mq.options.forEach(opt => {
                const isSelected = sAns.text === opt.trim().charAt(0);
                html += `<div class="option-item ${isSelected ? 'selected' : ''}" style="pointer-events:none;">${escapeHtml(opt)} ${isSelected ? ' (已选)' : ''}</div>`;
            }); html += `</div>`;
        } else if (mq.type === 'judge') {
            html += `<div class="options-list" style="margin-top:12px;">`;
            const isYes = sAns.text === '√';
            html += `<div class="option-item ${isYes ? 'selected' : ''}" style="pointer-events:none;">正确 (√)</div>`;
            html += `<div class="option-item ${!isYes && sAns.text ? 'selected' : ''}" style="pointer-events:none;">错误 (×)</div>`;
            html += `</div>`;
        } else {
            html += `<div style="margin-top:12px;"><textarea class="text-answer-box" disabled style="background:#f4f4f5;">${escapeHtml(sAns.text) || '(无文字)'}</textarea></div>`;
            const answerImage = safeImageDataUrl(sAns.image);
            if (answerImage) html += `<div><label class="exam-img-label">您的纸质草稿 (点图看大图)：</label><img src="${escapeHtml(answerImage)}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)"></div>`;
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
    showWatermark(activeReviewPackageData.studentName);
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
        html += `<div class="question-stem">${escapeHtml(String(q.stem || '')).replace(/\\n|\n/g, '<br>')}</div>`;
        const stemImage = safeImageDataUrl(q.stemImage);
        if (stemImage) html += `<img src="${escapeHtml(stemImage)}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)">`;

        if (q.type === 'choice' && q.options) {
            html += `<div class="options-list">`;
            q.options.forEach(opt => {
                const isSelected = currentRestoredAnswer.text === opt.trim().charAt(0);
                html += `<div class="option-item ${isSelected ? 'selected' : ''}" onclick="selectOpt(${safeJsArg(q.id)}, ${safeJsArg(opt.trim().charAt(0))}, this)">${escapeHtml(opt)}</div>`;
            });
            html += `</div>`;
        } else if (q.type === 'judge') {
            const isYes = currentRestoredAnswer.text === '√';
            const isNo = currentRestoredAnswer.text === '×';
            html += `<div class="options-list">
                <div class="option-item ${isYes ? 'selected' : ''}" onclick="selectOpt(${safeJsArg(q.id)}, '√', this)">正确 (√)</div>
                <div class="option-item ${isNo ? 'selected' : ''}" onclick="selectOpt(${safeJsArg(q.id)}, '×', this)">错误 (×)</div>
            </div>`;
        } else {
            html += `<textarea class="text-answer-box" placeholder="请输入文字答案，公式无法打字可上传图片"
                oninput="updateTextAnswer(${safeJsArg(q.id)}, this.value)">${escapeHtml(currentRestoredAnswer.text || '')}</textarea>
                <div class="upload-section"><div class="upload-placeholder" onclick="activateCamera(${safeJsArg(q.id)})">点击上传</div>
                    <div class="preview-wrapper" id="prev-box-${escapeHtml(q.id)}" style="${safeImageDataUrl(currentRestoredAnswer.image) ? 'display:inline-block' : 'display:none'}">
                        <button class="btn-remove-img" onclick="removeImg(${safeJsArg(q.id)})">×</button>
                        <img class="click-zoom-img" id="img-view-${escapeHtml(q.id)}" src="${escapeHtml(safeImageDataUrl(currentRestoredAnswer.image))}" onclick="openGlobalLightbox(this.src)">
                    </div>
                </div>`;
        }
        card.innerHTML = html; wrapper.appendChild(card);
    });
    const firstActiveCard = document.getElementById('q-card-0');
    if (window.MathJax) MathJax.typesetPromise([firstActiveCard]).catch(() => {});

    startCountUpTimer();
    document.getElementById('btn-prev').style.visibility = 'hidden';
    showWatermark(studentNameVerified);
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
    // 先清理旧计时器，防止双击「进入考试」等重复进入导致双计时器（耗时 2 倍速累加）
    if (timerInterval) clearInterval(timerInterval);
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

function resumeExamTimerIfAllowed(isForceSystemTimeout) {
    if (isForceSystemTimeout || !examPaperData) return;
    if (Date.now() < new Date(examPaperData.endTime).getTime()) startCountUpTimer();
}

async function triggerManualSubmit(isForceSystemTimeout) {
    if (isForceSystemTimeout === undefined) isForceSystemTimeout = false;
    if (!isForceSystemTimeout && !confirm("确定要交卷吗？")) return;
    if (!examPaperData || !studentNameVerified) return alert('考试状态已失效，请保留本地答案并联系老师。');

    const safePaperPath = encodeURIComponent(examPaperData.paperTitle).replace(/\./g, '%2E');
    const safeStudentPath = encodeURIComponent(studentNameVerified).replace(/\./g, '%2E');
    const lockRef = db.ref(`submittedExamLocks/${safePaperPath}/${safeStudentPath}`);
    const submitToken = examSubmitToken || getExamSubmitToken(examPaperData.paperTitle, studentNameVerified);

    const payload = {
        paperTitle: examPaperData.paperTitle,
        studentName: studentNameVerified,
        examTimeWindow: `开始: ${examPaperData.startTime} / 结束: ${examPaperData.endTime}`,
        elapsedDuration: `${Math.floor(totalElapsedSeconds / 60)}分${totalElapsedSeconds % 60}秒`,
        totalElapsedSeconds,
        submitTime: new Date().toLocaleString(),
        answers: studentAnswers
    };
    try { localStorage.setItem("exam_answer_backup", JSON.stringify(payload)); } catch(e) {}

    try {
        const receiptId = generateExamReceiptId();
        const pending = await runTransaction(lockRef, currentValue => {
            // 旧版数字锁和新版 submitted 都不可重复提交。
            if (typeof currentValue === 'number' || (currentValue && currentValue.status === 'submitted')) return;
            if (currentValue && currentValue.status === 'pending' && currentValue.clientToken !== submitToken) {
                // 30 分钟内的 pending 视为本人仍在进行的流程，不允许覆盖；
                // 超过 30 分钟的陈旧 pending（如换设备/断网遗留）允许放弃重来（规则也已放开超时覆盖）。
                const staleMs = Date.now() - Number(currentValue.createdAt || 0);
                if (!Number.isFinite(staleMs) || staleMs < 30 * 60 * 1000) return;
            }
            return { status: 'pending', clientToken: submitToken, createdAt: firebase.database.ServerValue.TIMESTAMP };
        });
        if (!pending.committed) {
            alert("提交拦截：云端已有已完成或正在处理的交卷流水。若这是本人刚才的操作，请保留本地答案并稍后重试。");
            return;
        }

        clearInterval(timerInterval);
        timerInterval = null;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `答案_${studentNameVerified}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { URL.revokeObjectURL(downloadUrl); }, 1200);

        // 浏览器不会可靠地报告 a.click() 是否真的保存了文件，保留备份并让学生确认后再最终锁定。
        const saved = confirm('答案文件已生成并尝试下载。请确认你已经看到文件并保存成功，再点击“确定”完成交卷；若未保存请点“取消”后重试。');
        if (!saved) {
            alert('交卷暂未完成。当前答案仍保存在本机，可重新点击交卷。');
            resumeExamTimerIfAllowed(isForceSystemTimeout);
            return;
        }

        const finalized = await runTransaction(lockRef, currentValue => {
            if (!currentValue || currentValue.status !== 'pending' || currentValue.clientToken !== submitToken) return;
            return { ...currentValue, status: 'submitted', receiptId, submittedAt: firebase.database.ServerValue.TIMESTAMP };
        });
        if (!finalized.committed) {
            alert('交卷确认失败，答案文件和本地备份均已保留，请稍后重试。');
            resumeExamTimerIfAllowed(isForceSystemTimeout);
            return;
        }
        try { localStorage.removeItem("exam_answer_backup"); } catch(e) {}

        // 重置所有状态
        Object.keys(studentAnswers).forEach(k => { studentAnswers[k].image = ""; });
        examPaperData = null; studentNameVerified = ""; examSubmitToken = '';
        currentQuestionIndex = 0; studentAnswers = {}; totalElapsedSeconds = 0;
        currentTargetQuestionId = null;
        removeWatermark();

        document.getElementById('questions-wrapper').innerHTML = "";
        document.getElementById('input-paper-json').value = "";
        document.getElementById('student-name').value = "";
        document.getElementById('student-name-zone').style.display = 'none';
        document.getElementById('exam-app').style.display = 'none';
        document.getElementById('auth-overlay').style.display = 'flex';
        showExamSubmitReceipt({
            paperTitle: payload.paperTitle,
            studentName: payload.studentName,
            submittedAt: payload.submitTime,
            receiptId
        });
    } catch (submitError) {
        console.error('交卷失败:', submitError);
        alert("提交失败：网络异常，请保留当前答案并重试。");
        resumeExamTimerIfAllowed(isForceSystemTimeout);
    }
}
