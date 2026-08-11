// exam_teacher.js — 教师命题、评卷与成绩排名
let qCount = 0;
let masterPaper = null;
let studentPaper = null;
let singleScores = {};
let classResults = [];
let currentGradingViewMode = "full";
let currentGradingSingleIndex = 0;
let firebaseRankList = [];
let rankingListenerRef = null; // 排名监听器引用，防止重复绑定
const STEALTH_SECRET_SALT = "ClassOpticSecurePaperKey2026";

// ================= 准入守卫：Session 劫持校验 =================
document.addEventListener("DOMContentLoaded", () => {
    const hasAdminPassToken = localStorage.getItem('admin_session_auth');
    if (hasAdminPassToken === 'true') {
        const mask = document.getElementById('teacher-gate-login-mask');
        if (mask) mask.style.display = 'none';
    }
});

function executeManualGateAuth() {
    const tokenInput = document.getElementById('gate-pass-input').value.trim();
    const errLbl = document.getElementById('gate-error-lbl');
    if (!tokenInput) return alert('请输入口令！');

    db.ref(`admin_auth/${tokenInput}`).once('value').then((snapshot) => {
        if (snapshot.exists() && snapshot.val() === true) {
            localStorage.setItem('admin_session_auth', 'true');
            document.getElementById('teacher-gate-login-mask').style.display = 'none';
        } else { errLbl.textContent = '口令错误，直连请求已被系统拦截。'; }
    }).catch(() => { errLbl.textContent = '网络错误，请检查连接后重试。'; });
}

function switchPane(el, id) {
    document.querySelectorAll('.teacher-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.teacher-pane').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    document.getElementById(id).classList.add('active');
    if (id === 'pane-rank') { listenFirebasePaperTitles(); }
}

window.openGlobalLightbox = function(imgSrc) {
    document.getElementById('global-lightbox-img').src = imgSrc;
    document.getElementById('global-lightbox').style.display = 'flex';
};
window.closeGlobalLightbox = function() {
    document.getElementById('global-lightbox').style.display = 'none';
};

