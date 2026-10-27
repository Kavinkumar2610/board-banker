import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  ActionSheetButton, ActionSheetController, AlertController, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon,
  IonInput, IonLabel, IonSegment, IonSegmentButton, IonSpinner, IonTitle, IonToolbar, ModalController, NavController,
  ToastController, ViewDidEnter, ViewWillLeave,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  alertCircle, arrowRedo, arrowRedoOutline, arrowUndoOutline, business, businessOutline, checkmarkCircle, chevronBack,
  chevronForward, closeCircleOutline, createOutline, ellipsisHorizontal, flagOutline, hourglassOutline, lockClosedOutline,
  qrCodeOutline, scanOutline, searchOutline, shareOutline, swapHorizontalOutline, trendingDownOutline, trophy,
} from 'ionicons/icons';
import QRCode from 'qrcode';
import { GameService, errorText } from '../game.service';
import {
  BankError, CURRENCIES, GoRequest, Kind, MAX_PLAYERS, MIN_PLAYERS, Player, Txn, buzz, cleanCode, currencyOf, deltaFor, fmt, joinUrl,
  keepAwake, parseQr, prefs, signed, txnText, undoable,
} from '../money';
import { Avatar } from '../ui/avatar';
import { MoneyModal, Party, Payer } from '../ui/money-modal';
import { RequestModal } from '../ui/request-modal';
import { ScanModal } from '../ui/scan-modal';

type MoneyField = 'startingCash' | 'salary' | 'debtLimit';

@Component({
  selector: 'app-game',
  templateUrl: 'game.page.html',
  styleUrls: ['game.page.scss'],
  imports: [
    IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent, IonFooter, IonSegment, IonSegmentButton, IonLabel,
    IonSpinner, IonInput, DatePipe, NgTemplateOutlet, RouterLink, Avatar,
  ],
})
export class GamePage implements ViewDidEnter, ViewWillLeave {
  /** Route param /game/:code */
  readonly code = input.required<string>();
  /** Query param ?pay=REQUEST_ID from a payment QR opened with the phone camera. */
  readonly pay = input<string>();

