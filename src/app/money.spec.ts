import { Player, Txn, deltaFor, fmt, isCode, newCode, parseQr, rank, setCurrency, signed, txnText, undoable } from './money';

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
  });
});