// ================= 加解密管道 =================
function encryptEngine(obj, salt) {
    const rawStr = encodeURIComponent(JSON.stringify(obj)); let result = '';
    for (let i = 0; i < rawStr.length; i++) {
        result += String.fromCharCode(rawStr.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
    }
    return btoa(result);
}
function decryptEngine(cipherText, salt) {
    try {
        const rawData = atob(cipherText); let result = '';
        for (let i = 0; i < rawData.length; i++) {
            result += String.fromCharCode(rawData.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
        }
        return JSON.parse(decodeURIComponent(result));
    } catch (e) { return null; }
}

// ================= 出题命卷 =================
function addQ(existingData) {
    if (existingData === undefined) existingData = null;
    qCount++;
    const c = document.getElementById('builder-list-container');
    const div = document.createElement('div');
    div.className = 'question-builder-item';
    div.id = `qb-${qCount}`;
    const n = qCount;

    div.innerHTML = `
        <button class="q-remove-btn" onclick="removeQuestion('${div.id}')" title="删除此题">×</button>
        <div class="q-meta-row">
            <select class="t-type q-type-select" onchange="document.getElementById('opt-box-${n}').style.display = (this.value==='choice')?'block':'none'">
                <option value="choice">选择题</option><option value="judge">判断题</option>
                <option value="blank-auto">客观填空</option><option value="blank-hand">主观填空</option><option value="calculation">计算题</option>
            </select>
            <input type="text" class="t-score q-score-input" placeholder="分值" value="5">
            <input type="text" class="t-ans q-ans-input" placeholder="标准答案（自动阅卷用）">
        </div>
        <textarea class="t-stem q-stem-input" placeholder="输入题干，数学公式用 $...$ 包裹"></textarea>
        <div class="opt-config-div" id="opt-box-${n}" style="display:none;">
            <input type="text" class="t-opts q-opts-input" value="A. , B. , C. , D. " placeholder="选项，逗号分隔">
        </div>
        <div class="img-upload-row">
            <input type="file" accept="image/*" onchange="previewAndSaveStemImage(this, ${n})">
            <input type="hidden" class="t-img-base64">
            <img id="builder-img-view-${n}" class="builder-img-preview">
            <button class="q-img-del-btn" id="builder-img-del-btn-${n}" style="display:none;"
                onclick="clearStemImage(${n})">删除附图</button>
        </div>`;
    c.appendChild(div);

    if (existingData) {
        div.querySelector('.t-type').value = existingData.type;
        div.querySelector('.t-score').value = existingData.score;
        div.querySelector('.t-stem').value = existingData.stem;
        if (existingData.standardAnswer) div.querySelector('.t-ans').value = existingData.standardAnswer;
        if (existingData.type === 'choice' && existingData.options) {
            div.querySelector('.t-opts').value = existingData.options.join(', ');
        }
        if (existingData.stemImage) {
            div.querySelector('.t-img-base64').value = existingData.stemImage;
            const imgView = document.getElementById(`builder-img-view-${n}`);
            imgView.src = existingData.stemImage;
            imgView.style.display = 'block';
            document.getElementById(`builder-img-del-btn-${n}`).style.display = 'inline-block';
        }
    }
    document.getElementById(`opt-box-${n}`).style.display =
        (div.querySelector('.t-type').value === 'choice') ? 'block' : 'none';

    // 滚动到新试题
    div.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 删除单题
function removeQuestion(divId) {
    const el = document.getElementById(divId);
    if (el) el.remove();
}

// 清空全部试题
function clearAllQuestions() {
    const container = document.getElementById('builder-list-container');
    if (container.children.length === 0) return;
    if (!confirm('确定要清空全部试题吗？此操作不可恢复。')) return;
    container.innerHTML = '';
    qCount = 0;
}

// 清理试题附图
function clearStemImage(n) {
    document.getElementById(`qb-${n}`).querySelector('.t-img-base64').value = '';
    document.getElementById(`builder-img-view-${n}`).style.display = 'none';
    document.getElementById(`builder-img-del-btn-${n}`).style.display = 'none';
}

window.previewAndSaveStemImage = function(fileInput, id) {
    const file = fileInput.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        // 压缩试题图片避免母卷过大
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            const MAX = 800;
            if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const compressed = canvas.toDataURL('image/jpeg', 0.7);
            const row = document.getElementById(`qb-${id}`);
            row.querySelector('.t-img-base64').value = compressed;
            const imgView = document.getElementById('builder-img-view-' + id);
            imgView.src = compressed;
            imgView.style.display = 'block';
            document.getElementById('builder-img-del-btn-' + id).style.display = 'inline-block';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
};

document.getElementById('reimport-master-to-edit').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = function(evt) {
        try {
            const oldMaster = JSON.parse(evt.target.result);
            document.getElementById('make-title').value = oldMaster.paperTitle || "";
            document.getElementById('make-start').value = oldMaster.startTime || "";
            document.getElementById('make-end').value = oldMaster.endTime || "";
            document.getElementById('builder-list-container').innerHTML = "";
            qCount = 0;
            oldMaster.questions.forEach(q => { addQ(q); });
            alert(`试卷数据重载成功！`);
        } catch (err) { alert("读取失败！"); }
    }; r.readAsText(file);
};

function exportJsonPapers() {
    const title = document.getElementById('make-title').value.trim();
    const start = document.getElementById('make-start').value;
    const end = document.getElementById('make-end').value;
    if (!title || !start || !end) return alert("请完整填写考试名称与时间。");

    const items = document.querySelectorAll('.question-builder-item');
    if (items.length === 0) return alert("请至少添加一道试题再导出！");

    let tQ = []; let sQ = [];
    items.forEach((el, idx) => {
        const id = "q_" + (idx + 1);
        const type = el.querySelector('.t-type').value;
        const score = parseFloat(el.querySelector('.t-score').value) || 0;
        const stem = el.querySelector('.t-stem').value.trim();
        const standardAnswer = el.querySelector('.t-ans').value.trim();
        const stemImage = el.querySelector('.t-img-base64').value || "";
        let options = [];
        if (type === 'choice') options = el.querySelector('.t-opts').value.split(',').map(o => o.trim());
        tQ.push({ id, type, score, stem, standardAnswer, stemImage, options });
        sQ.push({ id, type, score, stem, stemImage, options });
    });

    triggerDl({ paperTitle: title, startTime: start, endTime: end, questions: tQ }, 'exam_teacher_master.json');
    const secureStudentCipher = encryptEngine({ paperTitle: title, startTime: start, endTime: end, questions: sQ }, STEALTH_SECRET_SALT);
    triggerDl({ isEncrypted: true, cipher: secureStudentCipher }, 'exam_student_release.json');
    alert("试卷文件已导出。");
}

function triggerDl(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl; a.download = name; a.click();
    setTimeout(() => { URL.revokeObjectURL(downloadUrl); }, 1000);
}

// ================= AI 批改 =================
let aiConfig = { url: '', key: '', model: '' };
let aiGradingBusy = false;

// 加载 AI 配置
(function loadAiConfig() {
    db.ref('settings/aiConfig').once('value').then(snap => {
        const v = snap.val();
        if (v) {
            aiConfig = v;
            const urlEl = document.getElementById('ai-api-url');
            const keyEl = document.getElementById('ai-api-key');
            const modelEl = document.getElementById('ai-model');
            if (urlEl) urlEl.value = v.url || '';
            if (keyEl) keyEl.value = v.key || '';
            if (modelEl) modelEl.value = v.model || '';
        }
    });
})();

// 保存 AI 配置
function saveAiConfig() {
    aiConfig.url = document.getElementById('ai-api-url').value.trim();
    aiConfig.key = document.getElementById('ai-api-key').value.trim();
    aiConfig.model = document.getElementById('ai-model').value.trim();
    if (!aiConfig.url || !aiConfig.key || !aiConfig.model) {
        return alert('请完整填写 API 地址、Key 和模型名称！');
    }
    db.ref('settings/aiConfig').set(aiConfig).then(() => {
        document.getElementById('ai-config-status').textContent = '已保存';
        setTimeout(() => { document.getElementById('ai-config-status').textContent = ''; }, 2000);
    }).catch(() => { alert('保存失败'); });
}

// OCR 识别图片中的文字
async function ocrImage(base64) {
    const resp = await fetch(aiConfig.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.key}` },
        body: JSON.stringify({
            model: aiConfig.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: '请识别图片中的所有文字和公式，直接输出识别结果，不要额外说明。' },
                    { type: 'image_url', image_url: { url: base64 } }
                ]
            }],
            max_tokens: 1000
        })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '(OCR未识别出内容)';
}

// AI 批改单道题，返回 { score, feedback }
async function gradeQuestionWithAI(qIndex) {
    const mq = masterPaper.questions[qIndex];
    const sAnsObj = studentPaper.answers[mq.id] || { text: '', image: '' };
    const qNum = qIndex + 1;

    // 设置 loading 状态
    const fbDiv = document.getElementById(`ai-feedback-${qIndex}`);
    if (fbDiv) fbDiv.innerHTML = '<div class="ai-loading">AI 批改中...</div>';

    try {
        let studentText = sAnsObj.text || '';

        // 有图片先 OCR
        if (sAnsObj.image) {
            studentText += '\n[手写OCR结果]: ' + await ocrImage(sAnsObj.image);
        }

        if (!studentText.trim()) {
            return { score: 0, feedback: '学生未作答。' };
        }

        // 构建 prompt
        const prompt = `你是专业课阅卷老师。请严格批改学生答案并给出分数和详细反馈。

【题目】${mq.stem.replace(/\\n/g, '\n')}
【题型】${mq.type === 'choice' ? '选择题' : mq.type === 'judge' ? '判断题' : '主观题'}
【满分】${mq.score} 分
【参考答案】${mq.standardAnswer || '无标准答案，根据题意自行判断'}
${mq.type === 'choice' && mq.options ? '【选项】' + mq.options.join(', ') : ''}
【学生答案】${studentText}

请返回 JSON（不要markdown代码块，纯JSON）：
{"score": 数字(0到${mq.score}), "feedback": "详细批改意见（指出错误和不足，给出改进建议）"}`;

        const resp = await fetch(aiConfig.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.key}` },
            body: JSON.stringify({
                model: aiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 2000,
                temperature: 0.3
            })
        });

        if (!resp.ok) throw new Error(`API ${resp.status}: ${resp.statusText}`);

        const data = await resp.json();
        let raw = data.choices?.[0]?.message?.content || '';

        // 尝试解析 JSON（可能被包裹在 markdown 代码块中）
        raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const result = JSON.parse(raw);

        return {
            score: Math.max(0, Math.min(parseFloat(result.score) || 0, mq.score)),
            feedback: result.feedback || '无反馈'
        };
    } catch (err) {
        console.error('AI 批改失败:', err);
        return { score: -1, feedback: '批改失败: ' + err.message };
    }
}

