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
                <button class="danger" onclick="deleteSlot('${slotId}')">删除</button>
            `;
            container.appendChild(div);
        });
    }
});

function addSlot() {
    const timeInput = document.getElementById('new-slot-time');
    const time = timeInput.value.trim();
    if (!time) return alert('请输入时间格式！');

    db.ref('slots').push({ time: time, reserved: false });
    timeInput.value = '';
}

function deleteSlot(slotId) {
    if (confirm('确定要删除这个时间段吗？')) {
        db.ref('slots/' + slotId).remove();
    }
}

db.ref('settings/deadline').on('value', (snapshot) => {
    if (snapshot.val()) {
        document.getElementById('deadline-input').value = snapshot.val();
    }
});

function setDeadline() {
    const deadline = document.getElementById('deadline-input').value;
    if (!deadline) return alert('请选择时间！');
    db.ref('settings/deadline').set(deadline);
    alert('截止时间已保存！');
}

let reservationsData = [];
db.ref('reservations').on('value', (snapshot) => {
    const res = snapshot.val();
    const tbody = document.getElementById('reservations-body');
    tbody.innerHTML = '';
    reservationsData = [];

    if (res) {
        Object.values(res).forEach(r => {
            reservationsData.push(r);
            const tr = document.createElement('tr');
            const date = new Date(r.timestamp).toLocaleString();
            tr.innerHTML = `<td>${r.time}</td><td>${r.nickname}</td><td>${date}</td>`;
            tbody.appendChild(tr);
        });
    }
});

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
    if (confirm('⚠️ 警告：确定要清空所有排班和预约记录吗？这通常在开启新一轮辅导时使用。')) {
        db.ref('slots').remove();
        db.ref('reservations').remove();
        alert('数据已清空！你可以开始添加新的时间段了。');
    }
}
// 👉 新增：监听和设置口令
db.ref('settings/accessCode').on('value', (snapshot) => {
    if (snapshot.val()) {
        document.getElementById('code-input').value = snapshot.val();
    }
});

function setCode() {
    const newCode = document.getElementById('code-input').value.trim();
    if (!newCode) return alert('口令不能为空！');
    db.ref('settings/accessCode').set(newCode);
    alert('预约口令已更新！');
}