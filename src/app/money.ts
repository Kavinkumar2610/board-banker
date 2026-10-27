import type { Timestamp } from 'firebase/firestore';

export const MIN_PLAYERS = 2;
/** Firestore TTL deletes a game and everything in it this many days after it was created. */
export const KEEP_DAYS = 7;
export const MAX_PLAYERS = 8;

/** Currencies the banker can pick, with that edition's usual starting cash and GO salary. */
export const CURRENCIES = [
  { symbol: '$', start: 1500, salary: 200 },
  { symbol: 'RM', start: 15000, salary: 2000 },
  { symbol: '£', start: 1500, salary: 200 },
  { symbol: '€', start: 1500, salary: 200 },
];
export const currencyOf = (symbol?: string) => CURRENCIES.find(c => c.symbol === symbol) ?? CURRENCIES[0];

export type Status = 'lobby' | 'active' | 'ended';
export type Kind = 'start' | 'pay' | 'salary' | 'bank-in' | 'bank-out' | 'adjust' | 'undo' | 'bankrupt';

export interface Game {
  code: string;
  bankerUid: string;
  bankerName: string;
  bankerPlays: boolean;
  status: Status;
  currency: string;
  startingCash: number;
  salary: number;
  /** How far below zero a player may go; paying past it makes them bankrupt. 0 = no debt. */
  debtLimit?: number;
  /** Set when the banker starts the game; an ended game without it was cancelled in the lobby. */
  startedAt?: unknown;
  /** Copied onto every record of the game, so TTL removes the whole game together. */
  expireAt: Timestamp;
}

export interface Player {
  id: string;
  name: string;
  color: number;
  balance: number;
  bankrupt: boolean;
  bankruptAt?: number;
}

/** `from`/`to` are player ids; null means the bank. */
export interface Txn {
  id: string;
  kind: Kind;
  from: string | null;
  to: string | null;
  amount: number;
  by: string;
  at: Date | null;
  undone?: boolean;
  /** This payment took the payer past the debt limit, so they went bankrupt. */
  bust?: boolean;
}

/** A "Get paid" QR, or (kind 'go') a player asking the banker for their GO salary. */
export interface PayRequest {
  kind?: 'go';
  to: string;
  amount: number;
  status: 'open' | 'paid' | 'cancelled' | 'declined';
  paidBy?: string;
}
export type GoRequest = PayRequest & { id: string };

/** An error whose message is safe to show the player as-is. */
export class BankError extends Error {}

/** When Firebase's free daily quota resets: the next midnight, US Pacific time. */
export function quotaReset(now = new Date()): Date {
  const [h, m, s] = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => Number(p.value));
  // ponytail: an hour out on the two US clock-change days; good enough for "try again after".
  return new Date(now.getTime() + ((24 - h) * 3600 - m * 60 - s) * 1000);
}

/** Classic property-group colours, one per seat; fg keeps the initial readable. */
export const TOKENS = [
  { bg: '#955436', fg: '#ffffff' },
  { bg: '#aae0fa', fg: '#0b1220' },
  { bg: '#d93a96', fg: '#ffffff' },
  { bg: '#f7941d', fg: '#0b1220' },
  { bg: '#e0242c', fg: '#ffffff' },
  { bg: '#fef200', fg: '#0b1220' },
  { bg: '#1fb25a', fg: '#0b1220' },
  { bg: '#3b6fe0', fg: '#ffffff' },
];

const nf = new Intl.NumberFormat('en-US');
// ponytail: only one game is on screen at a time, so its currency lives here instead of being passed to every fmt().
let currency = CURRENCIES[0].symbol;
export const setCurrency = (symbol?: string) => { currency = currencyOf(symbol).symbol; };
export const fmt = (n: number) => (n < 0 ? '−' : '') + currency + nf.format(Math.abs(n));
export const signed = (n: number) => (n > 0 ? '+' : '') + fmt(n);

// No 0/O or 1/I/L, so codes survive being read out loud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), n => ALPHABET[n % ALPHABET.length]).join('');
export const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
export const isCode = (s: string) => /^[A-HJKMNP-Z2-9]{6}$/.test(s);