// 显示 AI 反馈并更新分数
function showAIFeedback(qIndex, result) {
    const fbDiv = document.getElementById(`ai-feedback-${qIndex}`);
    if (!fbDiv) return;

    if (result.score >= 0) {
        const mq = masterPaper.questions[qIndex];
        fbDiv.innerHTML = `<div class="ai-feedback-card">
            <div class="ai-feedback-header">
                <span>AI 建议得分: <b class="text-red">${result.score}</b> / ${mq.score}</span>
                <button class="ai-accept-btn" onclick="acceptAIScore(${qIndex}, ${result.score})">采纳分数</button>
            </div>
            <div class="ai-feedback-body">${escapeHtml(result.feedback)}</div>
        </div>`;
        // 自动填入分数框
        const scoreInput = document.getElementById(`score-input-id-${qIndex}`);
        if (scoreInput) scoreInput.value = result.score;
        singleScores[mq.id] = result.score;
        updateLiveScoreUI(qIndex, result.score, mq.score);
    } else {
        fbDiv.innerHTML = `<div class="ai-feedback-card ai-feedback-error">${result.feedback}</div>`;
    }
}

// 采纳 AI 分数
function acceptAIScore(qIndex, score) {
    const mq = masterPaper.questions[qIndex];
    singleScores[mq.id] = score;
    const scoreInput = document.getElementById(`score-input-id-${qIndex}`);
    if (scoreInput) scoreInput.value = score;
    updateLiveScoreUI(qIndex, score, mq.score);
    document.getElementById(`ai-feedback-${qIndex}`).querySelector('.ai-accept-btn').textContent = '已采纳';
    document.getElementById(`ai-feedback-${qIndex}`).querySelector('.ai-accept-btn').disabled = true;
}

// 更新分数 UI（导航点颜色等）
function updateLiveScoreUI(index, score, maxScore) {
    const targetDot = document.querySelector(`.dot-id-${index}`);
    if (targetDot) {
        targetDot.className = (score >= maxScore) ? 'q-nav-dot correct active' : 'q-nav-dot wrong active';
    }
}

// 单题 AI 批改入口
async function gradeSingleWithAI(qIndex) {
    if (!aiConfig.url || !aiConfig.key) return alert('请先在 AI 批改设置中配置 API！');
    const result = await gradeQuestionWithAI(qIndex);
    showAIFeedback(qIndex, result);
}

