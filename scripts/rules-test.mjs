// Firestore rules check: honest money moves pass, cheating is refused.
// Run with `npm run test:rules` (starts the auth + firestore emulators around this script).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import {
  Timestamp, collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, increment, query, runTransaction,
  serverTimestamp, setDoc, setLogLevel, terminate, updateDoc, where, writeBatch,
} from 'firebase/firestore';

setLogLevel('silent'); // refused writes are the point of most tests; don't log them

const projectId = 'board-banker-26';
const apps = [];

async function user(name) {
  const app = initializeApp({ apiKey: 'fake', projectId }, name);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const { user: u } = await signInAnonymously(auth);
  return { uid: u.uid, db };
}

const denied = p => assert.rejects(p, e => e.code === 'permission-denied');
const code = 'TESTGM';
const g = (db, ...path) => doc(db, 'games', code, ...path);
const balance = async (db, uid) => (await getDoc(g(db, 'players', uid))).data().balance;
const KEEP = Timestamp.fromMillis(Date.now() + 7 * 86_400_000); // the game's TTL date, copied onto every record
const txn = (db, data) => [doc(db, 'games', code, 'txns', crypto.randomUUID()), { ...data, at: serverTimestamp(), expireAt: KEEP }];

/** The same shape of write the app makes for a player-to-player payment. */
function pay(u, to, amount) {
  return runTransaction(u.db, async tx => {
    const a = (await tx.get(g(u.db, 'players', u.uid))).data();
    const b = (await tx.get(g(u.db, 'players', to))).data();
    tx.update(g(u.db, 'players', u.uid), { balance: a.balance - amount });
    tx.update(g(u.db, 'players', to), { balance: b.balance + amount });
    tx.set(...txn(u.db, { kind: 'pay', from: u.uid, to, amount, by: u.uid }));
  });
}

let banker, alice, bob, mallory;

before(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  [banker, alice, bob, mallory] = await Promise.all(['banker', 'alice', 'bob', 'mallory'].map(user));
});

after(async () => {
  for (const app of apps) {
    await terminate(getFirestore(app));
    await deleteApp(app);
  }
});

const player = name => ({ name, color: 0, balance: 0, bankrupt: false, joinedAt: serverTimestamp(), expireAt: KEEP });

test('banker creates a game and players join the lobby', async () => {
  const b = writeBatch(banker.db);
  b.set(g(banker.db), {
    code, bankerUid: banker.uid, bankerName: 'Banker', bankerPlays: false, status: 'lobby',
    currency: 'RM', startingCash: 15000, salary: 2000, debtLimit: 0, createdAt: serverTimestamp(), expireAt: KEEP,
  });
  await b.commit();
  await setDoc(g(alice.db, 'players', alice.uid), player('Alice'));
  await setDoc(g(bob.db, 'players', bob.uid), player('Bob'));
});

test('nobody can hijack the game or join with free money', async () => {
  await denied(setDoc(g(mallory.db), { code, bankerUid: mallory.uid }));
  await denied(updateDoc(g(alice.db), { status: 'active' }));
  await denied(updateDoc(g(alice.db), { salary: 99999 }));
  await denied(updateDoc(g(banker.db), { currency: 'BTC' }));
  await denied(updateDoc(g(banker.db), { debtLimit: -5 }));
  await updateDoc(g(banker.db), { currency: '$', startingCash: 1500, salary: 200, debtLimit: 500 });
  await denied(setDoc(g(mallory.db, 'players', mallory.uid), { ...player('M'), balance: 5000 }));
  await denied(setDoc(g(mallory.db, 'players', alice.uid), player('Fake Alice')));
});

test('only the banker starts the game', async () => {
  const b = writeBatch(banker.db);
  b.update(g(banker.db), { status: 'active', startedAt: serverTimestamp() });
  for (const p of [alice, bob]) b.update(g(banker.db, 'players', p.uid), { balance: 1500 });
  b.set(...txn(banker.db, { kind: 'start', from: null, to: null, amount: 1500, by: banker.uid }));
  await b.commit();
  await denied(setDoc(g(mallory.db, 'players', mallory.uid), player('Late')));
});

test('players pay each other', async () => {
  await pay(alice, bob.uid, 100);
  assert.equal(await balance(alice.db, alice.uid), 1400);
  assert.equal(await balance(alice.db, bob.uid), 1600);
});

