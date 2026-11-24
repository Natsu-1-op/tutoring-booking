// Run against the Realtime Database emulator and an isolated demo project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)) throw new Error('A local database emulator is required');
const [host, port] = emulator.split(':');
const projectId = 'demo-tutoring';
const pass = 'P'.repeat(32);
const passPath = 'bankPersonalPasses/' + pass;
const key = 'K'.repeat(43);
const proof1 = '1'.repeat(48);
const proof2 = '2'.repeat(48);
const session1 = 'a'.repeat(48);
const session2 = 'b'.repeat(48);

async function request(relative, value, session) {
    const url = new URL('http://' + emulator + '/' + relative + '.json');
    url.searchParams.set('ns', projectId);
    if (session) {
        url.searchParams.set('orderBy', JSON.stringify('$key'));
        url.searchParams.set('startAt', JSON.stringify(session));
    }
    return fetch(url, {
        method: value === undefined ? 'GET' : 'PUT',
        headers: value === undefined ? undefined : {'Content-Type': 'application/json'},
        body: value === undefined ? undefined : JSON.stringify(value)
    });
}

const lease = (slot, proof, session, options = {}) => ({
    slot, proof, session, seenAt: {'.sv': 'timestamp'}, released: false, takeover: false, ...options
});

(async () => {
    const env = await initializeTestEnvironment({ projectId, database: {
        host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8')
    } });
    const seed = (relative, value) => env.withSecurityRulesDisabled(ctx => ctx.database().ref(relative).set(value));
    const res = async (suffix, value, session) => request(passPath + '/' + suffix, value, session);
    const denied = response => assert.ok([401, 403].includes(response.status), 'expected denied, got ' + response.status);
    try {
        await seed('questionBankAccess/settings', {release: 'internal-v2', key});
        const record = {
            label: 'demo pass', validUntil: Date.now() + 86400000, revoked: false,
            delivery: {'~': {release:'internal-v2', key}}
        };
        const admin = env.authenticatedContext('demo-admin', {email: '1843499931@qq.com'}).database();
        const other = env.authenticatedContext('demo-user', {email: 'student@example.test'}).database();
        await assertFails(other.ref(passPath).set(record));
        await assertSucceeds(admin.ref(passPath).set(record));
        denied(await request('bankPersonalPasses'));
        denied(await request(passPath));
        denied(await res('delivery'));
        denied(await res('delivery/~'));
        assert.equal((await res('devices/1', {proof:proof1, released:false})).status, 200);
        assert.equal((await res('devices/2', {proof:proof2, released:false})).status, 200);
        assert.equal((await res('devices/1', {proof:proof1, released:false})).status, 200);
        denied(await res('devices/3', {proof:'3'.repeat(48), released:false}));
        denied(await res('devices/2', {proof:proof1, released:false}));
        denied(await res('devices/2', null));
        const concurrent = await Promise.all([
            res('lease', lease('1', proof1, session1)),
            res('lease', lease('2', proof2, session2)),
        ]);
        assert.equal(concurrent.filter(response => response.status === 200).length, 1);
        const [firstSlot, firstProof, firstSession, nextSlot, nextProof, nextSession] = concurrent[0].ok
            ? ['1', proof1, session1, '2', proof2, session2]
            : ['2', proof2, session2, '1', proof1, session1];
        let response = await res('delivery', undefined, firstSession);
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json())['~'].key, key);
        denied(await res('delivery', undefined, nextSession));
        assert.equal((await res('lease', lease(nextSlot, nextProof, nextSession, {takeover: true}))).status, 200);
        denied(await res('delivery', undefined, firstSession));
        denied(await res('lease', lease(firstSlot, firstProof, firstSession, {released:true})));
        assert.equal((await res('delivery', undefined, nextSession)).status, 200);
        await seed(passPath + '/lease', lease(nextSlot, nextProof, nextSession, {seenAt: Date.now() - 91000}));
        denied(await res('delivery', undefined, nextSession));
        assert.equal((await res('lease', lease(firstSlot, firstProof, firstSession))).status, 200);
        assert.equal((await res('devices/' + firstSlot, {proof:firstProof, released:true})).status, 200);
        denied(await res('delivery', undefined, firstSession));
        assert.equal((await res('devices/' + firstSlot, {proof:'3'.repeat(48), released:false})).status, 200);
        await seed(passPath + '/revoked', true);
        denied(await res('lease', lease(nextSlot, nextProof, nextSession)));
        console.log('Personal-pass rules: device limit, online lock, takeover, expiry, removal and revocation passed');
    } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
