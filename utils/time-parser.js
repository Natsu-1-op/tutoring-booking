// utils/time-parser.js
const TimeParser = {
    // 宽口径自适应解析器，兼容带冒号和无冒号输入，统一前导补零
    // 现在会校验日期合法性（拒绝 2/30、4/31 等无效日期）
    parseRawText: (rawText, targetYear) => {
        if (!rawText) return null;
        const match = rawText.trim().match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):?(\d{2})-(\d{2}):?(\d{2})/);
        if (!match) return null;

        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        const sh = match[3]; const sm = match[4];
        const eh = match[5]; const em = match[6];

        // 校验日期合法性
        if (!TimeParser.isValidCalendarDate(month, day, targetYear)) return null;

        const m = match[1].padStart(2, '0');
        const d = match[2].padStart(2, '0');

        return {
            rawTime: `${month}/${day} ${sh}:${sm}-${eh}:${em}`,
            date: `${targetYear}-${m}-${d}`,
            startTime: `${sh}:${sm}`,
            endTime: `${eh}:${em}`,
            formattedSlotText: `${month}/${day} ${sh}:${sm}-${eh}:${em}`
        };
    },

    // 校验公历日期是否合法，正确判断闰年
    isValidCalendarDate: (month, day, year) => {
        if (month < 1 || month > 12 || day < 1 || day > 31) return false;
        // 处理 2 月：闰年最多 29 天，平年最多 28 天
        if (month === 2) {
            if (year) {
                const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
                return day <= (isLeap ? 29 : 28);
            }
            return day <= 29; // 无年份时宽松处理
        }
        if ([4, 6, 9, 11].includes(month)) return day <= 30;
        return true;
    }
};