// AI 批改全部题目
async function gradeAllWithAI() {
    if (!aiConfig.url || !aiConfig.key) return alert('请先在 AI 批改设置中配置 API！');
    if (!masterPaper || !studentPaper) return alert('请先导入母卷和学生答案！');
    if (aiGradingBusy) return alert('正在批改中，请等待...');
    if (!confirm(`确定要对全部 ${masterPaper.questions.length} 道题进行 AI 批改吗？`)) return;

    aiGradingBusy = true;
    const btn = document.querySelector('.ai-grade-all-btn');
    const origText = btn.textContent;
    btn.textContent = '批改中...';
    btn.disabled = true;

    for (let i = 0; i < masterPaper.questions.length; i++) {
        btn.textContent = `批改中 ${i + 1}/${masterPaper.questions.length}...`;
        // 切换到单题模式以便看到每道题
        if (currentGradingViewMode !== 'single') {
            document.getElementById('mode-btn-single').click();
        }
        navigateSingleQTo(i);

        const result = await gradeQuestionWithAI(i);
        showAIFeedback(i, result);

        // 短暂延迟避免 API 限流
        await new Promise(r => setTimeout(r, 500));
    }

    btn.textContent = origText;
    btn.disabled = false;
    aiGradingBusy = false;
    alert('AI 批改全部完成！请逐一检查并调整分数后导出。');
}

// 单题跳转（用于 AI 批改逐题展示）
function navigateSingleQTo(index) {
    document.querySelectorAll('.grade-item-card').forEach(c => c.classList.add('hidden-card'));
    currentGradingSingleIndex = index;
    const curCard = document.querySelector(`.g-card-idx-${index}`);
    if (curCard) curCard.classList.remove('hidden-card');
    highlightActiveDot(index);
}

// ================= 阶段二：评卷中心 =================
document.getElementById('load-master').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = function(evt) {
        masterPaper = JSON.parse(evt.target.result);
        alert(`母卷载入就绪！`);
        document.getElementById('student-file-zone').style.display = 'block';
    }; r.readAsText(file);
};

document.getElementById('load-answer').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = function(evt) {
        try {
            const parsed = JSON.parse(evt.target.result);
            if (!parsed || !parsed.studentName || !parsed.answers) {
                alert("错误：非合法的学生答案数据。");
                return;
            }
            studentPaper = parsed;
            document.getElementById('g-name').textContent = studentPaper.studentName;
            document.getElementById('g-duration').textContent = studentPaper.elapsedDuration || "未知";
            document.getElementById('g-submit').textContent = studentPaper.submitTime || "-";
            currentGradingSingleIndex = 0;

            if (masterPaper) { renderGradingInterface(); }
            else { alert("请先导入本地教师明文母卷。"); }
        } catch(e) { alert("学生答卷数据解析失败。"); }
    }; r.readAsText(file);
};

