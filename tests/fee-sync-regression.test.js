const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'money.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .sort((a, b) => b.length - a.length)[0];

function extractFunction(name) {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Function not found: ${name}`);
    if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    const brace = source.indexOf('{', start);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = brace; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unterminated function: ${name}`);
}

function createContext(extra = {}) {
    const context = {
        console,
        Date,
        JSON,
        Math,
        Number,
        Set,
        String,
        activeYear: '2026',
        data: { students: [], records: [], lessonOverrides: {}, dismissedLessons: [] },
        pendingLessons: [],
        isValidLedgerDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
        TimeParser: {
            rangesOverlap(aStart, aEnd, bStart, bEnd) {
                return !!aStart && !!aEnd && !!bStart && !!bEnd && aStart < bEnd && bStart < aEnd;
            }
        },
        ...extra
    };
    vm.createContext(context);
    [
        'cloneForCloud',
        'normalizeClockValue',
        'normalizeReconciliationName',
        'normalizeReconciliationDate',
        'ledgerFingerprint',
        'ledgerSyncMarker',
        'ledgerSliceFingerprint',
        'getYearSlice',
        'getStudentProfile',
        'getReconciliationCandidates',
        'getReconciliationDiffs',
        'matchesStudentEntity',
        'applyStudentProfileToLedgerData',
        'findLessonConflicts'
    ].forEach(name => vm.runInContext(extractFunction(name), context));
    return context;
}

test('student profiles are canonical in active year without bleeding into history', () => {
    const context = createContext();
    context.data = {
        students: [{ name: '小明', rate: 200 }],
        records: [{ studentName: '小华', date: '2025-03-01', hours: 1, rate: 100, total: 100 }],
        lessonOverrides: {},
        dismissedLessons: []
    };
    assert.equal(context.getYearSlice('2026').students.some(student => student.name === '小明'), true);
    assert.equal(context.getYearSlice('2025').students.some(student => student.name === '小明'), false);
});

test('historical-only student profile remains in the active-year slice', () => {
    const context = createContext();
    context.data = {
        students: [{ name: '小明', rate: 200 }],
        records: [{ studentName: '小明', date: '2025-03-01', hours: 1, rate: 150, total: 150 }],
        lessonOverrides: {},
        dismissedLessons: []
    };
    assert.equal(context.getYearSlice('2026').students.some(student => student.name === '小明'), true);
});

test('legacy matching requires exact start and end times', () => {
    const context = createContext();
    context.data = {
        students: [{ name: '小明', rate: 200 }],
        records: [{ id: 'r1', studentName: '小明', date: '2026-02-10', startTime: '09:00', endTime: '10:00', hours: 1, rate: 200, total: 200 }]
    };
    const withoutTimes = context.getReconciliationCandidates({ studentName: '小明', date: '2026-02-10', hours: 1 }, 'imported_x', '');
    assert.equal(withoutTimes.some(candidate => candidate.matchType === 'legacyExact'), false);
    const exact = context.getReconciliationCandidates({ studentName: '小明', date: '2026-02-10', startTime: '09:00', endTime: '10:00', hours: 1 }, 'imported_x', '');
    assert.equal(exact.some(candidate => candidate.matchType === 'legacyExact'), true);
});

test('local confirmation timestamps do not change ledger equivalence', () => {
    const context = createContext();
    const base = { students: [], lessonOverrides: {}, dismissedLessons: [] };
    const first = { ...base, records: [{ id: 'r1', amountConfirmedAt: 100 }] };
    const second = { ...base, records: [{ id: 'r1', amountConfirmedAt: 200 }] };
    assert.equal(context.ledgerSliceFingerprint(first), context.ledgerSliceFingerprint(second));
});

test('confirmed and posted records still validate against profile rate', () => {
    const context = createContext();
    context.data = { students: [{ name: '小明', rate: 200 }], records: [] };
    const booking = { studentName: '小明', date: '2026-02-10', hours: 1 };
    const record = { studentName: '小明', date: '2026-02-10', hours: 1, rate: 150, total: 150, amountConfirmedAt: 100 };
    assert.equal(context.getReconciliationDiffs(booking, record).some(diff => diff.includes('单价')), true);
    assert.equal(context.getReconciliationDiffs(booking, record, { amountMode: 'integrity' }).some(diff => diff.includes('单价')), true);
});

