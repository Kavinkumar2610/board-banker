import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import {
  IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonSpinner, IonTitle, IonToolbar, ModalController,
} from '@ionic/angular';
import { Unsubscribe } from 'firebase/firestore';
import { addIcons } from 'ionicons';
import { alertCircle, checkmark } from 'ionicons/icons';
import QRCode from 'qrcode';
import { GameService, errorText } from '../game.service';
import { buzz, fmt, payUrl } from '../money';
import { AmountPad } from './amount-pad';

/** "Get paid": key in the amount, show a single-use QR, close itself once the payer has paid. */
@Component({
  selector: 'app-request-modal',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonFooter, IonIcon, IonSpinner, AmountPad],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        @if (step() === 'qr') {
          <ion-buttons slot="start"><ion-button (click)="edit()">Change</ion-button></ion-buttons>
        }
        <ion-title>Get paid</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="close()">{{ step() === 'paid' ? 'Done' : 'Cancel' }}</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="wrap">
        @switch (step()) {
          @case ('amount') {
            <p class="lede ion-text-center">How much are they paying you?</p>
            <app-amount-pad [(value)]="amount" (enter)="show()" />
            @if (error()) {
              <p class="form-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true" />{{ error() }}</p>
            }
          }
          @case ('qr') {
            <div class="req">
              <p class="req-label">Scan to pay {{ myName() }}</p>
              <p class="req-amt">{{ fmt(amount()) }}</p>
              <div class="qr-frame"><img [src]="qr()" [alt]="'Payment code for ' + fmt(amount())" /></div>
              <p class="req-wait" role="status"><ion-spinner name="dots" aria-hidden="true" />Waiting for payment</p>
              <p class="hint ion-text-center">The other player taps <strong>Pay</strong> and scans this code.</p>
            </div>
          }
          @case ('paid') {
            <div class="done" role="status">
              <div class="done-check"><ion-icon name="checkmark" aria-hidden="true" /></div>
              <h2>{{ payer() }} paid you</h2>
              <p class="done-amt pos">+{{ fmt(amount()) }}</p>
            </div>
          }
        }
      </div>
    </ion-content>

    @if (step() === 'amount') {
      <ion-footer class="ion-no-border">
        <div class="footer-bar">
          <ion-button expand="block" size="large" (click)="show()" [disabled]="!amount() || busy()">
            @if (busy()) {
              <ion-spinner name="crescent" aria-label="Working" />
            } @else {
              Show QR for {{ fmt(amount()) }}
            }
          </ion-button>
        </div>
      </ion-footer>
    }
  `,
  styles: `
    .req { display: flex; flex-direction: column; align-items: center; text-align: center; padding-top: 4px; }
    .req-label { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mb-muted); }
    .req-amt { margin: 2px 0 18px; font-size: 48px; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .req-wait { display: flex; align-items: center; gap: 8px; margin: 22px 0 0; font-weight: 600; color: var(--mb-gold); }
    .req-wait ion-spinner { --color: var(--mb-gold); width: 22px; }
  `,
})
export class RequestModal implements OnDestroy {
  private readonly bank = inject(GameService);
  private readonly modalCtrl = inject(ModalController);

  protected readonly fmt = fmt;
  protected readonly step = signal<'amount' | 'qr' | 'paid'>('amount');
  protected readonly amount = signal(0);
  protected readonly qr = signal('');
  protected readonly payer = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly myName = computed(() => this.bank.me()?.name ?? 'me');

  private reqId?: string;
  private unsub?: Unsubscribe;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    addIcons({ alertCircle, checkmark });
  }

  protected async show() {
    if (!this.amount() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const id = await this.bank.createRequest(this.amount());
      this.reqId = id;
      this.qr.set(await QRCode.toDataURL(payUrl(this.bank.code()!, id), {
        margin: 1, width: 640, errorCorrectionLevel: 'M', color: { dark: '#0b1220', light: '#ffffff' },
      }));
      this.step.set('qr');
      this.unsub = this.bank.watchRequest(id, r => {
        if (r.status !== 'paid') return;
        this.payer.set(this.bank.name(r.paidBy ?? null));
        this.step.set('paid');
        buzz([20, 60, 30]);
        this.stopWaiting();
        this.timer = setTimeout(() => this.modalCtrl.dismiss(true, 'done'), 2200);
      });
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected edit() {
    this.stopWaiting();
    this.step.set('amount');
  }

  protected close() {
    this.modalCtrl.dismiss(null, 'cancel');
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
    this.stopWaiting();
  }

  /** Stops listening; an unpaid QR is cancelled so it can't be paid later. */
  private stopWaiting() {
    this.unsub?.();
    this.unsub = undefined;
    if (this.reqId && this.step() === 'qr') void this.bank.cancelRequest(this.reqId);
    this.reqId = undefined;
  }
}