function renderGradingInterface() {
    if (!masterPaper) return alert("请先导入教师明文母卷 (Master)。");

    const container = document.getElementById('grading-loop-container');
    container.innerHTML = "";
    const gridDots = document.getElementById('grading-grid-dots');
    gridDots.innerHTML = '';
    singleScores = {};

    masterPaper.questions.forEach((mq, index) => {
        const sAnsObj = studentPaper.answers[mq.id] || { text: "", image: "" };
        const textAns = (sAnsObj.text || "").trim();
        const imageAns = sAnsObj.image || "";
        const div = document.createElement('div');
        div.className = `grade-item-card g-card-idx-${index}`;
        div.id = `grade-card-id-${mq.id}`;

        const isCorrect = (textAns.toUpperCase() === mq.standardAnswer.trim().toUpperCase());
        const autoScore = (mq.type === 'choice' || mq.type === 'judge' || mq.type === 'blank-auto') ? (isCorrect ? mq.score : 0) : 0;
        singleScores[mq.id] = autoScore;

        let cleanStem = mq.stem.replace(/\\n/g, "\n");
        let html = `<div class="grade-item-stem"><b>题目 ${index + 1}</b> [型: ${mq.type}]：\n${escapeHtml(cleanStem)}</div>`;
        if (mq.stemImage) html += `<img src="${mq.stemImage}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)" title="点击查看大图">`;

        html += `
            <div class="grading-answer-editor">
                <div style="display:flex; gap:10px; align-items:center; flex-wrap: wrap;">
                    <b>修改参考答案：</b>
                    <input type="text" value="${mq.standardAnswer || ''}" class="grading-ans-input"
                        oninput="liveUpdateStandardAnswer('${mq.id}', this.value, ${index})">
                </div>
                <div style="margin-top:8px; display:flex; align-items:center; gap:10px; flex-wrap: wrap;">
                    <b>更新评分细则附图：</b>
                    <input type="file" accept="image/*" onchange="liveUpdateMasterQImage(this, '${mq.id}', ${index})" style="width:auto; max-width:220px; font-size:12px;">
                </div>
                <div id="live-master-img-box-${index}" style="margin-top:8px; ${mq.standardAnswerImage ? 'display:block' : 'display:none'}">
                    <img id="live-master-img-render-${index}" src="${mq.standardAnswerImage || ''}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)">
                </div>
            </div>`;

        let imgAppendHtml = imageAns ? `<br><img class="click-zoom-img" src="${imageAns}" onclick="openGlobalLightbox(this.src)">` : ``;

        if (mq.type === 'choice' || mq.type === 'judge' || mq.type === 'blank-auto') {
            html += `<div class="grading-split">
                <div class="ans-panel" id="ans-panel-render-${index}" style="background:${isCorrect ? '#f0f9eb' : '#fef0f0'}">
                    <div>同学填报文字：<b id="stud-text-lbl-${index}">${escapeHtml(textAns) || '(空)'}</b> | 动态标答比对：<b id="master-text-lbl-${index}" class="text-blue">${escapeHtml(mq.standardAnswer)}</b></div>${imgAppendHtml}
                </div>
                <div class="score-panel">
                    <label class="score-input-label">终审赋分框：</label>
                    <input type="number" min="0" max="${mq.score}" step="0.5" id="score-input-id-${index}" value="${autoScore}"
                        onchange="updateLiveScore('${mq.id}', this.value, ${index})">
                </div>
            </div>`;
        } else {
            let imgHtml = imageAns
                ? `<img class="click-zoom-img" src="${imageAns}" onclick="openGlobalLightbox(this.src)">`
                : `<span class="text-gray" style="font-size:13px;">（该同学未拍照提交有效证明演算草稿）</span>`;
            html += `<div class="grading-split">
                <div class="ans-panel"><div>同学打字或简答应答：<code>${escapeHtml(textAns) || '(无)'}</code></div>
                <div style="margin-top:8px; border-top:1px dashed #eee; padding-top:5px;">手写快照：<br>${imgHtml}</div></div>
                <div class="score-panel">
                    <label class="score-input-label">本题满分 ${mq.score} 分</label>
                    <input type="number" min="0" max="${mq.score}" step="0.5" placeholder="请在此赋分"
                        onchange="updateLiveScore('${mq.id}', this.value, ${index})" class="manual-score-input">
                </div>
            </div>`;
        }
        // AI 批改按钮 + 反馈区
        html += `<div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
            <button class="teacher-btn teacher-btn-sm ai-grade-btn" onclick="gradeSingleWithAI(${index})" style="background:#8e44ad;color:#fff;">AI 批改本题</button>
            <div id="ai-feedback-${index}" style="flex:1;"></div>
        </div>`;
        div.innerHTML = html; container.appendChild(div);

        const dot = document.createElement('div');
        dot.className = `q-nav-dot dot-id-${index}`;
        dot.textContent = index + 1;
        if ((mq.type === 'choice' || mq.type === 'judge' || mq.type === 'blank-auto')) {
            dot.className = isCorrect ? "q-nav-dot correct" : "q-nav-dot wrong";
        }

        dot.onclick = () => {
            if (currentGradingViewMode === 'single') {
                document.querySelectorAll('.grade-item-card').forEach(c => c.classList.add('hidden-card'));
                const targetCard = document.querySelector(`.g-card-idx-${index}`);
                if (targetCard) targetCard.classList.remove('hidden-card');
                currentGradingSingleIndex = index;
                highlightActiveDot(index);
                if (window.MathJax) MathJax.typesetPromise([targetCard]).catch(() => {});
            } else {
                document.getElementById(`grade-card-id-${mq.id}`).scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        };
        gridDots.appendChild(dot);
    });
    document.getElementById('grading-workspace-root').style.display = 'flex';
    switchViewMode(currentGradingViewMode);
    if (window.MathJax) window.MathJax.typesetPromise([container]).catch(() => {});
}

window.liveUpdateStandardAnswer = function(qId, newVal, index) {
    const mq = masterPaper.questions[index];
    mq.standardAnswer = newVal.trim();
    const masterLbl = document.getElementById(`master-text-lbl-${index}`);
    if (masterLbl) masterLbl.textContent = mq.standardAnswer;

    if (mq.type === 'choice' || mq.type === 'judge' || mq.type === 'blank-auto') {
        const sAnsObj = studentPaper.answers[qId] || { text: "" };
        const textAns = sAnsObj.text || "";
        const isCorrect = (textAns.trim().toUpperCase() === mq.standardAnswer.trim().toUpperCase());
        const reCalculatedScore = isCorrect ? mq.score : 0;

        singleScores[qId] = reCalculatedScore;
        const scoreInput = document.getElementById(`score-input-id-${index}`);
        if (scoreInput) scoreInput.value = reCalculatedScore;
        const panel = document.getElementById(`ans-panel-render-${index}`);
        if (panel) panel.style.background = isCorrect ? '#f0f9eb' : '#fef0f0';
        const dot = document.querySelector(`.dot-id-${index}`);
        if (dot) dot.className = isCorrect ? "q-nav-dot correct active" : "q-nav-dot wrong active";
    }
};

window.liveUpdateMasterQImage = function(fileInput, qId, index) {
    const file = fileInput.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = function(e) {
        // 压缩附图
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            const MAX = 800;
            if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            masterPaper.questions[index].standardAnswerImage = canvas.toDataURL('image/jpeg', 0.7);
            document.getElementById(`live-master-img-render-${index}`).src = masterPaper.questions[index].standardAnswerImage;
            document.getElementById(`live-master-img-box-${index}`).style.display = "block";
        };
        img.src = e.target.result;
    };
    r.readAsDataURL(file);
};

