import { Component, input, model, output, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { backspaceOutline } from 'ionicons/icons';
import { buzz, fmt } from '../money';

/** Big-number keypad, so entering rent never opens the phone keyboard. Typing works too. */
@Component({
  selector: 'app-amount-pad',
  imports: [IonIcon],
  template: `
    <div class="pad-display">
      <span class="pad-amount" [class.zero]="!value()" [class.long]="fmt(value()).length > 9" [class.shake]="shake()" aria-hidden="true">{{ fmt(value()) }}</span>
      <span class="sr-only" aria-live="polite">{{ fmt(value()) }}</span>
      <span class="pad-hint" [class.err]="tone() === 'err'" [class.warn]="tone() === 'warn'">{{ hint() }}</span>
    </div>
    <div class="pad-keys" role="group" aria-label="Amount keypad">
      @for (k of keys; track k) {
        <button type="button" class="pad-key" (click)="press(k)" [attr.aria-label]="k === 'del' ? 'Delete digit' : k">
          @if (k === 'del') {
            <ion-icon name="backspace-outline" aria-hidden="true" />
          } @else {
            {{ k }}
          }
        </button>
      }
    </div>
  `,
  host: { '(window:keydown)': 'onKey($event)' },
})
export class AmountPad {
  readonly value = model(0);
  readonly hint = input('');
  readonly tone = input<'' | 'warn' | 'err'>('');
  readonly enter = output<void>();

  protected readonly shake = signal(false);
  protected readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'];
  protected readonly fmt = fmt;

  constructor() {
    addIcons({ backspaceOutline });
  }

  press(key: string) {
    const v = this.value();
    const next = key === 'del' ? Math.floor(v / 10) : key === '00' ? v * 100 : v * 10 + Number(key);
    if (next > 99_999_999) return this.nudge();
    this.value.set(next);
    buzz(6);
  }

  protected onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) this.press(e.key);
    else if (e.key === 'Backspace') this.press('del');
    else if (e.key === 'Enter') this.enter.emit();
    else return;
    e.preventDefault();
  }

  private nudge() {
    buzz([10, 40, 10]);
    this.shake.set(false);
    requestAnimationFrame(() => this.shake.set(true));
  }
}
