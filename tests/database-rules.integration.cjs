// Run only through the Firebase Database Emulator with a demo project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)) throw new Error('A local database emulator is required');
const [host, port] = emulator.split(':');
const oldTime = '11/4 09:00-10:00';
const newTime = '11/4 10:00-11:00';
const slot = { time: oldTime, reserved: true, reservationId: 'r1', status: 'active' };
const reservation = { nickname: '小明', slotId: 's1', reservationId: 'r1', time: oldTime, status: 'booked', cancelCode: 'ABCDE', timestamp: 1, slotSnapshot: { date: '2026-11-04', startTime: '09:00', endTime: '10:00' } };

(async () => {
    const env = await initializeTestEnvironment({ projectId: 'demo-tutoring', database: {
        host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8')
    } });
    const seed = value => env.withSecurityRulesDisabled(ctx => ctx.database().ref('years/2026').set(value));
    const db = env.unauthenticatedContext().database();
    try {
        await seed({ slots: { s1: { ...slot, reserved: false, reservationId: null } } });
        await assertSucceeds(db.ref('years/2026').update({ 'slots/s1/time': newTime }));
        await seed({ slots: { s1: { ...slot, reserved: false, reservationId: null } } });
        await assertSucceeds(db.ref('years/2026/slots/s1').update({ reserved: true, reservationId: 'r1' }));
        await seed({ slots: { s1: slot }, reservations: { r1: reservation } });
        await assertSucceeds(db.ref().update({ 'years/2026/slots/s1/time': newTime, 'years/2026/reservations/r1/time': newTime }));
        await seed({ slots: { s1: { ...slot, reservationId: null } }, reservations: { r1: reservation } });
        await assertFails(db.ref().update({ 'years/2026/slots/s1/time': newTime, 'years/2026/reservations/r1/time': newTime }));
        await assertSucceeds(db.ref('years/2026/slots/s1/reservationId').set('r1'));
        await assertSucceeds(db.ref().update({ 'years/2026/slots/s1/time': newTime, 'years/2026/reservations/r1/time': newTime }));
        await seed({ slots: { s1: slot }, reservations: { r1: reservation } });
        await assertFails(db.ref('years/2026').update({ 'slots/s1/time': newTime }));
        await seed({ slots: { s1: slot } });
        await assertFails(db.ref('years/2026').update({ 'slots/s1/time': newTime }));
        await assertFails(db.ref('years/2026').update({ 'slots/s1/time': '' }));
        await seed({ slots: { s1: slot }, reservations: { r1: { ...reservation, status: 'canceled' } } });
        await assertFails(db.ref('years/2026').update({ 'slots/s1/time': newTime, 'reservations/r1/time': newTime }));
        await seed({ slots: { s1: slot }, reservations: { r1: { ...reservation, status: 'completed', feeStatus: 'posted', feeRecordId: 'fee1' } } });
        await assertFails(db.ref('years/2026').update({ 'slots/s1/time': newTime, 'reservations/r1/time': newTime }));
        await assertSucceeds(db.ref('years/2026').update({ 'slots/s1/time': newTime, 'reservations/r1/time': newTime, 'metadata/feeReconcileToken': 'reconcile-1' }));
        await assertFails(db.ref('years/2026').update({ 'slots/s1/time': oldTime, 'reservations/r1/time': oldTime }));
        await assertSucceeds(db.ref('years/2026').set({ slots: { s1: slot }, reservations: { r1: reservation }, metadata: { restoreToken: 'restore-1' } }));
        await assertSucceeds(db.ref('years/2026/studentWhitelist').set({ student: '小红' }));
        await seed({ slots: { s1: { ...slot, reserved: false, reservationId: null } } });
        await assertSucceeds(db.ref('years/2026/slots/s1/time').set(newTime));
        const result = await db.ref('years/2026/slots/s1').transaction(current => {
            if (!current || current.reserved || current.time !== oldTime) return;
            return { ...current, reserved: true, reservationId: 'r1' };
        });
        assert.equal(result.committed, false);
        console.log('Database rules: all schedule and booking scenarios passed');
    } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
