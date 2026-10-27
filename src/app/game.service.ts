import { Injectable, computed, signal } from '@angular/core';
import { signInAnonymously } from 'firebase/auth';
import {
  DocumentSnapshot, QueryDocumentSnapshot, Timestamp, Unsubscribe, addDoc, collection, deleteDoc, doc, getDoc, getDocs,
  limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import {
  BankError, CURRENCIES, Game, GoRequest, KEEP_DAYS, Kind, MAX_PLAYERS, PayRequest, Player, TOKENS, Txn, fmt, newCode, quotaReset, rank,
  setCurrency,
} from './money';

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void> }

const toTxn = (d: QueryDocumentSnapshot | DocumentSnapshot): Txn => {
  const x = d.data({ serverTimestamps: 'estimate' })!;
  return { ...(x as Omit<Txn, 'id' | 'at'>), id: d.id, at: x['at']?.toDate?.() ?? null };
};

const newPlayer = (name: string, color: number, expireAt: Timestamp) =>
  ({ name, color, balance: 0, bankrupt: false, joinedAt: serverTimestamp(), expireAt });

@Injectable({ providedIn: 'root' })
export class GameService {
  readonly uid = signal<string | null>(null);
  readonly code = signal<string | null>(null);
  /** undefined while loading, null when the game doesn't exist or can't be read. */
  readonly game = signal<Game | null | undefined>(undefined);
  readonly players = signal<Player[]>([]);
  /** True once the first players snapshot has arrived, so membership is known. */
  readonly synced = signal(false);
  /** Set when we can't sign in or read the game (e.g. anonymous auth disabled, or the free daily quota used up). */
  readonly error = signal('');
  readonly txns = signal<Txn[]>([]);
  /** Open "I passed GO" requests waiting for the banker, oldest first. */
  readonly goRequests = signal<GoRequest[]>([]);
  /** Latest transaction someone else made that touched my cash. */
  readonly incoming = signal<Txn | null>(null);
  readonly online = signal(navigator.onLine);
  readonly installPrompt = signal<BeforeInstallPromptEvent | null>(null);

  readonly me = computed(() => this.players().find(p => p.id === this.uid()) ?? null);
  readonly isBanker = computed(() => !!this.uid() && this.game()?.bankerUid === this.uid());
  readonly isMember = computed(() => this.isBanker() || !!this.me());
  readonly ranked = computed(() => rank(this.players()));

  private user?: Promise<string>;
  private unsubs: Unsubscribe[] = [];