  protected readonly bank = inject(GameService);
  private readonly router = inject(Router);
  private readonly nav = inject(NavController);
  private readonly modals = inject(ModalController);
  private readonly sheets = inject(ActionSheetController);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);

  protected readonly fmt = fmt;
  protected readonly signed = signed;
  protected readonly maxPlayers = MAX_PLAYERS;
  protected readonly minPlayers = MIN_PLAYERS;
  protected readonly currencies = CURRENCIES;
  /** What the banker is typing in the lobby, before it's saved (on leaving the field, or on Start). */
  protected readonly draft = signal<Partial<Record<MoneyField, number>>>({});
  protected readonly money = computed(() => {
    const g = this.bank.game();
    const d = this.draft();
    return {
      startingCash: d.startingCash ?? g?.startingCash ?? 0,
      salary: d.salary ?? g?.salary ?? 0,
      debtLimit: d.debtLimit ?? g?.debtLimit ?? 0,
    };
  });
  protected readonly moneyError = computed(() => {
    const m = this.money();
    const bad = (n: number, min: number) => !Number.isFinite(n) || n < min || n > 10_000_000;
    if (bad(m.startingCash, 1)) return `Starting cash must be from ${fmt(1)} to ${fmt(10_000_000)}`;
    if (bad(m.salary, 0)) return `GO salary must be from ${fmt(0)} to ${fmt(10_000_000)}`;
    if (bad(m.debtLimit, 0)) return `Debt limit must be from ${fmt(0)} (no debt) to ${fmt(10_000_000)}`;
    return '';
  });
  protected readonly debtLimit = computed(() => this.bank.game()?.debtLimit ?? 0);
  private readonly icons: Record<Kind, string> = {
    start: 'flag-outline', pay: 'swap-horizontal-outline', salary: 'arrow-redo-outline', 'bank-in': 'business-outline',
    'bank-out': 'business-outline', adjust: 'create-outline', undo: 'arrow-undo-outline', bankrupt: 'trending-down-outline',
  };

  protected readonly view = computed(() => {
    const g = this.bank.game();
    if (g === null) return 'missing';
    if (g === undefined || !this.bank.synced()) return 'loading';
    if (!this.bank.isMember()) return 'outsider';
    // Last player standing wins straight away, without waiting for the banker to press End game.
    if (g.status === 'active' && this.lastStanding()) return 'ended';
    return g.status;
  });
  protected readonly tab = signal<'wallet' | 'bank'>('wallet');
  protected readonly bothTabs = computed(() => this.bank.isBanker() && !!this.bank.me());
  protected readonly activeTab = computed(() => (!this.bank.me() ? 'bank' : this.bothTabs() ? this.tab() : 'wallet'));
  protected readonly others = computed(() => this.bank.players().filter(p => p.id !== this.bank.uid()));
  protected readonly solvent = computed(() => this.bank.players().filter(p => !p.bankrupt));
  protected readonly inPlay = computed(() => this.bank.players().reduce((sum, p) => sum + p.balance, 0));
  protected readonly lastStanding = computed(() =>
    this.bank.players().length >= MIN_PLAYERS && this.solvent().length === 1 ? this.solvent()[0] : null);
  protected readonly winner = computed(() => this.bank.ranked().find(p => !p.bankrupt) ?? null);
  protected readonly joinQr = signal('');
  /** "Collected!" flash after the banker's own GO. */
  protected readonly goCooldown = signal(false);
  protected readonly goBusy = signal(false);
  /** My GO request while it waits for the banker. */
  protected readonly myGo = computed(() => this.bank.goRequests().find(r => r.to === this.bank.uid()) ?? null);
  protected readonly busy = signal(false);

  /** Balance shown on the card, counted up/down towards the real one. */
  protected readonly shown = signal(0);
  protected readonly flash = signal<{ n: number; key: number } | null>(null);
  private animated = false;
  private raf = 0;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private lastToast?: HTMLIonToastElement;
  private handledPay = '';
  private ending = false;
  private goPopup: { id: string; alert?: HTMLIonAlertElement } | null = null;
  private watchedGo?: { id: string; unsub: () => void };
  private stopAwake?: () => void;

  constructor() {
    addIcons({
      alertCircle, arrowRedo, arrowRedoOutline, arrowUndoOutline, business, businessOutline, checkmarkCircle, chevronBack,
      chevronForward, closeCircleOutline, createOutline, ellipsisHorizontal, flagOutline, hourglassOutline, lockClosedOutline,
      qrCodeOutline, scanOutline, searchOutline, shareOutline, swapHorizontalOutline, trendingDownOutline, trophy,
    });

    effect(() => {
      const code = cleanCode(this.code());
      untracked(() => void this.bank.watch(code));
    });
    effect(() => {
      if (this.view() === 'lobby' || this.view() === 'active') prefs.set('game', this.bank.code());
    });
    effect(() => {
      const g = this.bank.game();
      if (g?.status === 'lobby' && this.bank.isBanker()) untracked(() => void this.makeJoinQr(g.code));
    });
    effect(() => {
      // The banker's phone records the finish, which freezes all money in the database rules.
      if (this.bank.isBanker() && this.bank.game()?.status === 'active' && this.lastStanding() && !this.ending) {
        this.ending = true;
        untracked(() => void this.bank.end().catch(() => (this.ending = false)));
      }
    });
    effect(() => {
      // Banker: each GO request pops up for a decision, one at a time.
      this.bank.goRequests();
      this.view();
      untracked(() => void this.nextGoPopup());
    });
    effect(() => {
      // Player: tell them if the banker says no (a yes arrives as an incoming-money toast).
      const id = this.myGo()?.id;
      untracked(() => {
        if (!id || this.watchedGo?.id === id) return;
        this.watchedGo?.unsub();
        const unsub = this.bank.watchRequest(id, r => {
          if (r.status === 'open') return;
          if (r.status === 'declined') void this.toast(`${this.bank.game()?.bankerName ?? 'The banker'} declined your GO salary`, 'danger');
          unsub();
          this.watchedGo = undefined;
        });
        this.watchedGo = { id, unsub };
      });
    });
    effect(() => {
      const t = this.bank.incoming();
      if (t) untracked(() => void this.notify(t));
    });
    effect(() => {
      const balance = this.bank.me()?.balance;
      if (balance !== undefined) untracked(() => this.animateTo(balance));
    });
    effect(() => {
      const req = this.pay();
      if (req && req !== this.handledPay && this.view() === 'active' && this.bank.me()) {
        this.handledPay = req;
        untracked(() => {
          void this.router.navigate([], { queryParams: {}, replaceUrl: true });
          void this.openPay(req);
        });
      }
    });
  }

  // ---- display helpers ---------------------------------------------------------------------

  protected text(t: Txn) {
    return txnText(t, id => this.bank.name(id), this.bank.uid());
  }

  protected icon(t: Txn) {
    return this.icons[t.kind];
  }

  protected delta(t: Txn) {
    return deltaFor(t, this.bank.uid());
  }

  protected canUndo(t: Txn) {
    return this.bank.isBanker() && this.view() === 'active' && undoable(t);
  }

  protected spaced(code: string) {
    return code.split('').join(' ');
  }

  private animateTo(target: number) {
    const from = this.shown();
    if (!this.animated) {
      this.animated = true;
      this.shown.set(target);
      return;
    }
    if (from === target) return;
    this.flash.set({ n: target - from, key: Date.now() });
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flash.set(null), 1800);
    cancelAnimationFrame(this.raf);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return this.shown.set(target);
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 650);
      this.shown.set(Math.round(from + (target - from) * (1 - (1 - k) ** 3)));
      if (k < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private async makeJoinQr(code: string) {
    if (this.joinQr()) return;
    this.joinQr.set(await QRCode.toDataURL(joinUrl(code), {
      margin: 1, width: 640, errorCorrectionLevel: 'M', color: { dark: '#0b1220', light: '#ffffff' },
    }));
  }

  private async toast(message: string, color: 'primary' | 'danger' | 'dark' = 'dark', icon?: string) {
    await this.lastToast?.dismiss().catch(() => undefined);
    this.lastToast = await this.toasts.create({ message, color, icon, duration: 3200, position: 'top', swipeGesture: 'vertical' });
    await this.lastToast.present();
  }

  private async notify(t: Txn) {
    const d = this.delta(t);
    buzz(d >= 0 ? [15, 60, 25] : 30);
    await this.toast(`${d ? `${signed(d)} · ` : ''}${this.text(t)}`, d >= 0 ? 'primary' : 'danger');
  }

  private async confirm(header: string, message: string, ok: string, destructive = false, cancel = 'Cancel'): Promise<boolean> {
    const a = await this.alerts.create({
      header, message,
      buttons: [{ text: cancel, role: 'cancel' }, { text: ok, role: destructive ? 'destructive' : 'confirm' }],
    });
    await a.present();
    const { role } = await a.onDidDismiss();
    return role === 'destructive' || role === 'confirm';
  }

  private async choose<T>(header: string, options: { text: string; value: T; destructive?: boolean }[], subHeader?: string) {
    const buttons: ActionSheetButton[] = options.map(o => ({
      text: o.text, role: o.destructive ? 'destructive' : undefined, data: { value: o.value },
    }));
    const sheet = await this.sheets.create({ header, subHeader, buttons: [...buttons, { text: 'Cancel', role: 'cancel' }] });
    await sheet.present();
    const { data } = await sheet.onDidDismiss<{ value: T }>();
    return data?.value;
  }

  private async moneyModal(props: {
    title: string; party?: Party; partyLabel?: string; fixed?: number; initial?: number; allowZero?: boolean;
    payer?: Payer; debtLimit?: number; hint?: string; cta: (n: number) => string; run: (n: number) => Promise<unknown>; doneText: string;
    color?: 'primary' | 'secondary' | 'danger';
  }) {
    const m = await this.modals.create({ component: MoneyModal, componentProps: props });
    await m.present();
    await m.onDidDismiss();
  }

  private payerProps() {
    const balance = this.bank.me()?.balance ?? 0;
    return { payer: { name: null, balance }, debtLimit: this.debtLimit() };
  }

  // ---- navigation & menu -------------------------------------------------------------------

  // The screen stays on for the whole game: phones sit on the table between turns.
  ionViewDidEnter() {
    this.stopAwake = keepAwake();
  }

  ionViewWillLeave() {
    this.stopAwake?.();
  }

  protected home(forget = false) {
    if (forget) prefs.set('game', null);
    void this.nav.navigateRoot('/', { animationDirection: 'back' });
  }

  protected async menu() {
    const g = this.bank.game();
    const me = this.bank.me();
    if (!g) return;
    type Action = 'help' | 'share' | 'bankrupt' | 'leave' | 'end' | 'home';
    const options: { text: string; value: Action; destructive?: boolean }[] = [{ text: 'How it works', value: 'help' }];
    if (g.status === 'lobby' && this.bank.isBanker()) options.push({ text: 'Share invite link', value: 'share' });
    if (g.status === 'active' && me && !me.bankrupt) options.push({ text: 'Declare bankruptcy', value: 'bankrupt', destructive: true });
    if (g.status === 'lobby' && me && !this.bank.isBanker()) options.push({ text: 'Leave game', value: 'leave', destructive: true });
    if (g.status !== 'ended' && this.bank.isBanker()) {
      options.push({ text: g.status === 'lobby' ? 'Cancel game' : 'End game', value: 'end', destructive: true });
    }
    options.push({ text: 'Back to home', value: 'home' });
    switch (await this.choose(`Game ${g.code}`, options)) {
      case 'help': return this.help();
      case 'share': return this.share();
      case 'bankrupt': return me && this.declareBankrupt(me);
      case 'leave': return this.leave();
      case 'end': return this.endGame();
      case 'home': return this.home();
    }
  }

  private async help() {
    const a = await this.alerts.create({
      header: 'How it works',
      cssClass: 'help-alert',
      message:
        '• Get paid: tap Get paid, enter the amount and show the QR code.\n' +
        '• Pay: tap Pay and scan the other player’s QR code, or tap their name to pay them directly.\n' +
        `• Pass GO: tap it and the banker approves your ${fmt(this.bank.game()?.salary ?? 0)} salary.\n` +
        '• Pay bank: for property, houses, taxes and fees.\n' +
        `• Short on cash? ${this.debtLimit() ? `You can go into debt down to −${fmt(this.debtLimit())}; paying past that makes you bankrupt.` : 'Paying more than you have makes you bankrupt.'}\n` +
        '• The banker pays out from the bank (card payouts, mortgages, bonuses) and can reverse mistakes.',
      buttons: ['Got it'],
    });
    await a.present();
  }

  protected async share() {
    const code = this.bank.code()!;
    const url = joinUrl(code);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my board game', text: `Join my Board Banker game. Code: ${code}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        await this.toast('Invite link copied', 'primary', 'checkmark-circle');
      }
    } catch {
      // The share sheet was closed.
    }
  }

  // ---- lobby -------------------------------------------------------------------------------

  protected typing(field: MoneyField, raw: unknown) {
    const n = raw === '' || raw == null ? NaN : Math.round(Number(raw));
    this.draft.update(d => ({ ...d, [field]: n }));
  }

  /** Saves a field when the banker leaves it, so players in the lobby see the house rules. */
  protected async setMoney(field: MoneyField, raw: unknown) {
    this.typing(field, raw);
    const g = this.bank.game()!;
    const n = this.money()[field];
    const min = field === 'startingCash' ? 1 : 0;
    if (!Number.isFinite(n) || n < min || n > 10_000_000 || (g[field] ?? 0) === n) return; // the footer explains bad input
    const next = { startingCash: g.startingCash, salary: g.salary, debtLimit: g.debtLimit ?? 0, [field]: n };
    await this.saveMoney(next.startingCash, next.salary, g.currency, next.debtLimit);
  }

  /** Switching currency also switches untouched default amounts (e.g. $200 salary becomes RM2,000). */
  protected async setCurrency(symbol: unknown) {
    const g = this.bank.game()!;
    const prev = currencyOf(g.currency);
    const next = currencyOf(String(symbol));
    if (next.symbol === prev.symbol) return;
    const untouched = g.startingCash === prev.start && g.salary === prev.salary;
    this.draft.set({});
    await this.saveMoney(untouched ? next.start : g.startingCash, untouched ? next.salary : g.salary, next.symbol, g.debtLimit ?? 0);
  }

  private async saveMoney(startingCash: number, salary: number, currency: string, debtLimit: number) {
    try {
      await this.bank.setMoney(startingCash, salary, currency, debtLimit);
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }

  protected async remove(p: Player) {
    if (!(await this.confirm(`Remove ${p.name}?`, 'They can join again with the code.', 'Remove', true))) return;
    try {
      await this.bank.leave(p.id);
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }

  protected async leave() {
    if (!(await this.confirm('Leave this game?', 'You can join again with the code before the game starts.', 'Leave', true))) return;
    try {
      await this.bank.leave();
      this.home(true);
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }

  protected async start() {
    if (this.bank.players().length < MIN_PLAYERS || this.moneyError() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.bank.start(this.money()); // saves what's typed in the same write, so it can't start with stale amounts
      buzz([15, 60, 25]);
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  private async endGame() {
    const lobby = this.bank.game()?.status === 'lobby';
    const ok = await this.confirm(
      lobby ? 'Cancel this game?' : 'End the game?',
      lobby ? 'Everyone in the lobby will see that the game was cancelled.' : 'Everyone will see the final standings. This can’t be undone.',
      lobby ? 'Cancel game' : 'End game', true);
    if (!ok) return;
    try {
      await this.bank.end();
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }

  // ---- player actions ----------------------------------------------------------------------

  protected async passGo() {
    const g = this.bank.game()!;
    const banker = this.bank.isBanker();
    const ok = await this.confirm(
      'Passed GO?',
      banker ? `Collect your ${fmt(g.salary)} salary from the bank.` : `Ask ${g.bankerName} for your ${fmt(g.salary)} salary.`,
      banker ? 'Collect' : 'Ask banker');
    if (!ok || this.goBusy()) return;
    this.goBusy.set(true);
    try {
      await this.bank.passGo();
      buzz(banker ? [15, 60, 25] : 15);
      if (banker) {
        this.goCooldown.set(true);
        setTimeout(() => this.goCooldown.set(false), 3000);
      }
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    } finally {
      this.goBusy.set(false);
    }
  }

  protected async cancelGo(r: GoRequest) {
    const ok = await this.confirm('Cancel your GO request?', `${this.bank.game()?.bankerName} hasn’t approved it yet.`, 'Cancel request', true, 'Keep waiting');
    if (ok) await this.bank.cancelRequest(r.id);
  }

  /** Shows the oldest waiting GO request to the banker; closes the pop-up if it's withdrawn meanwhile. */
  private async nextGoPopup() {
    const pending = this.bank.isBanker() && this.view() === 'active' ? this.bank.goRequests() : [];
    if (this.goPopup) {
      if (!pending.some(r => r.id === this.goPopup!.id)) void this.goPopup.alert?.dismiss(null, 'gone');
      return;
    }
    const r = pending[0];
    if (!r) return;
    const popup: { id: string; alert?: HTMLIonAlertElement } = { id: r.id };
    this.goPopup = popup;
    const who = this.bank.name(r.to);
    buzz([20, 60, 20]);
    popup.alert = await this.alerts.create({
      header: `${who} passed GO`,
      message: `Pay ${who} their ${fmt(r.amount)} salary from the bank?`,
      cssClass: 'go-alert',
      backdropDismiss: false,
      buttons: [
        { text: 'Decline', role: 'decline', cssClass: 'alert-decline' },
        { text: 'Approve', role: 'approve', cssClass: 'alert-approve' },
      ],
    });
    await popup.alert.present();
    if (!this.bank.goRequests().some(x => x.id === r.id)) void popup.alert.dismiss(null, 'gone');
    const { role } = await popup.alert.onDidDismiss();
    this.goPopup = null;
    try {
      if (role === 'approve') {
        await this.bank.approveGo(r);
        await this.toast(`Paid ${who} ${fmt(r.amount)} for passing GO`, 'primary', 'checkmark-circle');
      }
      if (role === 'decline') await this.bank.declineGo(r);
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
    void this.nextGoPopup();
  }

  protected async request() {
    const m = await this.modals.create({ component: RequestModal });
    await m.present();
  }

  protected async payScan() {
    const m = await this.modals.create({
      component: ScanModal,
      componentProps: { title: 'Pay', hint: 'Scan the QR code on their screen', alt: 'Choose a player instead' },
    });
    await m.present();
    const { data, role } = await m.onDidDismiss<string>();
    if (role === 'alt') return this.choosePlayer();
    if (role !== 'scan') return;
    const qr = parseQr(data ?? '');
    if (!qr) return this.toast('That isn’t a Board Banker code.', 'danger');
    if (qr.code !== this.bank.code()) return this.toast('That code is from a different game.', 'danger');
    if (!qr.req) return this.toast('That’s the join code. Ask them to tap Get paid and show their payment QR.', 'danger');
    await this.openPay(qr.req);
  }

  private async openPay(reqId: string) {
    try {
      const r = await this.bank.getRequest(reqId);
      if (r.status === 'paid') throw new BankError('This QR code has already been paid.');
      if (r.status === 'cancelled') throw new BankError('This QR code was cancelled. Ask them to show a new one.');
      if (r.to === this.bank.uid()) throw new BankError('That’s your own QR code. The other player needs to scan it.');
      const to = this.bank.players().find(p => p.id === r.to);
      if (!to) throw new BankError('That player isn’t in this game.');
      await this.moneyModal({
        title: 'Confirm payment', party: { name: to.name, color: to.color }, partyLabel: 'Pay', fixed: r.amount,
        ...this.payerProps(), cta: n => `Pay ${fmt(n)}`, run: () => this.bank.payRequest(reqId, r), doneText: `Paid ${to.name}`,
      });
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }

  private async choosePlayer() {
    const options = this.others().filter(p => !p.bankrupt).map(p => ({ text: p.name, value: p }));
    if (!options.length) return this.toast('There’s nobody else to pay.', 'dark');
    const p = await this.choose('Who are you paying?', options);
    if (p) await this.sendTo(p);
  }

  protected async sendTo(p: Player) {
    await this.moneyModal({
      title: 'Pay a player', party: { name: p.name, color: p.color }, partyLabel: 'To', ...this.payerProps(),
      cta: n => (n ? `Pay ${fmt(n)} to ${p.name}` : 'Enter an amount'), run: n => this.bank.pay(p.id, n), doneText: `Paid ${p.name}`,
    });
  }

  protected async payBank() {
    await this.moneyModal({
      title: 'Pay the bank', party: { name: 'the bank', color: null }, partyLabel: 'To', ...this.payerProps(),
      cta: n => (n ? `Pay ${fmt(n)} to the bank` : 'Enter an amount'), run: n => this.bank.payBank(n), doneText: 'Paid the bank',
    });
  }

  protected async declareBankrupt(p: Player) {
    const self = p.id === this.bank.uid();
    const creditors = [
      { text: 'The bank', value: null as string | null },
      ...this.bank.players().filter(o => o.id !== p.id && !o.bankrupt).map(o => ({ text: o.name, value: o.id as string | null })),
    ];
    const creditor = await this.choose(
      self ? 'Who do you owe?' : `Who does ${p.name} owe?`, creditors,
      `${self ? 'Your' : `${p.name}’s`} remaining ${fmt(p.balance)} goes to them.`);
    if (creditor === undefined) return;
    const to = creditor ? this.bank.name(creditor) : 'the bank';
    const ok = await this.confirm(
      self ? 'Declare bankruptcy?' : `Declare ${p.name} bankrupt?`,
      `${self ? 'Your' : `${p.name}’s`} ${fmt(p.balance)} goes to ${to} and ${self ? 'you’re' : 'they’re'} out of the game. This can’t be undone.`,
      'Declare bankrupt', true);
    if (!ok) return;
    try {
      await this.bank.bankrupt(p.id, creditor);
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }

  // ---- banker actions ----------------------------------------------------------------------

  protected async manage(p: Player) {
    type Action = 'give' | 'take' | 'correct' | 'bankrupt';
    const action = await this.choose<Action>(`${p.name} · ${fmt(p.balance)}`, [
      { text: 'Pay from the bank', value: 'give' },
      { text: 'Collect for the bank', value: 'take' },
      { text: 'Correct balance', value: 'correct' },
      { text: 'Declare bankrupt', value: 'bankrupt', destructive: true },
    ]);
    const party = { name: p.name, color: p.color };
    switch (action) {
      case 'give':
        return this.moneyModal({
          title: 'Bank pays', party, partyLabel: 'To', hint: 'Card payouts, mortgages, bonuses…', color: 'secondary',
          cta: n => (n ? `Pay ${fmt(n)} to ${p.name}` : 'Enter an amount'), run: n => this.bank.bankPays(p.id, n),
          doneText: `Paid ${p.name}`,
        });
      case 'take':
        return this.moneyModal({
          title: 'Bank collects', party, partyLabel: 'From', payer: { name: p.name, balance: p.balance }, debtLimit: this.debtLimit(),
          cta: n => (n ? `Collect ${fmt(n)}` : 'Enter an amount'),
          run: n => this.bank.bankCollects(p.id, n), doneText: `Collected from ${p.name}`,
        });
      case 'correct':
        return this.moneyModal({
          title: 'Correct balance', party, partyLabel: 'Set', initial: p.balance, allowZero: true,
          hint: `Currently ${fmt(p.balance)}. Enter the right amount.`, cta: n => `Set balance to ${fmt(n)}`,
          run: n => this.bank.correct(p.id, n), doneText: `${p.name}’s balance updated`,
        });
      case 'bankrupt':
        return this.declareBankrupt(p);
    }
  }

  protected async undo(t: Txn) {
    if (!this.canUndo(t)) return;
    const back = t.from ? this.bank.name(t.from) : 'the bank';
    const from = t.to ? this.bank.name(t.to) : 'The bank';
    if (!(await this.confirm('Reverse this?', `${this.text(t)} (${fmt(t.amount)}). ${from} gives ${fmt(t.amount)} back to ${back}.`, 'Reverse'))) return;
    try {
      await this.bank.undo(t);
      await this.toast('Transaction reversed', 'primary', 'checkmark-circle');
    } catch (e) {
      await this.toast(errorText(e), 'danger');
    }
  }
}
