import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import {
  AlertController, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonSpinner, IonTitle, IonToolbar,
  ModalController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircle, business, checkmark } from 'ionicons/icons';
import { errorText } from '../game.service';
import { buzz, fmt } from '../money';
import { AmountPad } from './amount-pad';
import { Avatar } from './avatar';

/** Who the money goes to or comes from; color null means the bank. */
export interface Party { name: string; color: number | null }

/** Whose cash a payment spends; name null means "you". */
export interface Payer { name: string | null; balance: number }

/**
 * One sheet for every money move: type an amount (or confirm a fixed one), run it, show a tick.
 * When a player pays, it shows what they'll have left, the debt they'll owe, or that the payment
 * bankrupts them (past the banker's debt limit), and asks before bankrupting anyone.
 */
@Component({
  selector: 'app-money-modal',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonFooter, IonIcon, IonSpinner, AmountPad, Avatar],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>{{ title() }}</ion-title>
        @if (!done()) {
          <ion-buttons slot="end">
            <ion-button (click)="close()" [disabled]="busy()">Cancel</ion-button>
          </ion-buttons>
        }
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="wrap">
        @if (done()) {
          <div class="done" role="status">
            <div class="done-check"><ion-icon name="checkmark" aria-hidden="true" /></div>
            <h2>{{ doneText() }}</h2>
            <p class="done-amt">{{ fmt(amount()) }}</p>
            @if (wentBust()) { <p class="pad-hint err">{{ payer()?.name ?? 'You' }} went bankrupt</p> }
          </div>
        } @else {
          @if (party(); as p) {
            <div class="party">
              @if (p.color === null) {
                <span class="avatar sm bank" aria-hidden="true"><ion-icon name="business" /></span>
              } @else {
                <app-avatar [name]="p.name" [color]="p.color" size="sm" />
              }
              <span class="party-name">{{ partyLabel() }} {{ p.name }}</span>
            </div>
          }
          @if (fixed() !== null) {
            <div class="pad-display">
              <span class="pad-amount" [class.long]="fmt(amount()).length > 9">{{ fmt(amount()) }}</span>
              <span class="pad-hint" [class.err]="status().tone === 'err'" [class.warn]="status().tone === 'warn'">{{ status().text }}</span>
            </div>
          } @else {
            <app-amount-pad [(value)]="amount" [hint]="status().text" [tone]="status().tone" (enter)="go()" />
          }
          @if (error()) {
            <p class="form-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true" />{{ error() }}</p>
          }
        }
      </div>
    </ion-content>

    @if (!done()) {
      <ion-footer class="ion-no-border">
        <div class="footer-bar">
          <ion-button expand="block" size="large" [color]="bust() ? 'danger' : color()" (click)="go()" [disabled]="busy() || !valid()">
            @if (busy()) {
              <ion-spinner name="crescent" aria-label="Working" />
            } @else {
              {{ ctaText() }}
            }
          </ion-button>
        </div>
      </ion-footer>
    }
  `,
})
export class MoneyModal {
  readonly title = input.required<string>();
  readonly party = input<Party | null>(null);
  readonly partyLabel = input('To');
  /** Set for a confirm-only sheet (paying a scanned QR). */
  readonly fixed = input<number | null>(null);
  readonly initial = input(0);
  readonly allowZero = input(false);
  /** The player whose cash this spends; null when the bank pays. */
  readonly payer = input<Payer | null>(null);
  readonly debtLimit = input(0);
  /** Shown instead of the balance line when no player pays. */
  readonly hint = input('');
  readonly cta = input.required<(n: number) => string>();
  readonly run = input.required<(n: number) => Promise<unknown>>();
  readonly doneText = input('Done');
  readonly color = input<'primary' | 'secondary' | 'danger'>('primary');

  private readonly modalCtrl = inject(ModalController);
  private readonly alerts = inject(AlertController);
  protected readonly fmt = fmt;
  protected readonly amount = linkedSignal(() => this.fixed() ?? this.initial());
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected readonly wentBust = signal(false);
  protected readonly error = signal('');
  protected readonly valid = computed(() => this.allowZero() || this.amount() > 0);

  private readonly after = computed(() => (this.payer()?.balance ?? 0) - this.amount());
  /** Past the debt limit: paying in full makes the payer bankrupt. */
  protected readonly bust = computed(() => !!this.payer() && this.amount() > 0 && this.after() < -this.debtLimit());

  protected readonly status = computed((): { text: string; tone: '' | 'warn' | 'err' } => {
    const p = this.payer();
    if (!p) return { text: this.hint(), tone: '' };
    const you = p.name === null;
    const limit = this.debtLimit();
    if (this.bust()) {
      const who = you ? 'you' : p.name;
      return {
        text: limit ? `Past the ${fmt(limit)} debt limit: this makes ${who} bankrupt` : `More than ${you ? 'you have' : `${p.name} has`}: this makes ${who} bankrupt`,
        tone: 'err',
      };
    }
    if (this.after() < 0) return { text: `${you ? 'You’ll owe' : `${p.name} will owe`} ${fmt(-this.after())} · limit ${fmt(limit)}`, tone: 'warn' };
    return { text: `${you ? 'You have' : `${p.name} has`} ${fmt(p.balance)}`, tone: '' };
  });

  protected readonly ctaText = computed(() => {
    const text = this.cta()(this.amount());
    if (!this.bust()) return text;
    const name = this.payer()!.name;
    return name === null ? `${text} and go bankrupt` : `${text} · ${name} goes bankrupt`;
  });

  constructor() {
    addIcons({ alertCircle, business, checkmark });
  }

  protected async go() {
    if (!this.valid() || this.busy()) return;
    const bust = this.bust();
    if (bust && !(await this.confirmBust())) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.run()(this.amount());
      this.wentBust.set(bust);
      this.done.set(true);
      buzz([15, 60, 25]);
      setTimeout(() => this.modalCtrl.dismiss(true, 'done'), bust ? 1800 : 1100);
    } catch (e) {
      this.error.set(errorText(e));
      buzz([30, 50, 30]);
    } finally {
      this.busy.set(false);
    }
  }

  private async confirmBust(): Promise<boolean> {
    const name = this.payer()!.name;
    const to = this.party()?.name ?? 'They';
    const a = await this.alerts.create({
      header: name === null ? 'Go bankrupt?' : `Make ${name} bankrupt?`,
      message: `${to[0].toUpperCase()}${to.slice(1)} still gets the full ${fmt(this.amount())}, and ${name === null ? 'you’re' : `${name} is`} out of the game. This can’t be undone.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: name === null ? 'Pay and go bankrupt' : 'Collect anyway', role: 'destructive' }],
    });
    await a.present();
    return (await a.onDidDismiss()).role === 'destructive';
  }

  protected close() {
    this.modalCtrl.dismiss(null, 'cancel');
  }
}