export const joinUrl = (code: string) => `${location.origin}/join/${code}`;
export const payUrl = (code: string, req: string) => `${location.origin}/game/${code}?pay=${req}`;

/** Reads a join QR (/join/CODE), a payment QR (/game/CODE?pay=REQ) or a bare code. */
export function parseQr(text: string): { code: string; req?: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    const code = cleanCode(text);
    return text.trim().length === 6 && isCode(code) ? { code } : null;
  }
  const m = url.pathname.match(/\/(?:join|game)\/([A-Za-z0-9]{6})\/?$/);
  if (!m || !isCode(m[1].toUpperCase())) return null;
  const req = url.searchParams.get('pay');
  return req ? { code: m[1].toUpperCase(), req } : { code: m[1].toUpperCase() };
}

/** Solvent players by cash, then bankrupt players, last to go bust first. */
export const rank = (players: Player[]) =>
  [...players].sort((a, b) =>
    a.bankrupt !== b.bankrupt ? Number(a.bankrupt) - Number(b.bankrupt)
    : a.bankrupt ? (b.bankruptAt ?? 0) - (a.bankruptAt ?? 0)
    : b.balance - a.balance);

/** How much a transaction changed `me`'s cash. */
export const deltaFor = (t: Txn, me: string | null) =>
  t.kind === 'start' ? 0 : (t.to === me ? t.amount : 0) - (t.from === me ? t.amount : 0);

/** Reversing is moving the amount back from `to` to `from`. */
export const undoable = (t: Txn) => !t.undone && !t.bust && ['pay', 'salary', 'bank-in', 'bank-out'].includes(t.kind);

export function txnText(t: Txn, name: (id: string | null) => string, me: string | null): string {
  const text = describeTxn(t, name, me);
  return t.bust ? `${text} · went bankrupt` : text;
}

function describeTxn(t: Txn, name: (id: string | null) => string, me: string | null): string {
  const who = (id: string | null, start = false) => (id && id === me ? (start ? 'You' : 'you') : name(id));
  switch (t.kind) {
    case 'start': return `Game started · everyone got ${fmt(t.amount)}`;
    case 'pay': return `${who(t.from, true)} paid ${who(t.to)}`;
    case 'salary': return `${who(t.to, true)} passed GO`;
    case 'bank-in': return `${who(t.from, true)} paid the bank`;
    case 'bank-out': return `Bank paid ${who(t.to)}`;
    case 'adjust': return `Banker corrected ${t.to === me ? 'your' : `${name(t.to)}'s`} balance`;
    case 'undo': return `Reversed · ${who(t.from, true)} → ${who(t.to)}`;
    case 'bankrupt': return `${who(t.from, true)} went bankrupt` + (t.to ? ` · cash to ${who(t.to)}` : '');
  }
}

/** localStorage that tolerates private mode and blocked storage. */
export const prefs = {
  get(key: 'game' | 'name'): string | null {
    try { return localStorage.getItem(`mb.${key}`); } catch { return null; }
  },
  set(key: 'game' | 'name', value: string | null) {
    try {
      if (value === null) localStorage.removeItem(`mb.${key}`);
      else localStorage.setItem(`mb.${key}`, value);
    } catch { /* storage unavailable: the app still works, it just won't remember */ }
  },
};

export const buzz = (ms: number | number[] = 12) => navigator.vibrate?.(ms);

/**
 * Keeps the screen on until the returned function is called. The OS drops the lock whenever the app is hidden,
 * so it's retaken when the app comes back, or on the next tap where Safari only grants it right after one.
 */
export function keepAwake(): () => void {
  let lock: WakeLockSentinel | undefined;
  let asking = false;
  let on = true;
  const take = async () => {
    if (!on || asking || document.hidden || (lock && !lock.released)) return;
    asking = true;
    lock = await navigator.wakeLock?.request('screen').catch(() => undefined);
    asking = false;
    if (!on) void lock?.release().catch(() => undefined);
  };
  const events = ['visibilitychange', 'pointerdown'];
  events.forEach(e => document.addEventListener(e, take));
  void take();
  return () => {
    on = false;
    events.forEach(e => document.removeEventListener(e, take));
    void lock?.release().catch(() => undefined);
  };
}
