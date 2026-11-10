import { Component, WritableSignal, computed, inject, input, signal } from '@angular/core';
import {
  IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonSpinner, IonTitle, IonToolbar, ModalController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { add, alertCircle, camera, checkmarkCircle, remove, trashOutline } from 'ionicons/icons';
import { GameService, errorText } from '../game.service';
import { Deed, buzz, deedValue, fmt } from '../money';

type Field = 'mortgage' | 'house' | 'hotel';

/**
 * End of game: the player lists their property cards (scanned from photos, or typed in), adds houses and hotels,
 * and submits the total so the standings go by net worth. Every value stays editable: the scan only saves typing.
 */
@Component({
  selector: 'app-property-modal',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonFooter, IonIcon, IonSpinner],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>Your properties</ion-title>
        <ion-buttons slot="end"><ion-button (click)="close()" [disabled]="busy()">Cancel</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="wrap">
        <p class="lede">Scan your property cards or type them in, check the values, then add houses and hotels.</p>
        <div class="add-row">
          <ion-button expand="block" (click)="picker.click()" [disabled]="scanning() || busy()">
            @if (scanning()) {
              <ion-spinner name="crescent" aria-hidden="true" /> Reading cards…
            } @else {
              <ion-icon slot="start" name="camera" aria-hidden="true" /> Scan cards
            }
          </ion-button>
          <ion-button expand="block" fill="outline" color="light" (click)="addBlank()" [disabled]="busy()">Add manually</ion-button>
          <input #picker type="file" accept="image/*" multiple hidden (change)="scan(picker)" />
        </div>
        @if (error()) {
          <p class="form-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true" />{{ error() }}</p>
        }

        <ul class="deeds">
          @for (d of list(); track $index; let i = $index) {
            <li class="deed">
              <div class="deed-head">
                @if (d.scanned) { <ion-icon name="checkmark-circle" class="read" role="img" aria-label="Read from the card" /> }
                <input class="deed-name" [value]="d.name" placeholder="Property name" aria-label="Property name"
                  (input)="set(i, { name: text($event) })" />
                <button type="button" class="icon-btn" (click)="drop(i)" [attr.aria-label]="'Remove ' + (d.name || 'property')">
                  <ion-icon name="trash-outline" aria-hidden="true" />
                </button>
              </div>
              <div class="prices">
                @for (f of fields; track f.key) {
                  <label>{{ f.label }}
                    <input type="number" inputmode="numeric" min="0" [value]="d[f.key] || ''" placeholder="0"
                      (input)="setPrice(i, f.key, $event)" />
                  </label>
                }
              </div>
              <div class="counts">
                <div class="stepper" role="group" aria-label="Houses">
                  <span>Houses</span>
                  <button type="button" (click)="step(i, 'houses', -1)" [disabled]="!d.houses" aria-label="One house fewer"><ion-icon name="remove" /></button>
                  <span class="num">{{ d.houses }}</span>
                  <button type="button" (click)="step(i, 'houses', 1)" [disabled]="d.houses >= 4" aria-label="One more house"><ion-icon name="add" /></button>
                </div>
                <div class="stepper" role="group" aria-label="Hotel">
                  <span>Hotel</span>
                  <button type="button" (click)="step(i, 'hotels', -1)" [disabled]="!d.hotels" aria-label="No hotel"><ion-icon name="remove" /></button>
                  <span class="num">{{ d.hotels }}</span>
                  <button type="button" (click)="step(i, 'hotels', 1)" [disabled]="d.hotels >= 1" aria-label="Add a hotel"><ion-icon name="add" /></button>
                </div>
                <strong class="deed-total num">{{ fmt(value(d)) }}</strong>
              </div>
            </li>
          } @empty {
            <li class="empty">No properties yet. No cards? Submit {{ fmt(0) }}.</li>
          }
        </ul>
      </div>
    </ion-content>

    <ion-footer class="ion-no-border">
      <div class="footer-bar">
        <ion-button expand="block" size="large" (click)="submit()" [disabled]="busy() || scanning()">
          @if (busy()) { <ion-spinner name="crescent" aria-label="Saving" /> } @else { Submit {{ fmt(total()) }} }
        </ion-button>
      </div>
    </ion-footer>
  `,
  styles: `
    .add-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
    .deeds { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 12px; }
    .deed { background: var(--mb-surface); border: 1px solid var(--mb-border); border-radius: var(--mb-radius); padding: 12px; }
    .deed-head { display: flex; align-items: center; gap: 8px; }
    .read { color: var(--mb-pos); font-size: 22px; flex: none; }
    input {
      width: 100%; min-width: 0; min-height: 44px; padding: 8px 10px; border: 1px solid var(--mb-border); border-radius: var(--mb-radius-sm);
      background: var(--mb-surface-2); color: var(--mb-text); font: 600 16px var(--mb-font);
    }
    input:focus { outline: 2px solid var(--mb-gold); outline-offset: 1px; }
    .deed-name { flex: 1; font-weight: 700; }
    .icon-btn { flex: none; width: 44px; height: 44px; border: 0; border-radius: var(--mb-radius-sm); background: none; color: var(--mb-muted); font-size: 20px; }
    .prices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
    .prices label { display: grid; gap: 4px; font-size: 13px; color: var(--mb-muted); }
    .counts { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; }
    .stepper { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--mb-muted); }
    .stepper button {
      width: 40px; height: 40px; border: 0; border-radius: 50%; background: var(--mb-surface-3); color: var(--mb-text);
      display: grid; place-items: center; font-size: 18px;
    }
    .stepper button:disabled { opacity: 0.35; }
    .stepper .num { min-width: 14px; text-align: center; color: var(--mb-text); font-weight: 700; font-size: 17px; }
    .deed-total { margin-left: auto; font-size: 17px; }
    .empty { color: var(--mb-muted); text-align: center; padding: 16px 0; }
  `,
})
export class PropertyModal {
  /** The page's list, so it survives closing and reopening the sheet to fix something. */
  readonly deeds = input.required<WritableSignal<Deed[]>>();

  private readonly bank = inject(GameService);
  private readonly modalCtrl = inject(ModalController);
  protected readonly fmt = fmt;
  protected readonly value = deedValue;
  protected readonly fields: { key: Field; label: string }[] = [
    { key: 'mortgage', label: 'Mortgage' }, { key: 'house', label: 'House price' }, { key: 'hotel', label: 'Hotel price' },
  ];
  protected readonly list = computed(() => this.deeds()());
  protected readonly total = computed(() => this.list().reduce((sum, d) => sum + deedValue(d), 0));
  protected readonly scanning = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  constructor() {
    addIcons({ add, alertCircle, camera, checkmarkCircle, remove, trashOutline });
  }

  protected text(e: Event) { return (e.target as HTMLInputElement).value; }

  protected setPrice(i: number, key: Field, e: Event) {
    this.set(i, { [key]: Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0)) });
  }

  protected set(i: number, patch: Partial<Deed>) {
    this.deeds().update(list => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  protected step(i: number, key: 'houses' | 'hotels', by: number) {
    this.set(i, { [key]: this.list()[i][key] + by });
  }

  protected drop(i: number) {
    this.deeds().update(list => list.filter((_, j) => j !== i));
  }

  protected addBlank() {
    this.deeds().update(list => [...list, { name: '', mortgage: 0, house: 0, hotel: 0, houses: 0, hotels: 0, scanned: false }]);
  }

  protected async scan(picker: HTMLInputElement) {
    const photos = [...(picker.files ?? [])].slice(0, 6);
    picker.value = ''; // picking the same photo again still fires a change
    if (!photos.length) return;
    this.scanning.set(true);
    this.error.set('');
    try {
      const { scanDeeds } = await import('../ai');
      const found = await scanDeeds(photos);
      const have = new Set(this.list().map(d => d.name.trim().toLowerCase()));
      const fresh = found.filter(c => !have.has(c.name.trim().toLowerCase()));
      this.deeds().update(list => [...list, ...fresh.map(c => ({
        name: c.name.trim(), mortgage: c.mortgage, house: c.house ?? 0, hotel: c.hotel ?? 0, houses: 0, hotels: 0, scanned: true,
      }))]);
      if (!found.length) this.error.set('No cards found in that photo. Try a closer, brighter shot, or add them manually.');
      buzz(15);
    } catch (e) {
      console.error(e);
      this.error.set('Couldn’t read the cards just now. Try again, or add them manually.');
    } finally {
      this.scanning.set(false);
    }
  }

  protected async submit() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.bank.setAssets(this.total());
      buzz([15, 60, 25]);
      await this.modalCtrl.dismiss(this.total(), 'done');
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected close() {
    this.modalCtrl.dismiss(null, 'cancel');
  }
}
