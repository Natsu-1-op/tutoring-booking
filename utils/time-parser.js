// utils/time-parser.js
const TimeParser = {
    // 宽口径自适应解析器，兼容带冒号和无冒号输入，统一前导补零
    // 现在会校验日期合法性（拒绝 2/30、4/31 等无效日期）
    parseRawText: (rawText, targetYear) => {
        if (!rawText) return null;
        const match = rawText.trim().match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):?(\d{2})-(\d{2}):?(\d{2})$/);
        if (!match) return null;

        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        const sh = parseInt(match[3], 10); const sm = parseInt(match[4], 10);
        const eh = parseInt(match[5], 10); const em = parseInt(match[6], 10);

        if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
        if ((eh * 60 + em) <= (sh * 60 + sm)) return null;

        // 校验日期合法性
        if (!TimeParser.isValidCalendarDate(month, day, targetYear)) return null;

        const m = match[1].padStart(2, '0');
        const d = match[2].padStart(2, '0');

        return {
            rawTime: `${month}/${day} ${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}-${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
            date: `${targetYear}-${m}-${d}`,
            startTime: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
            endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
            formattedSlotText: `${month}/${day} ${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}-${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`
        };
    },

    // 校验公历日期是否合法，正确判断闰年
    isValidCalendarDate: (month, day, year) => {
        if (month < 1 || month > 12 || day < 1 || day > 31) return false;
        if (month === 2) {
            if (year) {
                const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
                return day <= (isLeap ? 29 : 28);
            }
            return day <= 29;
        }
        if ([4, 6, 9, 11].includes(month)) return day <= 30;
        return true;
    },

    // 从排班时间字符串计算课时长（小时）
    calcHours: (timeStr) => {
        if (!timeStr) return 0;
        const m = String(timeStr).trim().match(/^(?:\d{1,2}\/\d{1,2}\s+)?(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})$/);
        if (!m) return 0;
        const startHour = parseInt(m[1], 10); const startMinute = parseInt(m[2], 10);
        const endHour = parseInt(m[3], 10); const endMinute = parseInt(m[4], 10);
        if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return 0;
        const diff = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
        return diff > 0 ? diff / 60 : 0;
    }
};