  constructor() {
    addEventListener('online', () => this.online.set(true));
    addEventListener('offline', () => this.online.set(false));
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); this.installPrompt.set(e as BeforeInstallPromptEvent); });
    addEventListener('appinstalled', () => this.installPrompt.set(null));
  }

  signIn(): Promise<string> {
    this.user ??= (async () => {
      await auth.authStateReady();
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
      this.uid.set(user.uid);
      return user.uid;
    })().catch(e => { this.user = undefined; throw e; });
    return this.user;
  }

  name(id: string | null): string {
    if (!id) return 'Bank';
    return this.players().find(p => p.id === id)?.name
      ?? (id === this.game()?.bankerUid ? this.game()!.bankerName : 'A former player');
  }

  // ---- live game ---------------------------------------------------------------------------

  async watch(code: string) {
    if (this.code() === code) return;
    this.stop();
    this.code.set(code);
    try {
      await this.signIn();
    } catch (e) {
      this.error.set(errorText(e));
      this.game.set(null);
      return;
    }
    if (this.code() !== code) return;
    const g = doc(db, 'games', code);
    let first = true;
    this.unsubs = [
      onSnapshot(g, s => {
        const game = s.exists() ? (s.data() as Game) : null;
        setCurrency(game?.currency); // before the signal fires, so every amount renders in it
        this.game.set(game);
      }, e => { this.error.set(errorText(e)); this.game.set(null); }),
      onSnapshot(collection(g, 'players'), s => {
        this.players.set(s.docs.map(d => ({ ...(d.data() as Omit<Player, 'id'>), id: d.id })));
        this.synced.set(true);
      }),
      onSnapshot(query(collection(g, 'txns'), orderBy('at', 'desc'), limit(100)), s => {
        const uid = this.uid();
        if (!first) {
          for (const c of s.docChanges()) {
            const t = toTxn(c.doc);
            if (c.type === 'added' && t.by !== uid && (t.to === uid || t.from === uid)) this.incoming.set(t);
          }
        }
        first = false;
        this.txns.set(s.docs.map(toTxn));
      }),
      onSnapshot(query(collection(g, 'requests'), where('kind', '==', 'go'), where('status', '==', 'open')), s =>
        this.goRequests.set(s.docs
          .map(d => ({ ...(d.data({ serverTimestamps: 'estimate' }) as PayRequest & { createdAt?: { toMillis(): number } }), id: d.id }))
          .sort((a, b) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0)))),
    ];
  }

  stop() {
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    this.code.set(null);
    this.game.set(undefined);
    this.players.set([]);
    this.synced.set(false);
    this.error.set('');
    this.txns.set([]);
    this.goRequests.set([]);
    this.incoming.set(null);
    setCurrency();
  }

  private ref(...path: string[]) {
    return doc(db, 'games', this.code()!, ...path);
  }

  /** Every record in a game carries the game's expiry so TTL cleans it up with the game. */
  private get expireAt() {
    return this.game()!.expireAt;
  }

  // ---- lobby -------------------------------------------------------------------------------

  async createGame(name: string, bankerPlays: boolean): Promise<string> {
    const uid = await this.signIn();
    // A clash with an existing code fails the rules (it would be an update by a non-banker).
    const code = newCode();
    const g = doc(db, 'games', code);
    const batch = writeBatch(db);
    const { symbol, start, salary } = CURRENCIES[0];
    const expireAt = Timestamp.fromMillis(Date.now() + KEEP_DAYS * 86_400_000);
    batch.set(g, {
      code, bankerUid: uid, bankerName: name, bankerPlays, status: 'lobby',
      currency: symbol, startingCash: start, salary, debtLimit: 0, createdAt: serverTimestamp(), expireAt,
    });
    if (bankerPlays) batch.set(doc(g, 'players', uid), newPlayer(name, 0, expireAt));
    await batch.commit();
    void this.sweepExpired().catch(() => undefined); // housekeeping; never blocks the banker
    return code;
  }

  /**
   * ponytail: stand-in for Firestore TTL until the project is on the Blaze plan. Deletes a few games that
   * expired over a day ago (the day covers phone clock drift), children first. Upgrade path: enable the
   * TTL policies (see README) and delete this.
   */
  private async sweepExpired() {
    const cutoff = Timestamp.fromMillis(Date.now() - 86_400_000);
    const old = await getDocs(query(collection(db, 'games'), where('expireAt', '<', cutoff), limit(5)));
    for (const game of old.docs) {
      for (const sub of ['players', 'requests', 'txns']) {
        const docs = (await getDocs(collection(game.ref, sub))).docs;
        for (let i = 0; i < docs.length; i += 450) {
          const batch = writeBatch(db);
          docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }
      await deleteDoc(game.ref);
    }
  }

  /** Looks a game up before joining, so the join screen can say who's hosting. */
  async preview(code: string): Promise<{ game: Game; players: Player[]; member: boolean }> {
    const uid = await this.signIn();
    const g = doc(db, 'games', code);
    const [gs, ps] = await Promise.all([getDoc(g), getDocs(collection(g, 'players'))]);
    if (!gs.exists()) throw new BankError(`No game found with code ${code}. Check the code with your banker.`);
    const game = gs.data() as Game;
    const players = ps.docs.map(d => ({ ...(d.data() as Omit<Player, 'id'>), id: d.id }));
    return { game, players, member: game.bankerUid === uid || players.some(p => p.id === uid) };
  }

  async join(code: string, name: string) {
    const uid = await this.signIn();
    const { game, players, member } = await this.preview(code);
    if (member) return;
    if (game.status !== 'lobby') throw new BankError('This game has already started, so new players can’t join.');
    if (players.length >= MAX_PLAYERS) throw new BankError(`This game is full (${MAX_PLAYERS} players).`);
    if (players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      throw new BankError(`Someone is already called ${name}. Try a different name.`);
    }
    const used = new Set(players.map(p => p.color));
    const color = TOKENS.findIndex((_, i) => !used.has(i));
    // ponytail: two people joining in the same instant could both take seat 8; the banker can remove one.
    await setDoc(doc(db, 'games', code, 'players', uid), newPlayer(name, Math.max(color, 0), game.expireAt));
  }

  setMoney(startingCash: number, salary: number, currency: string, debtLimit: number) {
    return updateDoc(this.ref(), { startingCash, salary, currency, debtLimit });
  }

  leave(playerId = this.uid()!) {
    return deleteDoc(this.ref('players', playerId));
  }

  /** Starts the game with the amounts on the banker's screen (saved in the same write). */
  async start(money: { startingCash: number; salary: number; debtLimit: number }) {
    const game = this.game()!;
    const batch = writeBatch(db);
    batch.update(this.ref(), { status: 'active', startedAt: serverTimestamp(), ...money });
    for (const p of this.players()) batch.update(this.ref('players', p.id), { balance: money.startingCash });
    batch.set(doc(collection(db, 'games', game.code, 'txns')), {
      kind: 'start', from: null, to: null, amount: money.startingCash, by: this.uid(), at: serverTimestamp(), expireAt: game.expireAt,
    });
    await batch.commit();
  }

  end() {
    return updateDoc(this.ref(), { status: 'ended', endedAt: serverTimestamp() });
  }

  // ---- money -------------------------------------------------------------------------------

  /**
   * Moves cash atomically. `from`/`to` null means the bank. A payer may go into debt down to the game's
   * debt limit; a payment past it still pays in full and makes the payer bankrupt (except a reversal,
   * which is refused instead). The Firestore rules decide whether the caller may make this move.
   */
  private async move(
    from: string | null, to: string | null, amount: number, kind: Kind,
    opts: { reqId?: string; undoOf?: string; bankrupt?: boolean } = {},
  ) {
    const uid = this.uid()!;
    const name = (id: string, p: Player) => (id === uid ? 'You' : p.name);
    const limit = this.game()!.debtLimit ?? 0;
    await runTransaction(db, async tx => {
      // All reads in one round trip: each trip to the database is the slow part.
      const [req, orig, src, dst] = await Promise.all([
        opts.reqId ? tx.get(this.ref('requests', opts.reqId)) : null,
        opts.undoOf ? tx.get(this.ref('txns', opts.undoOf)) : null,
        from ? tx.get(this.ref('players', from)) : null,
        to ? tx.get(this.ref('players', to)) : null,
      ]);

      if (req) {
        const r = req.data() as PayRequest | undefined;
        if (!r || r.status !== 'open') {
          throw new BankError(r?.kind === 'go' ? 'That GO request is no longer waiting.' : 'This QR code was already used or cancelled. Ask for a new one.');
        }
        if (r.to !== to || r.amount !== amount) throw new BankError('This payment request changed. Scan it again.');
      }
      if (orig && (orig.data() as Txn | undefined)?.undone) throw new BankError('That transaction was already reversed.');

      const payer = src?.data() as Player | undefined;
      const payee = dst?.data() as Player | undefined;
      if (src && !payer) throw new BankError('That player is no longer in the game.');
      if (dst && !payee) throw new BankError('That player is no longer in the game.');
      if (payer?.bankrupt) throw new BankError(`${name(from!, payer)} ${from === uid ? 'are' : 'is'} bankrupt.`);
      if (payee?.bankrupt) throw new BankError(`${payee.name} is bankrupt and can’t receive money.`);
      if (opts.bankrupt) amount = Math.max(payer!.balance, 0); // hand over cash you have, not debt
      const after = (payer?.balance ?? 0) - amount;
      const bust = !!payer && !opts.bankrupt && after < -limit;
      if (bust && opts.undoOf) {
        throw new BankError(`Can’t reverse: ${payer!.name} would go past the ${fmt(limit)} debt limit.`);
      }

      if (src) {
        tx.update(src.ref, opts.bankrupt
          ? { balance: Math.min(payer!.balance, 0), bankrupt: true, bankruptAt: Date.now() }
          : bust ? { balance: after, bankrupt: true, bankruptAt: Date.now() } : { balance: after });
      }
      if (dst && amount > 0) tx.update(dst.ref, { balance: payee!.balance + amount });
      if (req) tx.update(req.ref, { status: 'paid', paidBy: uid, paidAt: serverTimestamp() });
      if (orig) tx.update(orig.ref, { undone: true });
      tx.set(doc(collection(db, 'games', this.code()!, 'txns')), {
        kind, from, to, amount, by: uid, at: serverTimestamp(), expireAt: this.expireAt,
        ...(opts.undoOf ? { undoOf: opts.undoOf } : {}), ...(bust ? { bust: true } : {}),
      });
    });
  }

  /** Players ask the banker for their GO salary; the banker's own GO is paid straight away. */
  async passGo() {
    const { salary } = this.game()!;
    if (this.isBanker()) return this.move(null, this.uid(), salary, 'salary');
    await addDoc(collection(db, 'games', this.code()!, 'requests'), {
      kind: 'go', to: this.uid(), amount: salary, status: 'open', createdAt: serverTimestamp(), expireAt: this.expireAt,
    });
  }
  approveGo(r: GoRequest) { return this.move(null, r.to, r.amount, 'salary', { reqId: r.id }); }
  declineGo(r: GoRequest) { return updateDoc(this.ref('requests', r.id), { status: 'declined' }); }
  pay(to: string, amount: number) { return this.move(this.uid(), to, amount, 'pay'); }
  payBank(amount: number) { return this.move(this.uid(), null, amount, 'bank-in'); }
  bankPays(to: string, amount: number) { return this.move(null, to, amount, 'bank-out'); }
  bankCollects(from: string, amount: number) { return this.move(from, null, amount, 'bank-in'); }
  undo(t: Txn) { return this.move(t.to, t.from, t.amount, 'undo', { undoOf: t.id }); }
  /** Hands all remaining cash to the creditor (null = bank) and marks the player bankrupt. */
  bankrupt(playerId: string, creditor: string | null) {
    return this.move(playerId, creditor, 0, 'bankrupt', { bankrupt: true });
  }

  async correct(playerId: string, balance: number) {
    await runTransaction(db, async tx => {
      const ref = this.ref('players', playerId);
      const p = (await tx.get(ref)).data() as Player | undefined;
      if (!p) throw new BankError('That player is no longer in the game.');
      if (p.balance === balance) return;
      tx.update(ref, { balance });
      tx.set(doc(collection(db, 'games', this.code()!, 'txns')), {
        kind: 'adjust', from: null, to: playerId, amount: balance - p.balance, by: this.uid(), at: serverTimestamp(),
        expireAt: this.expireAt,
      });
    });
  }

  // ---- payment requests (the "Get paid" QR) -------------------------------------------------

  async createRequest(amount: number): Promise<string> {
    const r = await addDoc(collection(db, 'games', this.code()!, 'requests'), {
      to: this.uid(), amount, status: 'open', createdAt: serverTimestamp(), expireAt: this.expireAt,
    });
    return r.id;
  }

  watchRequest(id: string, cb: (r: PayRequest) => void): Unsubscribe {
    return onSnapshot(this.ref('requests', id), s => s.exists() && cb(s.data() as PayRequest));
  }

  async cancelRequest(id: string) {
    await updateDoc(this.ref('requests', id), { status: 'cancelled' }).catch(() => undefined); // already paid: fine
  }

  async getRequest(id: string): Promise<PayRequest> {
    const s = await getDoc(this.ref('requests', id));
    if (!s.exists()) throw new BankError('That payment QR isn’t valid. Ask them to show it again.');
    return s.data() as PayRequest;
  }

  payRequest(id: string, r: PayRequest) {
    return this.move(this.uid(), r.to, r.amount, 'pay', { reqId: id });
  }
}

/** Turns any failure into a sentence a player can act on. */
export function errorText(e: unknown): string {
  if (e instanceof BankError) return e.message;
  console.error(e);
  const code = String((e as { code?: string })?.code ?? '');
  if (!navigator.onLine || code.includes('unavailable')) return 'Can’t reach the bank. Check your connection and try again.';
  if (code.includes('resource-exhausted')) {
    const reset = quotaReset();
    const when = (reset.getDate() === new Date().getDate() ? '' : 'tomorrow ') + reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Board Banker has used up its free capacity for today. Games and balances are safe. Try again after ${when}.`;
  }
  if (code.includes('permission-denied')) return 'The bank refused that. The game may have changed, so try again.';
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted') || code.includes('configuration-not-found')) {
    return 'Sign-in isn’t enabled for this app yet. The app owner needs to turn on Anonymous sign-in in Firebase.';
  }
  return 'Something went wrong. Please try again.';
}
