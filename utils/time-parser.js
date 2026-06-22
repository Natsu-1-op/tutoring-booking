// utils/time-parser.js
const TimeParser = {
    // 宽口径自适应解析器，兼容带冒号和无冒号输入，统一前导补零
    parseRawText: (rawText, targetYear) => {
        if (!rawText) return null;
        const match = rawText.trim().match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):?(\d{2})-(\d{2}):?(\d{2})/);
        if (!match) return null;
        
        const m = match[1].padStart(2, '0');
        const d = match[2].padStart(2, '0');
        const sh = match[3]; const sm = match[4];
        const eh = match[5]; const em = match[6];
        
        return {
            rawTime: `${parseInt(m, 10)}/${parseInt(d, 10)} ${sh}:${sm}-${eh}:${em}`, 
            date: `${targetYear}-${m}-${d}`,
            startTime: `${sh}:${sm}`,
            endTime: `${eh}:${em}`,
            formattedSlotText: `${parseInt(m, 10)}/${parseInt(d, 10)} ${sh}:${sm}-${eh}:${em}`
        };
    },
    
    isValidCalendarDate: (month, day) => {
        if (month < 1 || month > 12 || day < 1 || day > 31) return false;
        if (month === 2) return day <= 29; 
        if ([4, 6, 9, 11].includes(month)) return day <= 30;
        return true;
    }
};