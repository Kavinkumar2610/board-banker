import {
  Player, Txn, deedValue, deltaFor, fmt, isCode, keepAwake, newCode, parseQr, quotaReset, rank, retry, setCurrency, signed, txnText,
  undoable,
} from './money';

const p = (id: string, balance: number, bankrupt = false, bankruptAt?: number): Player =>
  ({ id, name: id, color: 0, balance, bankrupt, bankruptAt });
const t = (kind: Txn['kind'], from: string | null, to: string | null, amount: number, undone = false): Txn =>
  ({ id: 'x', kind, from, to, amount, by: 'b', at: null, undone });

describe('money', () => {
  it('formats cash', () => {
    expect(fmt(1500)).toBe('$1,500');
    expect(fmt(-50)).toBe('−$50');
    expect(signed(200)).toBe('+$200');
    expect(signed(-200)).toBe('−$200');
    setCurrency('RM');
    expect(fmt(2000)).toBe('RM2,000');
    setCurrency('nonsense');
    expect(fmt(5)).toBe('$5');
  });

  it('makes readable game codes', () => {
    for (let i = 0; i < 200; i++) expect(isCode(newCode())).toBe(true);
    expect(isCode('ABCDE0')).toBe(false); // 0 is excluded
  });

  it('parses join and payment QRs', () => {
    expect(parseQr('https://x.web.app/join/k7p2qx')).toEqual({ code: 'K7P2QX' });
    expect(parseQr('https://x.web.app/game/K7P2QX?pay=abc123')).toEqual({ code: 'K7P2QX', req: 'abc123' });
    expect(parseQr(' k7p2qx ')).toEqual({ code: 'K7P2QX' });
    expect(parseQr('https://example.com/menu')).toBeNull();
    expect(parseQr('hello world')).toBeNull();
  });

  it('ranks by cash, then by who went bankrupt last', () => {
    const order = rank([p('a', 100), p('b', 0, true, 1), p('c', 900), p('d', 0, true, 2)]).map(x => x.id);
    expect(order).toEqual(['c', 'a', 'd', 'b']);
  });

  it('ranks by net worth once properties are entered', () => {
    const order = rank([{ ...p('rich', 900), assets: 0 }, { ...p('landlord', 300), assets: 1000 }, p('cash', 800)]).map(x => x.id);
    expect(order).toEqual(['landlord', 'rich', 'cash']);
  });

  it('retries only temporary failures, a limited number of times', async () => {
    const busy = (e: unknown) => e === 'busy';
    const flaky = (fails: number, error = 'busy') => {
      let calls = 0;
      return { fn: async () => (++calls <= fails ? Promise.reject(error) : 'ok'), calls: () => calls };
    };
    const once = flaky(1);
    expect(await retry(once.fn, busy, [0, 0])).toBe('ok');
    expect(once.calls()).toBe(2);
    const broken = flaky(1, 'broken');
    await expect(retry(broken.fn, busy, [0, 0])).rejects.toBe('broken');
    expect(broken.calls()).toBe(1); // a real error isn't retried
    const down = flaky(9);
    await expect(retry(down.fn, busy, [0, 0])).rejects.toBe('busy');
    expect(down.calls()).toBe(3); // the first try plus one per wait
  });

  it('values a property card at its printed prices', () => {
    const deed = { name: 'X', mortgage: 1000, house: 500, hotel: 500, houses: 3, hotels: 0, scanned: true };
    expect(deedValue(deed)).toBe(2500);
    expect(deedValue({ ...deed, houses: 0, hotels: 1 })).toBe(1500);
  });

  it('computes my side of a transaction', () => {
    expect(deltaFor(t('pay', 'me', 'bob', 50), 'me')).toBe(-50);
    expect(deltaFor(t('pay', 'bob', 'me', 50), 'me')).toBe(50);
    expect(deltaFor(t('adjust', null, 'me', -30), 'me')).toBe(-30);
    expect(deltaFor(t('start', null, null, 1500), 'me')).toBe(0);
  });

  it('only reverses money moves, once', () => {
    expect(undoable(t('pay', 'a', 'b', 1))).toBe(true);
    expect(undoable(t('pay', 'a', 'b', 1, true))).toBe(false);
    expect(undoable(t('adjust', null, 'b', 1))).toBe(false);
  });

  it('describes transactions from my point of view', () => {
    const name = (id: string | null) => id ?? 'Bank';
    expect(txnText(t('pay', 'me', 'bob', 5), name, 'me')).toBe('You paid bob');
    expect(txnText(t('adjust', null, 'me', 5), name, 'me')).toBe('Banker corrected your balance');
    expect(txnText(t('grab', null, null, 1000), name, 'me')).toBe('Cash grab · the bank threw cash');
    expect(txnText(t('grab', null, 'me', 300), name, 'me')).toBe('You grabbed cash');
    expect(deltaFor(t('grab', null, null, 1000), 'me')).toBe(0);
  });

  it('knows when the free quota resets (midnight US Pacific)', () => {
    const at = (iso: string) => quotaReset(new Date(iso)).toISOString();
    expect(at('2026-10-27T03:00:00.250Z')).toBe('2026-10-27T07:00:00.250Z'); // summer time, UTC−7: 3 PM in Malaysia
    expect(at('2026-11-10T03:00:00Z')).toBe('2026-11-10T08:00:00.000Z'); // winter time, UTC−8: 4 PM in Malaysia
    expect(at('2026-11-10T08:00:00Z')).toBe('2026-11-11T08:00:00.000Z'); // just reset: the next one is a day away
  });

  it('keeps the screen awake, retaking the lock after the OS drops it', async () => {
    const locks: { released: boolean }[] = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request: async () => {
        const lock = { released: false, release: async () => { lock.released = true; } };
        locks.push(lock);
        return lock;
      },
    } });
    const tap = async () => { document.dispatchEvent(new Event('pointerdown')); await new Promise(r => setTimeout(r)); };

    const stop = keepAwake();
    await tap();
    expect(locks.length).toBe(1); // still held: a tap doesn't take a second lock
    locks[0].released = true; // the OS dropped it while the app was hidden
    await tap();
    expect(locks.length).toBe(2); // retaken on the next tap
    stop();
    expect(locks[1].released).toBe(true);
    await tap();
    expect(locks.length).toBe(2); // stopped: no more requests
  });
});