test('games can’t be browsed; only expired ones can be listed and swept', async () => {
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const seed = (path, fields) => fetch(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  });
  await seed('games/OLDGM2', { code: { stringValue: 'OLDGM2' }, status: { stringValue: 'ended' }, expireAt: { timestampValue: past } });
  await seed('games/OLDGM2/txns/t1', { kind: { stringValue: 'start' }, expireAt: { timestampValue: past } });

  await denied(getDocs(collection(mallory.db, 'games')));
  const cutoff = Timestamp.fromMillis(Date.now() - 86_400_000);
  const old = await getDocs(query(collection(mallory.db, 'games'), where('expireAt', '<', cutoff)));
  assert.deepEqual(old.docs.map(d => d.id), ['OLDGM2']);

  await deleteDoc(doc(mallory.db, 'games', 'OLDGM2', 'txns', 't1'));
  await deleteDoc(doc(mallory.db, 'games', 'OLDGM2'));
  await denied(deleteDoc(g(mallory.db)));
  await denied(deleteDoc(g(mallory.db, 'players', alice.uid)));
});

test('records can’t dodge the 7-day cleanup', async () => {
  const far = Timestamp.fromMillis(Date.now() + 30 * 86_400_000);
  await denied(setDoc(doc(mallory.db, 'games', 'LONGGM'), {
    code: 'LONGGM', bankerUid: mallory.uid, bankerName: 'M', bankerPlays: false, status: 'lobby',
    currency: '$', startingCash: 1500, salary: 200, createdAt: serverTimestamp(), expireAt: far,
  }));
  await denied(setDoc(doc(alice.db, 'games', code, 'txns', 'x1'), { kind: 'pay', from: alice.uid, to: bob.uid, amount: 1, by: alice.uid, at: serverTimestamp(), expireAt: far }));
  await denied(setDoc(doc(alice.db, 'games', code, 'txns', 'x2'), { kind: 'pay', from: alice.uid, to: bob.uid, amount: 1, by: alice.uid, at: serverTimestamp() }));
  await denied(updateDoc(g(alice.db, 'players', alice.uid), { expireAt: far }));
  await denied(updateDoc(g(banker.db), { expireAt: far }));
});

test('GO salary only arrives when the banker approves the request', async () => {
  // players can't pay themselves, not even the salary amount
  await denied(updateDoc(g(alice.db, 'players', alice.uid), { balance: increment(200) }));
  await denied(updateDoc(g(alice.db, 'players', alice.uid), { balance: increment(500) }));

  const go = id => doc(alice.db, 'games', code, 'requests', id);
  await denied(setDoc(go('greedy'), { kind: 'go', to: alice.uid, amount: 500, status: 'open', createdAt: serverTimestamp(), expireAt: KEEP }));
  await setDoc(go('go1'), { kind: 'go', to: alice.uid, amount: 200, status: 'open', createdAt: serverTimestamp(), expireAt: KEEP });

  // another player can't approve it, even by paying it themselves
  await denied(runTransaction(bob.db, async tx => {
    const a = (await tx.get(g(bob.db, 'players', alice.uid))).data();
    const b = (await tx.get(g(bob.db, 'players', bob.uid))).data();
    tx.update(g(bob.db, 'players', bob.uid), { balance: b.balance - 200 });
    tx.update(g(bob.db, 'players', alice.uid), { balance: a.balance + 200 });
    tx.update(doc(bob.db, 'games', code, 'requests', 'go1'), { status: 'paid', paidBy: bob.uid, paidAt: serverTimestamp() });
  }));
  await denied(updateDoc(doc(bob.db, 'games', code, 'requests', 'go1'), { status: 'declined' }));

  // the banker approves: salary from the bank, request settled in the same write
  await runTransaction(banker.db, async tx => {
    const a = (await tx.get(g(banker.db, 'players', alice.uid))).data();
    tx.update(g(banker.db, 'players', alice.uid), { balance: a.balance + 200 });
    tx.update(doc(banker.db, 'games', code, 'requests', 'go1'), { status: 'paid', paidBy: banker.uid, paidAt: serverTimestamp() });
    tx.set(...txn(banker.db, { kind: 'salary', from: null, to: alice.uid, amount: 200, by: banker.uid }));
  });
  assert.equal(await balance(alice.db, alice.uid), 1600);

  // or declines one
  await setDoc(go('go2'), { kind: 'go', to: alice.uid, amount: 200, status: 'open', createdAt: serverTimestamp(), expireAt: KEEP });
  await updateDoc(doc(banker.db, 'games', code, 'requests', 'go2'), { status: 'declined' });
});

