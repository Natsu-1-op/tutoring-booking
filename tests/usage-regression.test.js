const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('question bank remembers account notes separately and syncs cleared notes', async () => {
    const store = new Map([['hust839-bank-memory', '{"q1":{"note":"old shared note","updatedAt":1}}']]);
    const cloud = new Map();
    const auth = { currentUser: { uid: 'alice' } };
    const database = { ref: key => ({
        once: async () => ({ val: () => Object.fromEntries([...cloud]
            .filter(([path]) => path.startsWith(key + '/'))
            .map(([path, value]) => [path.split('/').at(-1), value])) }),
        transaction: async update => {
            const value = update(cloud.get(key));
            if (value !== undefined) cloud.set(key, value);
            return { committed: value !== undefined, snapshot: { val: () => cloud.get(key) } };
        }
    }) };
    const context = vm.createContext({
        window: { firebase: { auth: () => auth, database: () => database, apps: [{}] } },
        localStorage: {
            getItem: key => store.get(key), setItem: (key, value) => store.set(key, value),
            removeItem: key => store.delete(key)
        },
        document: { querySelectorAll: () => [] }, setTimeout() {}, clearTimeout() {}
    });
    vm.runInContext(source('question-bank/study.js').replace('entry };', 'entry, write, push };'), context);
    const study = context.window.qbankStudy;
    assert.equal(study.entry('q1').note, '');
    study.write('q1', { note: 'Alice private note' });
    await study.push();
    auth.currentUser = { uid: 'bob' };
    await study.pull();
    assert.equal(study.entry('q1').note, '');
    assert.equal([...cloud.keys()].some(key => key.includes('/bob/')), false);
    auth.currentUser = { uid: 'alice' };
    assert.equal(study.entry('q1').note, 'Alice private note');
    study.write('q1', { note: '' });
    await study.push();
    assert.equal(cloud.get('users/alice/bankMemory/q1').note, '');
    await study.pull();
    assert.equal(study.entry('q1').note, '');
});

test('manual and automatic exam submissions cannot overlap', async () => {
    const script = source('exam_student.js');
    let release;
    let calls = 0;
    const context = vm.createContext({
        submitExamOnce: () => { calls++; return new Promise(resolve => { release = resolve; }); }
    });
    vm.runInContext(script.slice(script.indexOf('let examSubmissionInProgress'), script.indexOf('async function submitExamOnce')), context);
    const manual = context.triggerManualSubmit();
    await context.triggerManualSubmit(true);
    assert.equal(calls, 1);
    release();
    await manual;
    const retry = context.triggerManualSubmit();
    assert.equal(calls, 2);
    release();
    await retry;
});