window.updateLiveScore = function(qId, val, dotIdx) {
    const maxScoreBoundary = masterPaper.questions[dotIdx].score;
    let finalV = parseFloat(val) || 0;
    finalV = Math.max(0, Math.min(finalV, maxScoreBoundary));

    singleScores[qId] = finalV;
    const targetDot = document.querySelector(`.dot-id-${dotIdx}`);
    if (targetDot) {
        targetDot.className = (finalV >= maxScoreBoundary) ? "q-nav-dot correct active" : "q-nav-dot wrong active";
    }
};

window.switchViewMode = function(mode) {
    currentGradingViewMode = mode;
    document.getElementById('mode-btn-full').classList.toggle('active', mode === 'full');
    document.getElementById('mode-btn-single').classList.toggle('active', mode === 'single');
    document.getElementById('single-navigator-zone').style.display = (mode === 'single') ? 'block' : 'none';

    if (mode === 'full') {
        document.querySelectorAll('.grade-item-card').forEach(c => c.classList.remove('hidden-card'));
    } else {
        document.querySelectorAll('.grade-item-card').forEach(c => c.classList.add('hidden-card'));
        const cur = document.querySelector(`.g-card-idx-${currentGradingSingleIndex}`);
        if (cur) {
            cur.classList.remove('hidden-card');
            if (window.MathJax) MathJax.typesetPromise([cur]).catch(() => {});
        }
        highlightActiveDot(currentGradingSingleIndex);
    }
};

window.navigateSingleQ = function(step) {
    let target = currentGradingSingleIndex + step;
    if (target < 0 || target >= masterPaper.questions.length) return;

    document.querySelectorAll('.grade-item-card').forEach(c => c.classList.add('hidden-card'));
    currentGradingSingleIndex = target;

    const curCard = document.querySelector(`.g-card-idx-${currentGradingSingleIndex}`);
    if (curCard) {
        curCard.classList.remove('hidden-card');
        if (window.MathJax) MathJax.typesetPromise([curCard]).catch(() => {});
    }
    highlightActiveDot(currentGradingSingleIndex);
};

function highlightActiveDot(index) {
    document.querySelectorAll('#grading-grid-dots .q-nav-dot').forEach(d => d.classList.remove('active'));
    const d = document.querySelector(`.dot-id-${index}`);
    if (d) d.classList.add('active');
}