test('players cannot print money for someone else or overdraw', async () => {
  await denied(updateDoc(g(alice.db, 'players', bob.uid), { balance: increment(300) }));
  await denied(updateDoc(g(alice.db, 'players', alice.uid), { balance: -501 })); // past the $500 debt limit without going bankrupt
  // Pays 10 but credits 300.
  await denied(runTransaction(alice.db, async tx => {
    tx.update(g(alice.db, 'players', alice.uid), { balance: 1590 });
    tx.update(g(alice.db, 'players', bob.uid), { balance: 1900 });
  }));
  await denied(updateDoc(g(mallory.db, 'players', alice.uid), { balance: 0 }));
});

test('only the banker pays out of the bank', async () => {
  await denied(updateDoc(g(bob.db, 'players', bob.uid), { balance: increment(50) }));
  await updateDoc(g(banker.db, 'players', bob.uid), { balance: increment(50) });
  assert.equal(await balance(bob.db, bob.uid), 1650);
});

test('a payment request is only marked paid when the money lands', async () => {
  const req = doc(bob.db, 'games', code, 'requests', 'r1');
  await setDoc(req, { to: bob.uid, amount: 75, status: 'open', createdAt: serverTimestamp(), expireAt: KEEP });
  await denied(updateDoc(doc(alice.db, 'games', code, 'requests', 'r1'), { status: 'paid', paidBy: alice.uid, paidAt: serverTimestamp() }));
  await runTransaction(alice.db, async tx => {
    const a = (await tx.get(g(alice.db, 'players', alice.uid))).data();
    const b = (await tx.get(g(alice.db, 'players', bob.uid))).data();
    tx.update(g(alice.db, 'players', alice.uid), { balance: a.balance - 75 });
    tx.update(g(alice.db, 'players', bob.uid), { balance: b.balance + 75 });
    tx.update(doc(alice.db, 'games', code, 'requests', 'r1'), { status: 'paid', paidBy: alice.uid, paidAt: serverTimestamp() });
  });
  await denied(updateDoc(doc(bob.db, 'games', code, 'requests', 'r1'), { status: 'cancelled' }));
});

test('outsiders cannot write to the log, players cannot undo', async () => {
  await denied(setDoc(...txn(mallory.db, { kind: 'pay', from: null, to: mallory.uid, amount: 1, by: mallory.uid })));
  const [ref, data] = txn(alice.db, { kind: 'pay', from: alice.uid, to: bob.uid, amount: 1, by: alice.uid });
  await setDoc(ref, data);
  await denied(updateDoc(doc(bob.db, ref.path), { undone: true }));
  await updateDoc(doc(banker.db, ref.path), { undone: true });
});

test('going bankrupt hands all cash to the creditor, then you are out', async () => {
  const before = await balance(alice.db, alice.uid);
  const bobBefore = await balance(alice.db, bob.uid);
  await runTransaction(alice.db, async tx => {
    tx.update(g(alice.db, 'players', alice.uid), { balance: 0, bankrupt: true, bankruptAt: Date.now() });
    tx.update(g(alice.db, 'players', bob.uid), { balance: bobBefore + before });
  });
  assert.equal(await balance(bob.db, bob.uid), bobBefore + before);
  await denied(updateDoc(g(alice.db, 'players', alice.uid), { balance: increment(200) }));
  await denied(pay(bob, alice.uid, 10));
});

test('players can go into debt down to the limit; past it they go bankrupt', async () => {
  await updateDoc(g(bob.db, 'players', bob.uid), { balance: -500 });                       // exactly the limit
  await denied(updateDoc(g(bob.db, 'players', bob.uid), { balance: -501 }));               // past it, still playing
  await denied(updateDoc(g(bob.db, 'players', bob.uid), { balance: 0, bankrupt: true }));  // bankruptcy can't erase debt
  await updateDoc(g(bob.db, 'players', bob.uid), { balance: -900, bankrupt: true, bankruptAt: Date.now() }); // paid past it: out
  await denied(updateDoc(g(bob.db, 'players', bob.uid), { balance: -1000 }));              // bankrupt players can't move money
});

test('after the game ends, money is frozen', async () => {
  await updateDoc(g(banker.db), { status: 'ended', endedAt: serverTimestamp() });
  await denied(updateDoc(g(bob.db, 'players', bob.uid), { balance: increment(200) }));
  await denied(updateDoc(g(banker.db, 'players', bob.uid), { balance: 1 }));
  await denied(updateDoc(g(banker.db), { status: 'lobby' }));
});
