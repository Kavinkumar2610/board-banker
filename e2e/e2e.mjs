// End-to-end tests: real phones are simulated as separate Chrome profiles; QR codes are scanned
// through Chrome's fake camera, so the real scanner path runs.
//
//   npm run dev            (terminal 1: emulators + ng serve on :4200)
//   npm run test:e2e       (terminal 2; add scenario names to run a subset: main rm edges pwa)
//
// Screenshots + captions land in e2e/screenshots/ (manifest.json lists them in order).
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'screenshots');
const PROFILES = path.join(ROOT, '.profiles');
const APP = process.env.BASE_URL ?? 'http://localhost:4200';
const FIRESTORE = 'http://localhost:8080/v1/projects/board-banker-26/databases/(default)/documents';
const only = process.argv.slice(2);

const manifest = [];
const errors = [];
const open = new Set();
let scenario = '';
let n = 0;
let failed = 0;

// ---- helpers ------------------------------------------------------------------------------

async function phone(name, { camera, browser, offline } = {}) {
  let ctx;
  const opts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] };
  if (browser) {
    ctx = await browser.newContext(opts);
  } else {
    ctx = await chromium.launchPersistentContext(path.join(PROFILES, scenario, name), {
      ...opts, channel: 'chrome', headless: true,
      args: camera ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`] : [],
    });
  }
  if (offline) await ctx.setOffline(true);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // An iPhone's status bar and home indicator, so screenshots show the real safe areas.
  await (await ctx.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34 } });
  page.on('pageerror', e => errors.push(`[${scenario}/${name}] ${e.message}`));
  page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`[${scenario}/${name}] ${m.text()}`));
  page.setDefaultTimeout(15000);
  const p = { ctx, page, name };
  open.add(p);
  ctx.on('close', () => open.delete(p));
  return p;
}

async function shot(p, name, caption) {
  await p.page.waitForTimeout(450); // let transitions settle
  const file = `${scenario}/${String(++n).padStart(2, '0')}-${name}.png`;
  fs.mkdirSync(path.join(OUT, scenario), { recursive: true });
  await p.page.screenshot({ path: path.join(OUT, file) });
  manifest.push({ scenario, file, caption, phone: p.name });
}

const btn = (p, name) =>
  p.page.getByRole('button', { name, exact: true }).or(p.page.getByRole('link', { name, exact: true })).first();
const sheetBtn = (p, name) => p.page.locator('ion-action-sheet').getByRole('button', { name, exact: true });
const alertBtn = (p, name) => p.page.locator('ion-alert').getByRole('button', { name, exact: true });
const see = (p, text) => p.page.getByText(text, { exact: false }).first().waitFor();
const balanceIs = (p, text) =>
  p.page.waitForFunction(t => document.querySelector('.bc-amount')?.textContent.trim() === t, text);
const toast = async (p, text) => {
  await p.page.locator('ion-toast').filter({ hasText: text }).first().waitFor();
};
async function keypad(p, digits) {
  for (const d of String(digits)) await btn(p, d).click();
}
async function clearPad(p) {
  for (let i = 0; i < 9; i++) await btn(p, 'Delete digit').click();
}

async function step(label, fn) {
  process.stdout.write(`  • ${label} … `);
  try {
    await fn();
    console.log('ok');
  } catch (e) {
    failed++;
    console.log(`FAILED\n      ${String(e.message).split('\n')[0]}`);
    for (const p of open) {
      fs.mkdirSync(path.join(OUT, 'failures'), { recursive: true });
      await p.page.screenshot({ path: path.join(OUT, 'failures', `${scenario}-${p.name}.png`) }).catch(() => {});
    }
    throw e;
  }
}

const settle = (promise, ms = 5000) => Promise.race([promise.catch(() => {}), new Promise(r => setTimeout(r, ms))]);

async function closeAll() {
  await settle(Promise.all([...open].map(p => p.ctx.close())));
  open.clear();
}

/** Screenshot the QR on screen and loop it as a fake camera feed. */
async function qrToCamera(p, name) {
  const jpg = await p.page.locator('.qr-frame').first().screenshot({ type: 'jpeg', quality: 92 });
  const file = path.join(PROFILES, `${name}.mjpeg`);
  fs.mkdirSync(PROFILES, { recursive: true });
  fs.writeFileSync(file, Buffer.concat(Array(60).fill(jpg)));
  return file;
}

async function createGame(p, name, { plays = true } = {}) {
  await p.page.goto(`${APP}/create`);
  await p.page.getByLabel('Your name').fill(name);
  if (!plays) await p.page.locator('ion-toggle').click();
  await btn(p, 'Create game').click();
  await p.page.locator('.qr-frame img').waitFor();
  return (await p.page.locator('.code-big').textContent()).trim();
}

async function joinByLink(p, code, name) {
  await p.page.goto(`${APP}/join/${code}`);
  await see(p, '’s game');
  await p.page.getByLabel('Your name').fill(name);
  await btn(p, 'Join game').click();
  await see(p, `You’re in, ${name}!`);
}

/** Newest open payment request in a game, read straight from the emulator (bypasses rules). */
async function latestRequest(code) {
  const res = await fetch(`${FIRESTORE}/games/${code}/requests`, { headers: { Authorization: 'Bearer owner' } });
  const docs = (await res.json()).documents ?? [];
  const open = docs.filter(d => d.fields.status.stringValue === 'open').sort((a, b) => b.createTime.localeCompare(a.createTime));
  return open[0].name.split('/').pop();
}

async function request(p, amount) {
  await btn(p, 'Get paid Show a QR').click();
  await keypad(p, amount);
  await p.page.getByRole('button', { name: /^Show QR for/ }).click();
  await see(p, 'Waiting for payment');
}

// ---- scenario: main game -----------------------------------------------------------------

async function main() {
  const ben = await phone('ben');
  let code;

  await step('home screen', async () => {
    await ben.page.goto(APP);
    await see(ben, 'Board Banker');
    await shot(ben, 'home', 'Home: scan to join, enter a code, or be the banker');
  });

  await step('banker creates a game (name is required)', async () => {
    await btn(ben, 'Be the banker').click();
    await btn(ben, 'Create game').click();
    await see(ben, 'Enter your name to continue');
    await shot(ben, 'create-validation', 'Create game: name is required');
    await ben.page.getByLabel('Your name').fill('Ben');
    await btn(ben, 'Create game').click();
    await ben.page.locator('.qr-frame img').waitFor();
    code = (await ben.page.locator('.code-big').textContent()).trim();
    await see(ben, 'Waiting for 1 more player to join you'); // the playing banker counts as player one
    await shot(ben, 'lobby-empty', 'Lobby: banker shows the join QR and code');
  });

  const joinCam = await qrToCamera(ben, 'main-join');
  let alice = await phone('alice', { camera: joinCam });

  await step('Alice scans the banker’s QR to join', async () => {
    await alice.page.goto(APP);
    await btn(alice, 'Scan to join a game').click();
    await see(alice, 'Ben’s game');
    await alice.page.getByLabel('Your name').fill('Alice');
    await shot(alice, 'join-found', 'Join: scanned QR finds the game and who is in it');
    await btn(alice, 'Join game').click();
    await see(alice, 'You’re in, Alice!');
    await shot(alice, 'waiting', 'Player lobby: waiting for the banker');
  });
  await alice.ctx.close();

  const bob = await phone('bob');
  await step('Bob types the code; duplicate names are refused', async () => {
    await bob.page.goto(`${APP}/join`);
    await bob.page.getByLabel('Game code').fill(code.toLowerCase());
    await see(bob, 'Ben’s game');
    await bob.page.getByLabel('Your name').fill('alice');
    await btn(bob, 'Join game').click();
    await see(bob, 'Someone in this game already has that name');
    await shot(bob, 'join-duplicate', 'Join: duplicate names are refused');
    await bob.page.getByLabel('Your name').fill('Bob');
    await btn(bob, 'Join game').click();
    await see(bob, 'You’re in, Bob!');
  });

  await step('banker sets $2,000 starting cash and starts', async () => {
    await see(ben, 'Bob');
    // input.native-input: on phones Ionic briefly adds a hidden clone of a focused input (scroll assist).
    const cash = ben.page.locator('ion-input[label="Starting cash for each player"] input.native-input:not(.cloned-input)');
    await cash.fill('');
    await see(ben, 'Starting cash must be from $1');
    await ben.page.locator('ion-footer ion-button.button-disabled').waitFor(); // Start stays disabled
    await cash.fill('2000'); // typed, then Start straight away: the typed amount must win
    await see(ben, 'Start game · $2,000 each');
    await ben.page.locator('ion-segment.currency').scrollIntoViewIfNeeded();
    await shot(ben, 'lobby-money', 'Lobby: banker types starting cash, GO salary and debt limit');
    await btn(ben, 'Start game · $2,000 each').click();
    await balanceIs(ben, '$2,000');
    await shot(ben, 'wallet-banker', 'Banker who plays: wallet tab plus bank tab');
  });

  await step('Bob passes GO; the banker approves in a pop-up (+$200)', async () => {
    await balanceIs(bob, '$2,000');
    await btn(bob, 'Pass GO Collect $200 salary').click();
    await see(bob, 'Passed GO?');
    await shot(bob, 'go-confirm', 'Pass GO: confirm first, so a stray tap does nothing');
    await alertBtn(bob, 'Ask banker').click();
    await see(bob, 'Waiting for the banker');
    await shot(bob, 'go-pending', 'Pass GO: waiting for the banker (tap to cancel)');
    await see(ben, 'Bob passed GO');
    await shot(ben, 'go-popup', 'Banker: pop-up to approve or decline the GO salary');
    await alertBtn(ben, 'Approve').click();
    await balanceIs(bob, '$2,200');
    await toast(bob, 'You passed GO');
    await shot(bob, 'after-go', 'Pass GO approved: salary added');
  });

  let payCam;
  await step('Bob asks for $250 and shows a QR', async () => {
    await btn(bob, 'Get paid Show a QR').click();
    await keypad(bob, 250);
    await shot(bob, 'request-keypad', 'Get paid: big keypad, no phone keyboard');
    await btn(bob, 'Show QR for $250').click();
    await see(bob, 'Waiting for payment');
    await bob.page.locator('.qr-frame img').waitFor();
    await shot(bob, 'request-qr', 'Get paid: single-use payment QR, screen kept awake');
    payCam = await qrToCamera(bob, 'main-pay');
  });

  alice = await phone('alice', { camera: payCam });
  await step('Alice scans Bob’s QR and pays', async () => {
    await alice.page.goto(`${APP}/game/${code}`);
    await balanceIs(alice, '$2,000');
    await shot(alice, 'wallet', 'Player wallet: balance, Pass GO, Get paid, Pay, Pay bank');
    await btn(alice, 'Pay Scan their QR').click();
    await see(alice, 'Confirm payment');
    await shot(alice, 'confirm-pay', 'Pay: scanned QR shows who and how much before paying');
    const t0 = Date.now();
    await btn(alice, 'Pay $250').click();
    await alice.page.getByRole('heading', { name: 'Paid Bob' }).waitFor();
    const payer = Date.now() - t0;
    await bob.page.getByRole('heading', { name: 'Alice paid you' }).waitFor();
    process.stdout.write(`(payer saw “Paid” in ${payer} ms, receiver in ${Date.now() - t0} ms) `);
    await shot(alice, 'paid', 'Pay: success');
    await balanceIs(alice, '$1,750');
  });

  await step('Bob’s QR screen turns into “paid”', async () => {
    await bob.page.getByRole('heading', { name: 'Alice paid you' }).waitFor();
    await shot(bob, 'got-paid', 'Get paid: QR screen confirms the payment by itself');
    await balanceIs(bob, '$2,450');
  });

  await step('banker can decline a GO request; the player is told', async () => {
    await alice.page.waitForTimeout(1200);
    await btn(alice, 'Pass GO Collect $200 salary').click();
    await alertBtn(alice, 'Ask banker').click();
    await see(alice, 'Waiting for the banker');
    await see(ben, 'Alice passed GO');
    await alertBtn(ben, 'Decline').click();
    await toast(alice, 'declined your GO salary');
    await shot(alice, 'go-declined', 'Banker declined: player is told, nothing paid');
    await balanceIs(alice, '$1,750');
  });

  await step('overpaying warns it will bankrupt you; Alice pays $100 instead', async () => {
    await alice.page.waitForTimeout(1500);
    await btn(alice, 'Pay bank Buy, tax, fees').click();
    await keypad(alice, 9999);
    await see(alice, 'More than you have: this makes you bankrupt');
    await btn(alice, 'Pay $9,999 to the bank and go bankrupt').waitFor();
    await shot(alice, 'overdraw', 'Paying more than you have (no debt allowed): clear bankruptcy warning');
    await clearPad(alice);
    await keypad(alice, 100);
    await btn(alice, 'Pay $100 to the bank').click();
    await alice.page.getByRole('heading', { name: 'Paid the bank' }).waitFor();
    await balanceIs(alice, '$1,650');
  });

  await step('Alice pays Ben by tapping his name (no QR)', async () => {
    await alice.page.waitForTimeout(1500);
    await alice.page.getByRole('button', { name: /^Pay Ben\./ }).click();
    await keypad(alice, 50);
    await shot(alice, 'pay-player', 'Send without QR: tap a player, enter the amount');
    await btn(alice, 'Pay $50 to Ben').click();
    await alice.page.getByRole('heading', { name: 'Paid Ben' }).waitFor();
    await balanceIs(ben, '$2,050');
  });

  await step('banker pays Alice $500 from the bank', async () => {
    await ben.page.locator('ion-segment-button', { hasText: 'Bank' }).click();
    await see(ben, 'Cash in play');
    await ben.page.getByRole('button', { name: /^Manage Alice/ }).click();
    await shot(ben, 'manage-sheet', 'Banker: per-player actions');
    await sheetBtn(ben, 'Pay from the bank').click();
    await keypad(ben, 500);
    await btn(ben, 'Pay $500 to Alice').click();
    await ben.page.getByRole('heading', { name: 'Paid Alice' }).waitFor();
    await balanceIs(alice, '$2,100');
    await toast(alice, 'Bank paid you');
    await shot(alice, 'incoming-toast', 'Incoming money: toast + vibration on the receiver’s phone');
    await ben.page.waitForTimeout(1200);
    await ben.page.locator('ion-content').evaluate(el => el.scrollToTop());
    await shot(ben, 'bank-tab', 'Bank tab: cash in play, players, full activity log');
  });

  await step('banker reverses Bob’s GO salary', async () => {
    await ben.page.getByRole('button', { name: /^Bob passed GO.*Tap to reverse/ }).click();
    await shot(ben, 'undo-confirm', 'Undo: banker confirms before reversing');
    await alertBtn(ben, 'Reverse').click();
    await balanceIs(bob, '$2,250');
  });

  await step('Bob goes bankrupt to Alice', async () => {
    await bob.page.waitForTimeout(1200);
    await btn(bob, 'Game menu').click();
    await sheetBtn(bob, 'Declare bankruptcy').click();
    await shot(bob, 'bankrupt-creditor', 'Bankruptcy: choose who you owe');
    await sheetBtn(bob, 'Alice').click();
    await alertBtn(bob, 'Declare bankrupt').click();
    await see(bob, 'You’re out of the game');
    await balanceIs(alice, '$4,350');
    await shot(bob, 'bankrupt', 'Bankrupt: cash handed over, player is out');
  });

  await step('banker ends the game; everyone sees standings', async () => {
    await btn(ben, 'Game menu').click();
    await sheetBtn(ben, 'End game').click();
    await alertBtn(ben, 'End game').click();
    await see(alice, 'Alice wins!');
    await see(bob, 'Alice wins!');
    await shot(alice, 'results', 'Game over: final standings');
  });

  await step('home stops offering an ended game', async () => {
    await btn(alice, 'Back to home').click();
    await see(alice, 'Be the banker');
    await alice.page.waitForTimeout(1500);
    if (await alice.page.getByText('Your game is').count()) throw new Error('stale resume card');
  });

  await closeAll();
}

// ---- scenario: Malaysia edition, banker not playing -------------------------------------------

async function rm() {
  const kim = await phone('kim');
  let code;

  await step('banker creates a game without playing', async () => {
    code = await createGame(kim, 'Kim', { plays: false });
    await see(kim, 'Waiting for players to join');
    await see(kim, 'Waiting for 2 players to join');
  });

  await step('picking RM switches defaults to RM15,000 / RM2,000', async () => {
    await kim.page.locator('ion-segment.currency ion-segment-button', { hasText: 'RM' }).click();
    await see(kim, 'Start game · RM15,000 each');
    const debt = kim.page.locator('ion-input[label="Debt limit"] input.native-input:not(.cloned-input)');
    await debt.fill('2000');
    await debt.press('Tab'); // leaving the field saves it, so players see the limit in the lobby
    await debt.scrollIntoViewIfNeeded();
    await shot(kim, 'lobby-debt', 'Lobby: banker sets the debt limit (how far below zero players may go)');
    await kim.page.locator('ion-segment.currency').scrollIntoViewIfNeeded();
    const checked = await kim.page.locator('ion-segment.currency .segment-button-checked').textContent();
    if (checked.trim() !== 'RM') throw new Error(`segment shows ${checked}`);
    await shot(kim, 'lobby-rm', 'Malaysia edition: RM with RM15,000 start and RM2,000 salary');
  });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const siti = await phone('siti', { browser });
  const ravi = await phone('ravi', { browser });
  await step('two players join with the invite link', async () => {
    await joinByLink(siti, code, 'Siti');
    await joinByLink(ravi, code, 'Ravi');
    await see(siti, 'RM2,000');
    await shot(siti, 'waiting-rm', 'Player lobby shows the house rules in RM');
  });

  await step('non-playing banker gets only the bank view', async () => {
    await btn(kim, 'Start game · RM15,000 each').click();
    await see(kim, 'RM30,000');
    if (await kim.page.locator('ion-segment-button', { hasText: 'My wallet' }).count()) throw new Error('wallet tab shown');
    await shot(kim, 'bank-only', 'Banker not playing: bank view only');
  });

  await step('GO pays RM2,000 once the banker approves', async () => {
    await balanceIs(siti, 'RM15,000');
    await btn(siti, 'Pass GO Collect RM2,000 salary').click();
    await alertBtn(siti, 'Ask banker').click();
    await see(kim, 'Siti passed GO');
    await alertBtn(kim, 'Approve').click();
    await balanceIs(siti, 'RM17,000');
    await shot(siti, 'wallet-rm', 'Wallet in RM after passing GO');
  });

  await step('menu and help', async () => {
    await btn(ravi, 'Game menu').click();
    await shot(ravi, 'menu', 'Player menu');
    await sheetBtn(ravi, 'How it works').click();
    await ravi.page.locator('ion-alert').waitFor();
    await shot(ravi, 'help', 'How it works');
    await alertBtn(ravi, 'Got it').click();
  });

  await step('banker corrects a balance', async () => {
    await kim.page.getByRole('button', { name: /^Manage Siti/ }).click();
    await sheetBtn(kim, 'Correct balance').click();
    await see(kim, 'Currently RM17,000');
    await clearPad(kim);
    await keypad(kim, 16500);
    await shot(kim, 'correct', 'Banker: correct a balance');
    await btn(kim, 'Set balance to RM16,500').click();
    await balanceIs(siti, 'RM16,500');
    await toast(siti, 'Banker corrected your balance');
  });

  await step('banker collects RM1,000 from Ravi for the bank', async () => {
    await kim.page.waitForTimeout(1200);
    await kim.page.getByRole('button', { name: /^Manage Ravi/ }).click();
    await sheetBtn(kim, 'Collect for the bank').click();
    await keypad(kim, 1000);
    await btn(kim, 'Collect RM1,000').click();
    await balanceIs(ravi, 'RM14,000');
  });

  await step('Ravi pays more than he has and goes into debt (within the limit)', async () => {
    await ravi.page.waitForTimeout(1200);
    await ravi.page.getByRole('button', { name: /^Pay Siti\./ }).click();
    await keypad(ravi, 15000);
    await see(ravi, 'You’ll owe RM1,000 · limit RM2,000');
    await shot(ravi, 'debt-warning', 'Paying into debt: shows what you’ll owe and the limit');
    await btn(ravi, 'Pay RM15,000 to Siti').click();
    await ravi.page.getByRole('heading', { name: 'Paid Siti' }).waitFor();
    await ravi.page.locator('ion-modal').waitFor({ state: 'detached' });
    await balanceIs(ravi, '−RM1,000');
    await see(ravi, 'In debt · limit RM2,000');
    await shot(ravi, 'in-debt', 'In debt: balance below zero, card turns amber');
  });

  await step('paying past the limit bankrupts him automatically; last player standing wins', async () => {
    await ravi.page.waitForTimeout(1500);
    await btn(ravi, 'Pay bank Buy, tax, fees').click();
    await keypad(ravi, 1500);
    await see(ravi, 'Past the RM2,000 debt limit: this makes you bankrupt');
    await shot(ravi, 'bust-warning', 'Past the debt limit: red warning, button says you’ll go bankrupt');
    await btn(ravi, 'Pay RM1,500 to the bank and go bankrupt').click();
    await see(ravi, 'Go bankrupt?');
    await alertBtn(ravi, 'Pay and go bankrupt').click();
    for (const p of [siti, ravi, kim]) await see(p, 'Siti wins!');
    await see(siti, 'Last player standing');
    await shot(siti, 'last-standing', 'Last player standing wins automatically, no banker action needed');
    const res = await fetch(`${FIRESTORE}/games/${code}`, { headers: { Authorization: 'Bearer owner' } });
    const status = (await res.json()).fields.status.stringValue;
    if (status !== 'ended') throw new Error(`game status is ${status}, expected ended`);
  });

  await settle(browser.close());
  await closeAll();
}

// ---- scenario: edge cases -------------------------------------------------------------------

async function edges() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const olly = await phone('olly', { browser });

  await step('unknown and malformed codes', async () => {
    await olly.page.goto(`${APP}/join/ABCDEF`);
    await see(olly, 'No game found with code ABCDEF');
    await shot(olly, 'join-unknown', 'Join: unknown code');
    await olly.page.getByLabel('Game code').fill('ABCDE0');
    await see(olly, 'That code doesn’t look right');
    await olly.page.goto(`${APP}/game/ZZZZZZ`);
    await see(olly, 'Game not found');
    await shot(olly, 'game-missing', 'Opening a game that doesn’t exist');
  });

  const maya = await phone('maya');
  let code;
  await step('banker creates a game', async () => {
    code = await createGame(maya, 'Maya');
  });

  const zed = await phone('zed', { camera: await qrToCamera(maya, 'edges-join') });
  const players = [];
  await step('lobby fills up to 8 players', async () => {
    await zed.page.goto(APP);
    await btn(zed, 'Scan to join a game').click();
    await see(zed, 'Maya’s game');
    await zed.page.getByLabel('Your name').fill('Zed');
    await btn(zed, 'Join game').click();
    await see(zed, 'You’re in, Zed!');
    for (const name of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
      const p = await phone(name.toLowerCase(), { browser });
      await joinByLink(p, code, name);
      players.push(p);
    }
    await see(maya, '8 / 8');
  });
  const [p1, p2, p3, p4, p5, p6] = players;

  await step('a 9th player is turned away', async () => {
    await olly.page.goto(`${APP}/join/${code}`);
    await see(olly, 'This game is full (8 players)');
    await shot(olly, 'join-full', 'Join: game is full at 8 players');
  });

  await step('banker removes a player; they’re told and can rejoin', async () => {
    await maya.page.getByRole('button', { name: 'Remove P6' }).click();
    await alertBtn(maya, 'Remove').click();
    await see(p6, 'You’re not in this game');
    await shot(p6, 'removed', 'Removed from the lobby: can join again');
    await see(maya, '7 / 8');
  });

  await step('a player leaves the lobby', async () => {
    await btn(p5, 'Leave game').click();
    await alertBtn(p5, 'Leave').click();
    await see(p5, 'Be the banker');
    await see(maya, '6 / 8');
  });

  await step('banker starts; latecomers are turned away', async () => {
    await btn(maya, 'Start game · $1,500 each').click();
    await balanceIs(maya, '$1,500');
    await olly.page.goto(`${APP}/join/${code}`);
    await see(olly, 'This game has already started');
    await shot(olly, 'join-started', 'Join: game already started');
    await olly.page.goto(`${APP}/game/${code}`);
    await see(olly, 'You’re not in this game');
    await shot(olly, 'outsider', 'Outsider opening a running game');
  });

  await step('a player can take back a GO request; the banker’s pop-up closes itself', async () => {
    await btn(p2, 'Pass GO Collect $200 salary').click();
    await alertBtn(p2, 'Ask banker').click();
    await see(maya, 'P2 passed GO');
    await p2.page.getByRole('button', { name: /^Waiting for the banker/ }).click();
    await alertBtn(p2, 'Cancel request').click();
    await maya.page.locator('ion-alert').waitFor({ state: 'detached' });
    await see(p2, 'Pass GO');
  });

  await step('the banker’s own GO is instant after a confirm', async () => {
    await btn(maya, 'Pass GO Collect $200 salary').click();
    await alertBtn(maya, 'Collect').click();
    await balanceIs(maya, '$1,700');
  });

  await step('refresh keeps your seat; home offers to resume', async () => {
    await p1.page.reload();
    await balanceIs(p1, '$1,500');
    await btn(p1, 'Back to home').click();
    await see(p1, 'Your game is in progress');
    await shot(p1, 'resume', 'Home: resume a game in progress (same phone, same seat)');
    await p1.page.getByRole('button', { name: /Your game is in progress/ }).click();
    await balanceIs(p1, '$1,500');
  });

  await step('a cancelled QR can’t be paid', async () => {
    await request(p1, 100);
    const req = await latestRequest(code);
    await btn(p1, 'Cancel').click();
    await p1.page.waitForTimeout(800);
    await p2.page.goto(`${APP}/game/${code}?pay=${req}`);
    await toast(p2, 'This QR code was cancelled');
    await shot(p2, 'qr-cancelled', 'Paying a cancelled QR');
  });

  await step('a QR can only be paid once (deep link from the phone camera)', async () => {
    await request(p1, 100);
    const req = await latestRequest(code);
    await p2.page.goto(`${APP}/game/${code}?pay=${req}`);
    await see(p2, 'Confirm payment');
    await btn(p2, 'Pay $100').click();
    await p2.page.getByRole('heading', { name: 'Paid P1' }).waitFor();
    await p1.page.getByRole('heading', { name: 'P2 paid you' }).waitFor();
    await p3.page.goto(`${APP}/game/${code}?pay=${req}`);
    await toast(p3, 'already been paid');
    await shot(p3, 'qr-reused', 'Paying a QR that was already paid');
  });

  await step('you can’t pay your own QR', async () => {
    await p1.page.waitForTimeout(2500);
    await request(p1, 50);
    const req = await latestRequest(code);
    await p1.page.goto(`${APP}/game/${code}?pay=${req}`);
    await toast(p1, 'That’s your own QR code');
  });

  await step('a request bigger than your cash warns before bankrupting you', async () => {
    await request(p2, 5000);
    const req = await latestRequest(code);
    await p3.page.goto(`${APP}/game/${code}?pay=${req}`);
    await see(p3, 'More than you have: this makes you bankrupt');
    await btn(p3, 'Pay $5,000 and go bankrupt').waitFor();
    await shot(p3, 'qr-too-much', 'Paying a QR you can’t cover: bankruptcy warning first');
    await btn(p3, 'Cancel').click();
    await btn(p2, 'Cancel').click();
  });

  await step('scanning the join QR in Pay explains the mistake', async () => {
    await zed.page.goto(`${APP}/game/${code}`);
    await balanceIs(zed, '$1,500');
    await btn(zed, 'Pay Scan their QR').click();
    await toast(zed, 'That’s the join code');
    await shot(zed, 'scan-wrong-qr', 'Scanning the join QR when paying');
  });

  await step('a reversal that would overdraw is refused', async () => {
    await p1.page.waitForTimeout(1500);
    await btn(p1, 'Pay bank Buy, tax, fees').click();
    await keypad(p1, 1600);
    await btn(p1, 'Pay $1,600 to the bank').click();
    await p1.page.getByRole('heading', { name: 'Paid the bank' }).waitFor();
    await maya.page.locator('ion-segment-button', { hasText: 'Bank' }).click();
    await maya.page.getByRole('button', { name: /^P2 paid P1.*Tap to reverse/ }).click();
    await alertBtn(maya, 'Reverse').click();
    await toast(maya, 'Can’t reverse: P1 would go past the $0 debt limit');
    await shot(maya, 'undo-refused', 'Undo refused when the player already spent it');
  });

  await step('offline: banner shows and money buttons pause', async () => {
    await p3.page.goto(`${APP}/game/${code}`);
    await balanceIs(p3, '$1,500');
    await p3.ctx.setOffline(true);
    await see(p3, 'Offline · payments paused');
    if (await btn(p3, 'Pay bank Buy, tax, fees').isEnabled()) throw new Error('buttons still enabled offline');
    await shot(p3, 'offline', 'Offline: banner, money buttons paused');
    await p3.ctx.setOffline(false);
    await p3.page.getByText('Offline · payments paused').waitFor({ state: 'detached' });
  });

  await step('banker declares a player bankrupt to the bank', async () => {
    await maya.page.getByRole('button', { name: /^Manage P4/ }).click();
    await sheetBtn(maya, 'Declare bankrupt').click();
    await sheetBtn(maya, 'The bank').click();
    await alertBtn(maya, 'Declare bankrupt').click();
    await see(p4, 'You’re out of the game');
  });

  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const owner = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  const exists = async p => (await fetch(`${FIRESTORE}/${p}`, { headers: owner })).status === 200;
  const old = ['games/OLDGME', 'games/OLDGME/players/p1', 'games/OLDGME/txns/t1'];
  await step('plant a game that expired 3 days ago', async () => {
    for (const p of old) {
      const res = await fetch(`${FIRESTORE}/${p}`, { method: 'PATCH', headers: owner, body: JSON.stringify({ fields: { expireAt: { timestampValue: past } } }) });
      if (!res.ok) throw new Error(`seed ${p}: ${res.status}`);
    }
  });

  await step('a game cancelled in the lobby says so', async () => {
    const code2 = await createGame(maya, 'Maya');
    await joinByLink(olly, code2, 'Olly');
    await btn(maya, 'Game menu').click();
    await sheetBtn(maya, 'Cancel game').click();
    await alertBtn(maya, 'Cancel game').click();
    await see(olly, 'Game cancelled');
    await shot(olly, 'cancelled', 'Banker cancelled the game in the lobby');
  });

  await step('creating that game swept the expired one away', async () => {
    for (let i = 0; i < 50 && (await Promise.all(old.map(exists))).some(Boolean); i++) await maya.page.waitForTimeout(200);
    const left = (await Promise.all(old.map(async p => ((await exists(p)) ? p : null)))).filter(Boolean);
    if (left.length) throw new Error(`not swept: ${left.join(', ')}`);
  });

  await settle(browser.close());
  await closeAll();
}

// ---- scenario: production PWA build --------------------------------------------------------

async function pwa() {
  const www = path.join(ROOT, '..', 'www');
  await step('production build', async () => {
    try {
      execSync('npx ng build', { cwd: path.join(ROOT, '..'), stdio: 'pipe' });
    } catch (e) {
      throw new Error(`ng build failed:\n${e.stderr}`);
    }
  });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(www, url);
    if (!file.startsWith(www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(www, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(4310);
  const base = 'http://localhost:4310';
  const pat = await phone('pat'); // a real profile: Chrome never offers install in incognito

  await step('manifest and icons', async () => {
    const m = await (await fetch(`${base}/manifest.webmanifest`)).json();
    if (m.display !== 'standalone' || !m.icons.some(i => i.purpose === 'maskable')) throw new Error('manifest incomplete');
    for (const i of m.icons) if ((await fetch(`${base}/${i.src}`)).status !== 200) throw new Error(`missing ${i.src}`);
  });

  await step('installable, service worker active', async () => {
    await pat.page.goto(base);
    await see(pat, 'Board Banker');
    await pat.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const cdp = await pat.ctx.newCDPSession(pat.page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    if (installabilityErrors.length) throw new Error(JSON.stringify(installabilityErrors));
  });

  await step('home reports the live Firebase sign-in status', async () => {
    await pat.page.reload();
    await see(pat, 'Board Banker');
    await pat.page.waitForTimeout(3000);
    const disabled = await pat.page.getByText('Sign-in isn’t enabled').count();
    console.log(disabled ? '(Anonymous auth is OFF in Firebase) ' : '(Anonymous auth is on) ');
    await shot(pat, 'prod-home', disabled ? 'Production build: Anonymous sign-in not enabled yet' : 'Production build home');
  });

  await step('works offline after the first visit (app shell cached)', async () => {
    await pat.ctx.setOffline(true);
    await pat.page.goto(`${base}/join/ABCDEF`);
    await see(pat, 'Join a game');
    await shot(pat, 'prod-offline', 'Production build opened offline from the service-worker cache');
    await pat.ctx.setOffline(false);
  });

  await closeAll();
  server.close();
}

// ---- run ----------------------------------------------------------------------------------

const scenarios = { main, rm, edges, pwa };
// A subset run keeps the other scenarios' screenshots.
const rerun = only.length ? only : Object.keys(scenarios);
const manifestFile = path.join(OUT, 'manifest.json');
if (fs.existsSync(manifestFile)) manifest.push(...JSON.parse(fs.readFileSync(manifestFile, 'utf8')).filter(m => !rerun.includes(m.scenario)));
for (const s of rerun) fs.rmSync(path.join(OUT, s), { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'failures'), { recursive: true, force: true });
fs.rmSync(PROFILES, { recursive: true, force: true });
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  scenario = name;
  console.log(`\n${name}`);
  try {
    await fn();
  } catch {
    await closeAll();
  }
}
const order = Object.keys(scenarios);
manifest.sort((a, b) => order.indexOf(a.scenario) - order.indexOf(b.scenario) || a.file.localeCompare(b.file));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
console.log(`\n${failed ? `${failed} scenario(s) FAILED` : 'All scenarios passed'} · ${manifest.length} screenshots`);
if (errors.length) console.log(`Browser errors:\n  ${errors.join('\n  ')}`);
process.exit(failed ? 1 : 0);
