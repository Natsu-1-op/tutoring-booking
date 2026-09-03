const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');

function extractFunction(name) {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Function not found: ${name}`);
    if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    const brace = source.indexOf('{', start);
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = brace; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = '';
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

function createContext() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(extractFunction('normalizeStudentName'), context);
    vm.runInContext(extractFunction('addStudentToWhitelistSnapshot'), context);
    return context;
}

test('adding a student only changes the whitelist snapshot and normalizes whitespace', () => {
    const context = createContext();
    const existing = { existing: '小明' };
    const result = context.addStudentToWhitelistSnapshot(existing, 'new-key', '  小红   同学  ');

    assert.deepEqual(existing, { existing: '小明' });
    assert.equal(result.duplicate, false);
    assert.equal(result.whitelist['new-key'], '小红 同学');
});

test('duplicate students are rejected after whitespace normalization', () => {
    const context = createContext();
    const result = context.addStudentToWhitelistSnapshot({ existing: '小明 同学' }, 'new-key', ' 小明   同学 ');

    assert.equal(result.duplicate, true);
    assert.equal(result.whitelist['new-key'], undefined);
});

test('student creation no longer opens a transaction on the entire academic-year node', () => {
    const addFunction = extractFunction('addNewStudentToWhitelist');

    assert.match(addFunction, /listRef\.transaction\(/);
    assert.doesNotMatch(addFunction, /db\.ref\(`years\/\$\{viewingYear\}`\)\.transaction\(/);
});

test('student creation writes only the whitelist and optional hour limit paths', async () => {
    const elements = {
        'new-student-name': { value: '  小红   同学 ' },
        'new-student-hours': { value: '12' },
        'btn-add-student': { disabled: false, textContent: '添加' }
    };
    const requestedPaths = [];
    const alerts = [];
    let storedWhitelist = { existing: '小明' };
    let savedHours = null;
    const whitelistPath = 'years/2026/studentWhitelist';
    const hoursPath = 'years/2026/studentHours/小红 同学';
    const context = {
        viewingYear: '2026',
        console,
        Object,
        Array,
        Number,
        String,
        Promise,
        INVALID_FIREBASE_KEY_CHARS: /[.#$\/\[\]<>\u0000-\u001F\u007F]/,
        document: { getElementById: id => elements[id] || null },
        alert: message => alerts.push(message),
        firebase: { database: { ServerValue: { TIMESTAMP: 1 } } },
        SystemRouter: { getLogsRef: () => ({ push: () => Promise.resolve() }) },
        db: {
            ref(path) {
                requestedPaths.push(path);
                if (path === whitelistPath) {
                    return {
                        push: () => ({ key: 'new-key' }),
                        transaction: async updater => {
                            const next = updater(storedWhitelist);
                            if (next === undefined) return { committed: false };
                            storedWhitelist = next;
                            return { committed: true };
                        }
                    };
                }
                if (path === hoursPath) return { set: async value => { savedHours = value; } };
                throw new Error(`Unexpected Firebase path: ${path}`);
            }
        }
    };
    vm.createContext(context);
    ['isValidStudentName', 'normalizeStudentName', 'addStudentToWhitelistSnapshot', 'studentWriteErrorMessage', 'addNewStudentToWhitelist']
        .forEach(name => vm.runInContext(extractFunction(name), context));

    await context.addNewStudentToWhitelist();

    assert.deepEqual(requestedPaths, [whitelistPath, hoursPath]);
    assert.equal(storedWhitelist['new-key'], '小红 同学');
    assert.equal(savedHours, 12);
    assert.equal(elements['new-student-name'].value, '');
    assert.equal(elements['new-student-hours'].value, '');
    assert.equal(elements['btn-add-student'].disabled, false);
    assert.deepEqual(alerts, []);
});
