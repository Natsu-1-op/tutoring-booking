const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'money.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .sort((a, b) => b.length - a.length)[0];

const allScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .join('\n');

function extractFunctionFrom(haystack, name) {
    let start = haystack.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Function not found: ${name}`);
    if (haystack.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    // 跳过参数列表（可能有 options = {} 这类默认值），再定位函数体起始大括号
    const paren = haystack.indexOf('(', start);
    let parenDepth = 0;
    let cursor = paren;
    for (; cursor < haystack.length; cursor += 1) {
        if (haystack[cursor] === '(') parenDepth += 1;
        else if (haystack[cursor] === ')' && --parenDepth === 0) break;
    }
    const brace = haystack.indexOf('{', cursor);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = brace; index < haystack.length; index += 1) {
        const char = haystack[index];
        const next = haystack[index + 1];
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
        else if (char === '}' && --depth === 0) return haystack.slice(start, index + 1);
    }
    throw new Error(`Unterminated function: ${name}`);
}

const extractFunction = name => extractFunctionFrom(source, name);
const extractAnyScript = name => extractFunctionFrom(allScripts, name);

function createContext(extra = {}) {
    const context = {
        runFeeTransaction: (ref, update) => ref.transaction(update),
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
        // 云端同步里 pushCloudNow 依赖的少量状态函数，默认给安全实现，用例可覆盖
        getYearSyncState: () => ({ dirty: false, changeId: 0, baseRevision: null, baseFingerprint: '' }),
        markYearSynced: () => {},
        markYearSyncError: () => {},
        hasLedgerSliceContent: slice => !!(slice && (
            (Array.isArray(slice.records) && slice.records.length)
            || (Array.isArray(slice.students) && slice.students.length))),
        clearCloudConflict: () => {},
        currentFeePassphraseSync: () => '',
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
    // 金额/学年口径函数在第一个 script 块里，统一按全量脚本抽取
    ['toCents', 'fromCents', 'moneySum', 'moneyText', 'roundHours', 'computeTotal', 'ledgerYearOf', 'recordBelongsToActiveYear']
        .forEach(name => vm.runInContext(extractAnyScript(name), context));
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
                transaction: async updater => {
                    const match = String(pathname || '').match(/^years\/(\d{4})\/feeVault$/);
                    const next = updater(match ? remote[match[1]].feeVault : null);
                    if (next === undefined) return { committed: false };
                    written = written || {};
                    written[pathname] = next;
                    remote[match[1]].feeVault = next;
                    return { committed: true };
                }
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
        getCloudConflict: () => null,
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

test('a concurrent ledger update is not overwritten by a rate change', async () => {
    const vault = { revision: 1, cipher: 'original' };
    let wrote = false;
    const context = createContext({
        db: { ref: () => ({ once: async () => ({ val: () => ({ 2026: { feeVault: vault } }) }) }) },
        cloudPushChain: Promise.resolve(true), cloudVersionsByYear: {}, cloudDecryptedByYear: {},
        ensureCloudReady: async () => true, ensureFeePassphrase: async () => true,
        getYearSyncState: () => ({ dirty: false, changeId: 1 }),
        hasCloudConflictState: () => false, getCloudConflict: () => null,
        readRemoteLedgerData: async () => ({ students: [{ id: 's1', name: '小明', rate: 150 }], records: [] }),
        encryptFeeData: async () => ({ cipher: 'new', salt: 'salt', kdfIterations: 250000 }),
        vaultRefFor: () => ({
            once: async () => ({ val: () => vault }),
            transaction: async updater => {
                const next = updater({ revision: 2, cipher: 'other-device' });
                wrote = next !== undefined;
                return { committed: wrote };
            }
        }),
        markYearSynced: () => {}
    });
    vm.runInContext(extractFunction('syncStudentRateAcrossYears'), context);
    await assert.rejects(context.syncStudentRateAcrossYears(
        { id: 's1', name: '小明', rate: 150 }, { id: 's1', name: '小明', rate: 200 }
    ), /账本已变化/);
    assert.equal(wrote, false);
});

test('a cross-year conflict reports which earlier year already changed', async () => {
    const vault2025 = { revision: 1, cipher: 'old-2025' };
    const vault2026 = { revision: 1, cipher: 'old-2026' };
    const writtenYears = [];
    const context = createContext({
        db: { ref: () => ({ once: async () => ({ val: () => ({ 2025: { feeVault: vault2025 }, 2026: { feeVault: vault2026 } }) }) }) },
        cloudPushChain: Promise.resolve(true), cloudVersionsByYear: {}, cloudDecryptedByYear: {},
        ensureCloudReady: async () => true, ensureFeePassphrase: async () => true,
        getYearSyncState: () => ({ dirty: false, changeId: 1 }),
        hasCloudConflictState: () => false, getCloudConflict: () => null,
        readRemoteLedgerData: async () => ({ students: [{ id: 's1', name: '小明', rate: 150 }], records: [] }),
        encryptFeeData: async () => ({ cipher: 'new', salt: 'salt', kdfIterations: 250000 }),
        vaultRefFor: year => ({
            once: async () => ({ val: () => year === '2025' ? vault2025 : vault2026 }),
            transaction: async updater => {
                const value = year === '2025' ? vault2025 : { revision: 2, cipher: 'other-device' };
                const next = updater(value);
                if (next === undefined) return { committed: false };
                writtenYears.push(year);
                return { committed: true };
            }
        }),
        markYearSynced: () => {}
    });
    vm.runInContext(extractFunction('syncStudentRateAcrossYears'), context);
    await assert.rejects(context.syncStudentRateAcrossYears(
        { id: 's1', name: '小明', rate: 150 }, { id: 's1', name: '小明', rate: 200 }
    ), /已更新 2025 年/);
    assert.deepEqual(writtenYears, ['2025']);
});

test('posting an import refuses a changed booking or a different ledger link', () => {
    const context = createContext();
    vm.runInContext(extractFunction('canPostImportedReservation'), context);
    const original = { status: 'completed', nickname: '小明', time: '6/19 09:00-10:00', slotId: 's1', feeStatus: 'pending' };
    assert.equal(context.canPostImportedReservation({ ...original }, original, 'r1'), true);
    assert.equal(context.canPostImportedReservation({ ...original, feeStatus: 'posted', feeRecordId: 'r2' }, original, 'r1'), false);
    assert.equal(context.canPostImportedReservation({ ...original, feeStatus: 'dismissed' }, original, 'r1'), false);
    assert.equal(context.canPostImportedReservation({ ...original, time: '6/19 10:00-11:00' }, original, 'r1'), false);
});

test('the import snapshot changes when the reservation is modified', () => {
    const context = createContext();
    vm.runInContext(extractFunction('reservationImportFingerprint'), context);
    const original = { status: 'completed', nickname: '小明', time: '6/19 09:00-10:00', slotId: 's1' };
    assert.equal(context.reservationImportFingerprint(original), context.reservationImportFingerprint({ ...original }));
    assert.notEqual(context.reservationImportFingerprint(original), context.reservationImportFingerprint({ ...original, time: '6/19 10:00-11:00' }));
    assert.notEqual(context.reservationImportFingerprint(original), context.reservationImportFingerprint({ ...original, feeStatus: 'posted', feeRecordId: 'other' }));
});

test('interrupted password rotation resumes without replacing newer vaults', async () => {
    const vaults = {
        2025: { revision: 1, cipher: 'old:2025', salt: 's', kdfIterations: 250000 },
        2026: { revision: 1, cipher: 'old:2026', salt: 's', kdfIterations: 250000 }
    };
    let journal = JSON.stringify({ oldPass: 'old', newPass: 'new' });
    let block2026 = true;
    let remembered = '';
    const context = createContext({
        FEE_ROTATION_JOURNAL_KEY: 'rotation', FEE_PASSPHRASE_KEY: 'pass',
        feePassphraseChanging: false, feeRotationInProgress: false, cloudPushChain: Promise.resolve(true),
        cloudVersionsByYear: {}, cloudDecryptedByYear: {},
        localStorage: { getItem: () => journal, removeItem: () => { journal = null; } },
        sessionStorage: { setItem: () => {} },
        unwrapRememberedFeePassphrase: async x => x,
        showFeeLedgerPending: () => {}, showToast: () => {},
        ensureCloudReady: async () => true, getYearSyncState: () => ({ dirty: false }), getCloudConflict: () => null,
        db: { ref: () => ({ once: async () => ({ val: () => Object.fromEntries(Object.entries(vaults).map(([year, vault]) => [year, { feeVault: vault }])) }) }) },
        vaultRefFor: year => ({
            once: async () => ({ val: () => vaults[year] }),
            transaction: async update => {
                if (year === '2026' && block2026) return { committed: false };
                const next = update(vaults[year]);
                if (!next) return { committed: false };
                vaults[year] = next;
                return { committed: true };
            }
        }),
        decryptFeeDataWithPass: async (cipher, salt, iterations, pass) => {
            if (!cipher.startsWith(`${pass}:`)) throw new Error('wrong pass');
            return { year: cipher.split(':')[1] };
        },
        encryptFeeDataWithPass: async (value, pass) => ({ cipher: `${pass}:${value.year}`, salt: 's', kdfIterations: 250000 }),
        rememberFeePassphrase: async pass => { remembered = pass; return true; }
    });
    vm.runInContext(extractFunction('resumeFeePassphraseRotation'), context);
    assert.equal(await context.resumeFeePassphraseRotation(), false);
    assert.equal(vaults[2025].cipher, 'new:2025');
    assert.equal(vaults[2026].cipher, 'old:2026');
    assert.ok(journal);
    block2026 = false;
    assert.equal(await context.resumeFeePassphraseRotation(), true);
    assert.equal(vaults[2025].revision, 2);
    assert.equal(vaults[2026].cipher, 'new:2026');
    assert.equal(remembered, 'new');
    assert.equal(journal, null);
});

test('fee vault encryption can be decrypted only with the matching password', async () => {
    const context = createContext({
        crypto: require('node:crypto').webcrypto,
        TextEncoder, TextDecoder, Uint8Array, btoa, atob,
        FEE_KDF_ITERATIONS: 100000, LEGACY_FEE_SALT: 'class-optic-fee-vault-v1'
    });
    ['deriveFeeKey', 'bufToB64', 'encryptFeeDataWithPass', 'decryptFeeDataWithPass']
        .forEach(name => vm.runInContext(extractFunction(name), context));
    const encrypted = await context.encryptFeeDataWithPass({ records: [{ id: 'r1', total: 200 }] }, 'old-pass');
    const decrypted = await context.decryptFeeDataWithPass(encrypted.cipher, encrypted.salt, encrypted.kdfIterations, 'old-pass');
    assert.equal(decrypted.records[0].total, 200);
    await assert.rejects(context.decryptFeeDataWithPass(encrypted.cipher, encrypted.salt, encrypted.kdfIterations, 'wrong-pass'));
});

test('first upload does not overwrite a vault created during the transaction', async () => {
    let overwritten = false;
    let conflict = null;
    const ref = {
        once: async () => ({ val: () => null }),
        transaction: async update => {
            const next = update({ revision: 1, cipher: 'other-device' });
            overwritten = next !== undefined;
            return { committed: overwritten };
        }
    };
    const context = createContext({
        db: { ref: () => ({ once: async () => ({ val: () => null }) }) },
        cloudDeleteInProgress: false, cloudVersionsByYear: {}, cloudDecryptedByYear: {},
        getCloudConflict: () => null, vaultRefFor: () => ref,
        encryptFeeData: async () => ({ cipher: 'mine', salt: 's', kdfIterations: 250000 }),
        setCloudConflict: (year, value) => { conflict = value; },
        markYearSyncError: () => {}, showToast: () => {}, setLedgerSaveStatus: () => {},
        lastCloudPushError: ''
    });
    vm.runInContext(extractFunction('pushCloudNow'), context);
    // 本机有内容才会走写入事务；空账本现在直接跳过，不创建空 vault
    const result = await context.pushCloudNow({ year: '2026', slice: { students: [], records: [{ id: 'r1', date: '2026-03-01', studentName: '小明', hours: 1, rate: 200, total: 200 }] }, changeId: 1 });
    assert.equal(result, false);
    assert.equal(overwritten, false);
    assert.equal(conflict.reason, 'remote-created');
});

test('password rotation retries a concurrent change without losing real encrypted records', async () => {
    let journal = JSON.stringify({ oldPass: 'old-pass', newPass: 'new-pass' });
    let injectConcurrent = true;
    let currentVault;
    const context = createContext({
        crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob,
        FEE_KDF_ITERATIONS: 100000, LEGACY_FEE_SALT: 'class-optic-fee-vault-v1',
        FEE_ROTATION_JOURNAL_KEY: 'rotation', FEE_PASSPHRASE_KEY: 'pass',
        feePassphraseChanging: false, feeRotationInProgress: false, cloudPushChain: Promise.resolve(true),
        cloudVersionsByYear: {}, cloudDecryptedByYear: {},
        localStorage: { getItem: () => journal, removeItem: () => { journal = null; } },
        sessionStorage: { setItem: () => {} }, unwrapRememberedFeePassphrase: async x => x,
        showFeeLedgerPending: () => {}, showToast: () => {}, ensureCloudReady: async () => true,
        getYearSyncState: () => ({ dirty: false }), getCloudConflict: () => null,
        db: { ref: () => ({ once: async () => ({ val: () => ({ 2026: { feeVault: currentVault } }) }) }) },
        vaultRefFor: () => ({
            once: async () => ({ val: () => currentVault }),
            transaction: async update => {
                if (injectConcurrent) {
                    injectConcurrent = false;
                    const encrypted = await context.encryptFeeDataWithPass({ records: [{ id: 'old' }, { id: 'new' }] }, 'old-pass');
                    currentVault = { ...encrypted, revision: 2, updatedAt: 2 };
                }
                const next = update(currentVault);
                if (!next) return { committed: false };
                currentVault = next;
                return { committed: true };
            }
        }),
        rememberFeePassphrase: async () => true
    });
    ['deriveFeeKey', 'bufToB64', 'encryptFeeDataWithPass', 'decryptFeeDataWithPass', 'resumeFeePassphraseRotation']
        .forEach(name => vm.runInContext(extractFunction(name), context));
    const original = await context.encryptFeeDataWithPass({ records: [{ id: 'old' }] }, 'old-pass');
    currentVault = { ...original, revision: 1, updatedAt: 1 };
    assert.equal(await context.resumeFeePassphraseRotation(), true);
    const result = await context.decryptFeeDataWithPass(currentVault.cipher, currentVault.salt, currentVault.kdfIterations, 'new-pass');
    assert.deepEqual(Array.from(result.records, record => record.id), ['old', 'new']);
    assert.equal(currentVault.revision, 3);
    assert.equal(journal, null);
});

test('rotation recovery validates every year before saving a recovery journal', async () => {
    let journal = null;
    let resumed = 0;
    let years = { 2025: { feeVault: { cipher: 'old:2025' } }, 2026: { feeVault: { cipher: 'new:2026' } } };
    const context = createContext({
        feeRotationPreparing: false, feeRotationInProgress: false, feePassphraseChanging: false,
        FEE_ROTATION_JOURNAL_KEY: 'rotation',
        localStorage: { getItem: () => journal, setItem: (_, value) => { journal = value; } },
        prompt: (() => { let i = 0; return () => (++i % 2 ? 'old' : 'new'); })(),
        alert: () => {}, showFeeLedgerPending: () => {}, ensureCloudReady: async () => true,
        db: { ref: () => ({ once: async () => ({ val: () => years }) }) },
        decryptFeeDataWithPass: async (cipher, salt, iterations, pass) => {
            if (!cipher.startsWith(`${pass}:`)) throw new Error('wrong pass');
            return {};
        },
        wrapRememberedFeePassphrase: async value => value,
        resumeFeePassphraseRotation: async () => { resumed++; return true; }, pullCloud: async () => {}
    });
    vm.runInContext(extractFunction('recoverFeePassphraseRotation'), context);
    years[2024] = { feeVault: { cipher: 'unknown:2024' } };
    await context.recoverFeePassphraseRotation();
    assert.equal(journal, null);
    assert.equal(resumed, 0);
    delete years[2024];
    await context.recoverFeePassphraseRotation();
    assert.deepEqual(JSON.parse(journal), { oldPass: 'old', newPass: 'new' });
    assert.equal(resumed, 1);
});

test('金额按分位累加，逐笔 toFixed 的偏差不会累积到汇总', () => {
    const context = createContext();
    // 单价 × 课时的唯一算法
    assert.equal(context.computeTotal(150.5, 1.5), 225.75);
    assert.equal(context.computeTotal(33.33, 0.01), 0.33);
    assert.equal(context.computeTotal(0.1, 3), 0.3);
    // 逐笔四舍五入后再用浮点相加会得到 0.30000000000000004
    const naive = 0.1 + 0.2;
    assert.notEqual(naive, 0.3);
    assert.equal(context.moneySum([0.1, 0.2]), 0.3);
    assert.equal(context.moneySum([0.1, 0.2, 0.3, 0.4]), 1);
    // 一天 9 节课、每节 33.33×0.5 的典型场景
    const day = new Array(9).fill(context.computeTotal(33.33, 0.5));
    assert.equal(context.computeTotal(33.33, 0.5), 16.67);
    assert.equal(context.moneySum(day), 150.03);
    assert.equal(context.moneyText(context.moneySum(day)), '150.03');
});

test('记录归属学年只看 date 的年份', () => {
    const context = createContext();
    assert.equal(context.ledgerYearOf('2026-01-05'), '2026');
    assert.equal(context.ledgerYearOf(''), '');
    assert.equal(context.recordBelongsToActiveYear({ date: '2026-12-31' }), true);
    assert.equal(context.recordBelongsToActiveYear({ date: '2025-12-31' }), false);
});

test('账本没有变化时不再重新加密，也不消耗新 revision', async () => {
    let vault = { revision: 5, updatedAt: 100, cipher: 'c5', salt: 's', kdfIterations: 250000 };
    let encryptCalls = 0;
    let transactions = 0;
    let fingerprint = '';
    const slice = {
        students: [],
        records: [{ id: 'r1', date: '2026-03-01', studentName: '小明', hours: 1, rate: 200, total: 200 }],
        lessonOverrides: {},
        dismissedLessons: []
    };
    const context = createContext({
        db: { ref: () => ({ once: async () => ({ val: () => null }) }) },
        cloudDeleteInProgress: false,
        cloudVersionsByYear: { 2026: { revision: 5, updatedAt: 100 } },
        cloudDecryptedByYear: {},
        getCloudConflict: () => null,
        setCloudConflict: () => {},
        clearCloudConflict: () => {},
        getYearSyncState: () => ({ dirty: true, changeId: 1, baseRevision: 5, baseFingerprint: fingerprint }),
        vaultRefFor: () => ({
            once: async () => ({ val: () => vault }),
            transaction: async update => {
                transactions += 1;
                const next = update(vault);
                if (!next) return { committed: false };
                vault = next;
                return { committed: true, snapshot: { val: () => vault } };
            }
        }),
        encryptFeeData: async () => {
            encryptCalls += 1;
            return { cipher: 'c6', salt: 's2', kdfIterations: 250000 };
        },
        markYearSynced: () => {},
        markYearSyncError: () => {},
        showToast: () => {},
        setLedgerSaveStatus: () => {},
        readRemoteLedgerData: async () => ({ students: [], records: [] }),
        hasLedgerSliceContent: () => true,
        lastCloudPushError: ''
    });
    vm.runInContext(extractFunction('pushCloudNow'), context);
    fingerprint = context.ledgerSliceFingerprint(slice);
    assert.equal(await context.pushCloudNow({ year: '2026', slice, changeId: 1 }), true);
    assert.equal(encryptCalls, 0, '内容与基线一致时不应重新加密');
    assert.equal(transactions, 0, '内容与基线一致时不应发起写入');
    assert.equal(vault.revision, 5, 'revision 不应变化');

    // 内容真的变了才写入，并且只涨一个版本
    fingerprint = '';
    assert.equal(await context.pushCloudNow({ year: '2026', slice, changeId: 2 }), true);
    assert.equal(encryptCalls, 1);
    assert.equal(transactions, 1);
    assert.equal(vault.revision, 6);
});

test('解密缓存绑定当前口令，换口令后不会命中旧明文', async () => {
    let pass = 'old-pass';
    let decryptCalls = 0;
    let fail = false;
    const context = createContext({
        cloudDecryptedByYear: {},
        activeYear: '2026',
        currentFeePassphraseSync: () => pass,
        decryptFeeData: async () => {
            decryptCalls += 1;
            if (fail) throw new Error('bad key');
            return { records: [{ id: 'r1' }] };
        }
    });
    vm.runInContext(extractFunction('readRemoteLedgerData'), context);
    const remote = { revision: 3, updatedAt: 30, cipher: 'c', salt: 's', kdfIterations: 250000 };
    await context.readRemoteLedgerData('2026', remote);
    await context.readRemoteLedgerData('2026', remote);
    assert.equal(decryptCalls, 1, '同一口令应命中缓存');

    pass = 'new-pass';
    await context.readRemoteLedgerData('2026', remote);
    assert.equal(decryptCalls, 2, '换口令后必须重新解密，不能被旧明文掩盖');

    pass = 'third-pass';
    fail = true;
    await assert.rejects(context.readRemoteLedgerData('2026', remote), error => error.code === 'fee-passphrase-mismatch');
    assert.equal(context.cloudDecryptedByYear['2026'], undefined, '解密失败要丢掉旧缓存');
});

test('预约导入：预约状态写不成功时撤回该条账本记录，不留半成功状态', async () => {
    const reservations = {
        r1: {
            nickname: '小明', slotId: 's1', status: 'completed', feeStatus: 'pending',
            time: '3/1 18:00-19:00',
            slotSnapshot: { date: '2026-03-01', startTime: '18:00', endTime: '19:00' }
        }
    };
    const alerts = [];
    let pushes = 0;
    const context = createContext({
        activeYear: '2026',
        data: { students: [{ id: 's1', name: '小明', rate: 200 }], records: [], lessonOverrides: {}, dismissedLessons: [] },
        db: {
            ref: path => ({
                once: async () => ({ val: () => (String(path).endsWith('/reservations') ? reservations : null) }),
                transaction: async () => { throw new Error('network down'); }
            })
        },
        cloudPushChain: Promise.resolve(true),
        saveData: () => {},
        showToast: () => {},
        alert: message => alerts.push(message),
        confirm: () => true,
        refreshPendingList: async () => true,
        importPendingBusy: false
    });
    context.cloudPushChain = { then: () => ({ catch: async () => { pushes += 1; return true; } }), catch: async () => { pushes += 1; return true; } };
    [
        'reservationImportFingerprint', 'canPostImportedReservation', 'isRecordExisting',
        'importPendingLessons', 'importPendingLessonsImpl'
    ].forEach(name => vm.runInContext(extractFunction(name), context));

    const reservation = reservations.r1;
    const lesson = {
        resKey: 'r1', sourceId: 'imported_r1', studentName: '小明', date: '2026-03-01',
        hours: 1, startTime: '18:00', endTime: '19:00', hasProfile: true, conflicts: [],
        reservationFingerprint: context.reservationImportFingerprint(reservation)
    };
    const ok = await context.importPendingLessons([lesson], {});
    assert.equal(ok, false);
    assert.equal(context.data.records.length, 0, '预约状态没写成，账本记录必须撤回');
    assert.match(alerts.join('\n'), /撤回/);
});

test('预约导入：不属于当前学年的预约不会写进账本', async () => {
    const reservations = {
        r1: {
            nickname: '小明', slotId: 's1', status: 'completed', feeStatus: 'pending',
            time: '12/31 18:00-19:00',
            slotSnapshot: { date: '2025-12-31', startTime: '18:00', endTime: '19:00' }
        }
    };
    const alerts = [];
    const context = createContext({
        activeYear: '2026',
        data: { students: [{ id: 's1', name: '小明', rate: 200 }], records: [], lessonOverrides: {}, dismissedLessons: [] },
        db: { ref: () => ({ once: async () => ({ val: () => reservations }) }) },
        cloudPushChain: Promise.resolve(true),
        saveData: () => {},
        showToast: () => {},
        alert: message => alerts.push(message),
        confirm: () => true,
        refreshPendingList: async () => true,
        importPendingBusy: false
    });
    [
        'reservationImportFingerprint', 'canPostImportedReservation', 'isRecordExisting',
        'importPendingLessons', 'importPendingLessonsImpl'
    ].forEach(name => vm.runInContext(extractFunction(name), context));
    const lesson = {
        resKey: 'r1', sourceId: 'imported_r1', studentName: '小明', date: '2025-12-31',
        hours: 1, hasProfile: true, conflicts: [],
        reservationFingerprint: context.reservationImportFingerprint(reservations.r1)
    };
    assert.equal(await context.importPendingLessons([lesson], {}), false);
    assert.equal(context.data.records.length, 0);
    assert.match(alerts.join('\n'), /不属于 2026 学年/);
});

test('a deleted booking stays queued through a failed sync and never clears a newer link', async () => {
    let fail = true;
    let reservation = { status: 'completed', feeStatus: 'posted', feeRecordId: 'fee1' };
    const ref = {
        once: async () => ({ exists: () => true }),
        transaction: async update => {
            if (fail) throw new Error('offline');
            reservation = update(reservation) ?? reservation;
        }
    };
    const ledger = { pendingFeeUnlinksByYear: {}, dismissedLessons: [] };
    const context = createContext({
        activeYear: '2026', data: ledger, console: { error() {} },
        db: { ref: () => ({ child: key => { assert.equal(key, 'lesson1'); return ref; } }) },
        roundHours: Number, persistLocalLedgerSnapshot() {}
    });
    for (const name of ['clearBookingFeeLink', 'queuePendingFeeUnlink', 'flushPendingFeeUnlinks']) {
        vm.runInContext(extractAnyScript(name), context);
    }
    const record = { id: 'fee1', reservationId: 'lesson1', date: '2026-11-23', studentName: '小明', hours: 1 };
    context.queuePendingFeeUnlink(record);
    assert.equal(ledger.dismissedLessons[0].resKey, 'lesson1');
    assert.equal(await context.flushPendingFeeUnlinks(), false);
    assert.equal(ledger.pendingFeeUnlinksByYear[2026].length, 1);
    fail = false;
    assert.equal(await context.flushPendingFeeUnlinks(), true);
    assert.equal(reservation.feeStatus, 'dismissed');
    assert.equal(reservation.feeRecordId, null);

    reservation = { status: 'completed', feeStatus: 'posted', feeRecordId: 'replacement' };
    context.queuePendingFeeUnlink(record);
    assert.equal(await context.flushPendingFeeUnlinks(), true);
    assert.equal(reservation.feeRecordId, 'replacement');
});