function saveStudentScoreAndPackage() {
    let total = 0;
    for (let k in singleScores) { total += singleScores[k]; }
    const scorePackage = {
        studentName: studentPaper.studentName,
        elapsedDuration: studentPaper.elapsedDuration || "未知",
        submitTime: studentPaper.submitTime,
        paperTitle: masterPaper.paperTitle,
        examTimeWindow: studentPaper.examTimeWindow,
        totalScoreResult: total,
        scoredMap: singleScores,
        masterPaperSnapshot: masterPaper,
        studentAnswersSnapshot: studentPaper.answers
    };
    const encryptedReviewCipher = encryptEngine(scorePackage, STEALTH_SECRET_SALT);

    const blob = new Blob([JSON.stringify({ isReviewPackage: true, cipher: encryptedReviewCipher }, null, 2)], { type: 'application/json' });
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = `评卷打分包_${studentPaper.studentName}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { URL.revokeObjectURL(dlUrl); }, 1000);

    const safePaperKey = encodeURIComponent(masterPaper.paperTitle).replace(/\./g, '%2E');
    const safeStudentKey = encodeURIComponent(studentPaper.studentName).replace(/\./g, '%2E');

    db.ref(`examRankings/${safePaperKey}/${safeStudentKey}`).set({
        name: studentPaper.studentName,
        paperTitle: masterPaper.paperTitle,
        time: studentPaper.submitTime,
        score: total
    }).then(() => {
        classResults = classResults.filter(i => i.name !== studentPaper.studentName);
        classResults.push({
            name: studentPaper.studentName,
            time: studentPaper.submitTime,
            score: total,
            paperTitle: masterPaper.paperTitle
        });
        renderGlobalScoreSummaryTable();
        alert(`保存完成，打分包已导出。`);
    }).catch(() => { alert('保存失败，请检查网络后重试。'); });
}

function renderGlobalScoreSummaryTable() {
    let h = `<table border="1" class="score-summary-table">
                <tr class="score-summary-header"><th>学生姓名</th><th>试卷科目大名</th><th>交卷时间</th><th>最终总分 (双击修改)</th><th>管理操作</th></tr>`;
    classResults.forEach((r, idx) => {
        h += `<tr><td><b>${escapeHtml(r.name)}</b></td><td>${escapeHtml(r.paperTitle)}</td><td>${r.time}</td>
                <td><span class="score-editable" ondblclick="manuallyOverrideTotalScore(${idx})">${r.score}</span></td>
                <td><button class="teacher-btn teacher-btn-sm" style="background:#ff4d4f;color:#fff;" onclick="removeRecordFromSummaryTable(${idx})">删除</button></td></tr>`;
    });
    document.getElementById('table-render').innerHTML = h + "</table>";
    document.getElementById('summary-zone').style.display = classResults.length > 0 ? 'block' : 'none';
}

window.manuallyOverrideTotalScore = function(idx) {
    const oldS = classResults[idx].score;
    const newS = prompt(`请输入 ` + classResults[idx].name + ` 的最新总分：`, oldS);
    if (newS !== null && !isNaN(parseFloat(newS))) {
        classResults[idx].score = parseFloat(newS);
        renderGlobalScoreSummaryTable();
    }
};

window.removeRecordFromSummaryTable = function(idx) {
    if (confirm(`确定要删除该记录吗？`)) {
        classResults.splice(idx, 1);
        renderGlobalScoreSummaryTable();
    }
};

// ================= 阶段四：成绩排名 =================
function listenFirebasePaperTitles() {
    const selector = document.getElementById('rank-paper-selector');
    if (!selector) return;

    // 解绑旧监听器，防止重复绑定
    if (rankingListenerRef) {
        db.ref('examRankings').off('value', rankingListenerRef);
    }

    rankingListenerRef = db.ref('examRankings').on('value', (snapshot) => {
        const cachedSelectedValue = selector.value;
        selector.innerHTML = "";
        if (!snapshot.exists()) {
            const opt = document.createElement('option');
            opt.textContent = "云端数据库暂无试卷记录";
            selector.appendChild(opt);
            return;
        }
        Object.keys(snapshot.val()).forEach(encKey => {
            const opt = document.createElement('option');
            opt.value = encKey;
            opt.textContent = decodeURIComponent(encKey);
            selector.appendChild(opt);
        });
        if (cachedSelectedValue && snapshot.val()[cachedSelectedValue]) {
            selector.value = cachedSelectedValue;
        }
        calculateAndRenderRankDashboard();
    });
}

// 下拉切换时刷新排名（替代原来不存在的 loadRankDataFromFirebase）
document.getElementById('rank-paper-selector').onchange = function() {
    calculateAndRenderRankDashboard();
};

function calculateAndRenderRankDashboard() {
    const wrapper = document.getElementById('rank-table-wrapper');
    const selector = document.getElementById('rank-paper-selector');
    const currentSelectedEncKey = selector.value;

    if (!currentSelectedEncKey || currentSelectedEncKey === "云端数据库暂无试卷记录") {
        wrapper.innerHTML = `<p class="msg-hint">云端暂无归档数据。</p>`;
        document.getElementById('stat-count').textContent = "0";
        document.getElementById('stat-average').textContent = "0.00";
        return;
    }

    db.ref(`examRankings/${currentSelectedEncKey}`).once('value', (snapshot) => {
        firebaseRankList = [];
        if (!snapshot.exists()) {
            wrapper.innerHTML = `<p class="msg-hint">暂无学生成绩。</p>`;
            document.getElementById('stat-count').textContent = "0";
            document.getElementById('stat-average').textContent = "0.00";
            return;
        }

        const studentsDataObj = snapshot.val();
        for (let k in studentsDataObj) { firebaseRankList.push(studentsDataObj[k]); }
        firebaseRankList.sort((a, b) => b.score - a.score);

        let totalSumScore = 0;
        firebaseRankList.forEach(item => totalSumScore += item.score);
        const validLength = firebaseRankList.length;
        document.getElementById('stat-count').textContent = validLength;
        document.getElementById('stat-average').textContent = validLength ? (totalSumScore / validLength).toFixed(2) : "0.00";

        let tableHtml = `<table border="1" class="rank-table">
            <tr class="rank-table-header"><th style="width:90px; text-align:center;">名次</th><th>学生真实姓名</th><th>考试科目大名</th><th class="text-red text-bold">最终考试得分</th><th>单据递交时间</th><th style="width:100px; text-align:center;">管理操作</th></tr>`;

        firebaseRankList.forEach((row, idx) => {
            const absoluteRankNumber = idx + 1;
            let rankLabelHtml = `<b>${absoluteRankNumber}</b>`;
            if (absoluteRankNumber <= 3) {
                rankLabelHtml = `<div class="rank-gold-lbl">第 ${absoluteRankNumber} 名</div>`;
            }

            tableHtml += `<tr><td style="text-align:center;">${rankLabelHtml}</td><td><b>${escapeHtml(row.name)}</b></td><td>${escapeHtml(row.paperTitle)}</td>
                <td><span class="rank-score" ondblclick="manuallyOverrideCloudScore('${currentSelectedEncKey}', '${encodeURIComponent(row.name).replace(/\./g, '%2E')}', ${row.score})">${row.score} 分</span></td>
                <td class="text-gray" style="font-size:12px;">${escapeHtml(row.time)}</td>
                <td style="text-align:center;"><button class="teacher-btn teacher-btn-sm" style="background:#ff4d4f;color:#fff;" onclick="removeRecordFromCloud('${currentSelectedEncKey}', '${encodeURIComponent(row.name).replace(/\./g, '%2E')}')">删除</button></td></tr>`;
        });
        wrapper.innerHTML = tableHtml + `</table>`;
    }).catch(() => { wrapper.innerHTML = '<p class="msg-error">加载排名数据失败。</p>'; });
}

window.manuallyOverrideCloudScore = function(paperKey, studentKey, oldScore) {
    const newScore = prompt(`请输入修改后的最新分数：`, oldScore);
    if (newScore !== null && !isNaN(parseFloat(newScore))) {
        db.ref(`examRankings/${paperKey}/${studentKey}/score`).set(parseFloat(newScore))
            .then(() => { calculateAndRenderRankDashboard(); })
            .catch(() => { alert('修改失败，请重试。'); });
    }
};

window.removeRecordFromCloud = function(paperKey, studentKey) {
    if (confirm("确定要删除云端此记录吗？")) {
        db.ref(`examRankings/${paperKey}/${studentKey}`).remove()
            .then(() => { calculateAndRenderRankDashboard(); })
            .catch(() => { alert('删除失败，请重试。'); });
    }
};

function exportCSV(isLocalDump) {
    if (isLocalDump === undefined) isLocalDump = false;
    let exportSortedList = [];
    let fileNameSuffix = "打分导出";

    if (isLocalDump) {
        if (classResults.length === 0) return alert("暂无本地成绩可导出！");
        exportSortedList = [...classResults].sort((a, b) => b.score - a.score);
        fileNameSuffix = "本地增量暂存";
    } else {
        if (firebaseRankList.length === 0) return alert("当前无有效记录！");
        exportSortedList = firebaseRankList;
        const selector = document.getElementById('rank-paper-selector');
        if (selector && selector.selectedIndex >= 0) {
            fileNameSuffix = selector.options[selector.selectedIndex].text;
        }
    }
    let csv = "﻿名次,姓名,试卷科目,最终总分,交卷时间\n";
    exportSortedList.forEach((r, idx) => {
        csv += `${idx + 1},"${r.name}","${r.paperTitle || ''}",${r.score},"${r.time}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `试卷排名成绩表_${fileNameSuffix}.csv`;
    a.click();
}

