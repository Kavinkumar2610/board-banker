import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonSpinner, IonTitle, IonToolbar,
  ModalController, NavController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircle, business, scanOutline } from 'ionicons/icons';
import { GameService, errorText } from '../game.service';
import { BankError, Game, MAX_PLAYERS, Player, cleanCode, isCode, parseQr, prefs } from '../money';
import { Avatar } from '../ui/avatar';
import { ScanModal } from '../ui/scan-modal';

type Lookup =
  | { state: 'idle' | 'loading' }
  | { state: 'found'; game: Game; players: Player[] }
  | { state: 'error'; error: string };

@Component({
  selector: 'app-join',
  templateUrl: 'join.page.html',
  styleUrls: ['join.page.scss'],
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonInput, IonFooter, IonButton, IonSpinner, IonIcon, Avatar],
})
export class JoinPage {
  /** From /join/:code */
  readonly code = input<string>();

  private readonly bank = inject(GameService);
  private readonly nav = inject(NavController);
  private readonly modals = inject(ModalController);

  protected readonly max = MAX_PLAYERS;
  protected readonly entered = linkedSignal(() => cleanCode(this.code() ?? ''));
  protected readonly name = signal(prefs.get('name') ?? '');
  protected readonly lookup = signal<Lookup>({ state: 'idle' });
  protected readonly tried = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly nameError = computed(() => {
    const n = this.name().trim().toLowerCase();
    const l = this.lookup();
    if (!n) return 'Enter your name to join';
    if (l.state === 'found' && l.players.some(p => p.name.toLowerCase() === n)) return 'Someone in this game already has that name';
    return '';
  });

  constructor() {
    addIcons({ alertCircle, business, scanOutline });
    effect(() => {
      const code = this.entered();
      untracked(() => this.check(code));
    });
  }

  protected onCode(value: string | null | undefined) {
    this.entered.set(cleanCode(value ?? ''));
  }

  private async check(code: string) {
    this.error.set('');
    if (!isCode(code)) {
      this.lookup.set(code.length === 6 ? { state: 'error', error: 'That code doesn’t look right. Codes use letters and the digits 2–9.' } : { state: 'idle' });
      return;
    }
    this.lookup.set({ state: 'loading' });
    try {
      const { game, players, member } = await this.bank.preview(code);
      if (this.entered() !== code) return;
      if (member) {
        prefs.set('game', code);
        await this.nav.navigateRoot(`/game/${code}`);
        return;
      }
      if (game.status === 'ended') throw new BankError('This game has ended. Ask the banker to start a new one.');
      if (game.status === 'active') throw new BankError('This game has already started, so new players can’t join. Ask the banker to start a new one.');
      if (players.length >= MAX_PLAYERS) throw new BankError(`This game is full (${MAX_PLAYERS} players).`);
      this.lookup.set({ state: 'found', game, players });
    } catch (e) {
      if (this.entered() === code) this.lookup.set({ state: 'error', error: errorText(e) });
    }
  }

  protected async scan() {
    const m = await this.modals.create({
      component: ScanModal,
      componentProps: { title: 'Join a game', hint: 'Scan the QR code on the banker’s phone' },
    });
    await m.present();
    const { data, role } = await m.onDidDismiss<string>();
    if (role !== 'scan') return;
    const qr = parseQr(data ?? '');
    if (!qr) {
      this.lookup.set({ state: 'error', error: 'That isn’t a Board Banker code. Scan the QR on the banker’s screen.' });
      return;
    }
    if (qr.req) {
      await this.nav.navigateRoot(`/game/${qr.code}`, { queryParams: { pay: qr.req } });
      return;
    }
    this.entered.set(qr.code);
  }

  protected async join() {
    this.tried.set(true);
    const l = this.lookup();
    if (l.state !== 'found' || this.nameError() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const name = this.name().trim();
      await this.bank.join(l.game.code, name);
      prefs.set('name', name);
      prefs.set('game', l.game.code);
      await this.nav.navigateRoot(`/game/${l.game.code}`);
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