test('profile rate propagation updates record totals and removes local timestamps', () => {
    const context = createContext();
    const result = context.applyStudentProfileToLedgerData({
        students: [{ id: 's1', name: '小明', rate: 150 }],
        records: [{ id: 'r1', studentId: 's1', studentName: '小明', date: '2025-01-01', hours: 2, rate: 150, total: 300, amountConfirmedAt: 100 }]
    }, { id: 's1', name: '小明', rate: 150 }, { id: 's1', name: '小明', rate: 200 });
    assert.equal(result.data.records[0].rate, 200);
    assert.equal(result.data.records[0].total, 400);
    assert.equal(Object.hasOwn(result.data.records[0], 'amountConfirmedAt'), false);
});

test('rate changes update every affected encrypted year before local success', async () => {
    const remote = {
        2026: {
            feeVault: {
                revision: 1,
                updatedAt: 10,
                cipher: 'active',
                data: {
                    students: [{ id: 's1', name: '小明', rate: 150 }],
                    records: [{ id: 'r26', studentId: 's1', studentName: '小明', date: '2026-01-01', hours: 1, rate: 150, total: 150 }],
                    lessonOverrides: {},
                    dismissedLessons: []
                }
            }
        },
        2025: {
            feeVault: {
                revision: 3,
                updatedAt: 10,
                cipher: 'history',
                data: {
                    students: [{ id: 's1', name: '小明', rate: 150 }],
                    records: [{ id: 'r25', studentId: 's1', studentName: '小明', date: '2025-01-01', hours: 2, rate: 150, total: 300 }],
                    lessonOverrides: {},
                    dismissedLessons: []
                }
            }
        }
    };
    let written = null;
    const db = {
        ref(pathname) {
            return {
                once: async () => ({
                    val: () => {
                        if (pathname === 'years') return remote;
                        const match = String(pathname || '').match(/^years\/(\d{4})\/feeVault$/);
                        return match ? remote[match[1]].feeVault : null;
                    }
                }),
                update: async updates => { written = updates; }
            };
        }
    };
    const context = createContext({
        db,
        cloudPushChain: Promise.resolve(true),
        cloudVersionsByYear: {},
        cloudDecryptedByYear: {},
        ensureCloudReady: async () => true,
        ensureFeePassphrase: async () => true,
        getYearSyncState: () => ({ dirty: false }),
        hasCloudConflictState: () => false,
        readRemoteLedgerData: async (year, vault) => JSON.parse(JSON.stringify(vault.data)),
        encryptFeeData: async value => ({ cipher: JSON.stringify(value), salt: 'salt', kdfIterations: 250000 }),
        vaultRefFor: year => db.ref(`years/${year}/feeVault`),
        markYearSynced: () => {}
    });
    vm.runInContext(extractFunction('syncStudentRateAcrossYears'), context);
    await context.syncStudentRateAcrossYears(
        { id: 's1', name: '小明', rate: 150 },
        { id: 's1', name: '小明', rate: 200 }
    );
    const year2025 = JSON.parse(written['years/2025/feeVault'].cipher);
    const year2026 = JSON.parse(written['years/2026/feeVault'].cipher);
    assert.equal(year2025.records[0].total, 400);
    assert.equal(year2026.records[0].rate, 200);
    assert.equal(written['years/2025/feeVault'].revision, 4);
});

test('legacy manual records without times block silent duplicate charging', () => {
    const context = createContext();
    context.data = {
        students: [{ name: '小明', rate: 200 }],
        records: [{ studentName: '小明', date: '2026-02-10', hours: 1, rate: 200, total: 200 }]
    };
    const conflicts = context.findLessonConflicts({ studentName: '小明', date: '2026-02-10', startTime: '14:00', endTime: '15:00', hours: 1 }, false);
    assert.equal(conflicts[0].kind, 'exact');
});