// ================= 阶段三：成绩复查 =================
document.getElementById('load-review-package').onchange = function(e) {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = function(evt) {
        try {
            const outerPayload = JSON.parse(evt.target.result);
            const pack = decryptEngine(outerPayload.cipher, STEALTH_SECRET_SALT);
            if (!pack) return alert("解密失败！");
            renderReviewWorkspace(pack);
        } catch(err) { alert("解析失败！"); }
    }; r.readAsText(file);
};

function renderReviewWorkspace(pack) {
    document.getElementById('r-name').textContent = pack.studentName;
    document.getElementById('r-duration').textContent = pack.elapsedDuration;
    document.getElementById('r-submit').textContent = pack.submitTime || "未知";
    document.getElementById('r-window').textContent = pack.examTimeWindow || "-";
    document.getElementById('r-total-score').textContent = pack.totalScoreResult;

    const container = document.getElementById('review-loop-container');
    container.innerHTML = '';
    const dotsGrid = document.getElementById('review-grid-dots');
    dotsGrid.innerHTML = '';

    pack.masterPaperSnapshot.questions.forEach((mq, index) => {
        const sAns = pack.studentAnswersSnapshot[mq.id] || { text: "未答", image: "" };
        const earnedScore = pack.scoredMap[mq.id] || 0;
        const isWrong = earnedScore < mq.score;

        const card = document.createElement('div');
        card.id = `review-item-id-${index}`;
        card.className = `review-card ${isWrong ? 'review-card-wrong' : 'review-card-correct'}`;

        let cleanReviewStem = mq.stem.replace(/\\n/g, "\n");
        let h = `<div class="grade-item-stem"><b>第 ${index + 1} 题</b>：\n${escapeHtml(cleanReviewStem)}</div>`;
        if (mq.stemImage) { h += `<img src="${mq.stemImage}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)">`; }
        if (mq.standardAnswerImage) { h += `<div style="margin:8px 0;"><img src="${mq.standardAnswerImage}" class="click-zoom-img" onclick="openGlobalLightbox(this.src)"></div>`; }

        let imgAppend = sAns.image ? `<br><img class="click-zoom-img" src="${sAns.image}" onclick="openGlobalLightbox(this.src)">` : '';

        h += `<div class="grading-split">
            <div class="ans-panel"><div>同学应答：<b>${escapeHtml(sAns.text) || '(空)'}</b></div>${mq.standardAnswer ? `<div class="text-blue" style="margin-top:5px;">参考答案：<b>${escapeHtml(mq.standardAnswer)}</b></div>` : ''}${imgAppend}</div>
            <div class="score-panel review-score-panel" style="background:${isWrong ? '#fef0f0' : '#f0f9eb'};">
                <label class="score-result-label" style="color:${isWrong ? 'red' : 'green'}">${isWrong ? '扣分项' : '完全正确'}</label>
                <div class="score-result-num">${earnedScore} <span class="text-gray" style="font-size:13px;font-weight:normal;">/ ${mq.score} 分</span></div>
                <input type="text" value="只读锁定" disabled class="score-readonly-input">
            </div>
        </div>`;
        card.innerHTML = h; container.appendChild(card);

        const dot = document.createElement('div');
        dot.className = `q-nav-dot ${isWrong ? 'wrong' : 'correct'}`;
        dot.textContent = index + 1;
        dot.onclick = () => { document.getElementById(`review-item-id-${index}`).scrollIntoView({ behavior: 'smooth', block: 'center' }); };
        dotsGrid.appendChild(dot);
    });
    document.getElementById('review-workspace').style.display = 'flex';
    if (window.MathJax) window.MathJax.typesetPromise([container]).catch(() => {});
}

// ================= 初始化 =================
// 不再自动创建空试题，教师点击「新增试题」手动添加
