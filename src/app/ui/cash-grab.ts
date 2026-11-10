import { Component, OnDestroy, computed, effect, inject, output, signal } from '@angular/core';
import { IonButton } from '@ionic/angular';
import { GameService, errorText } from '../game.service';
import { GRAB_COUNTDOWN_MS, buzz, fmt } from '../money';
import { Avatar } from './avatar';

/** Same scatter on every phone (and no jumping as notes go): offsets come from the grab's id. */
function seeded(id: string) {
  let a = [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761), 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The bank's notes scattered over the screen. After the same 3-2-1 on every phone, the first tap on a note
 * takes it. It's over when every note is gone; then everyone sees who grabbed what.
 */
@Component({
  selector: 'app-cash-grab',
  imports: [IonButton, Avatar],
  host: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'grab-title' },
  template: `
    <div class="grab-head">
      <h1 id="grab-title" class="page-title">{{ done() ? 'All grabbed!' : 'Cash grab!' }}</h1>
      <p class="lede">The bank threw all {{ g().count }} {{ fmt(g().each) }} notes · {{ fmt(g().each * g().count) }}</p>
    </div>

    @if (done()) {
      <ul class="list results">
        @for (r of results(); track r.p.id) {
          <li class="row">
            <app-avatar [name]="r.p.name" [color]="r.p.color" />
            <span class="row-main"><span class="row-title">{{ r.p.id === bank.uid() ? 'You' : r.p.name }}</span></span>
            <span class="row-end" [class.pos]="r.amount > 0">{{ fmt(r.amount) }}</span>
          </li>
        }
      </ul>
      <ion-button class="done-btn" expand="block" size="large" (click)="closed.emit()">Done</ion-button>
    } @else {
      <div class="field" [class.waiting]="countdown() > 0">
        @for (n of notes(); track n.i) {
          <button type="button" class="note" [class.taken]="!!n.by" [class.mine]="!!n.by && n.by === bank.uid()"
            [style.--dx]="n.dx + 'px'" [style.--dy]="n.dy + 'px'" [style.--r]="n.r + 'deg'" [style.--i]="n.i"
            [disabled]="!!n.by || countdown() > 0 || !canGrab()" (click)="take(n.i)" [attr.aria-label]="'Grab ' + fmt(g().each)">
            {{ fmt(g().each) }}
          </button>
        }
        @for (c of [countdown()]; track c) {
          @if (c > 0) { <div class="count" aria-live="assertive">{{ c }}</div> }
        }
      </div>
      <p class="grab-status" aria-live="polite">{{ status() }}</p>
    }
  `,
  styles: `
    :host {
      position: fixed; inset: 0; z-index: 100;
      display: flex; flex-direction: column;
      padding: calc(env(safe-area-inset-top) + 12px) 16px calc(env(safe-area-inset-bottom) + 16px);
      background: radial-gradient(120% 70% at 50% 0%, rgba(21, 128, 61, 0.35), transparent 60%) var(--mb-bg);
      animation: mb-rise 0.2s var(--mb-ease-out) both;
    }
    .grab-head, .field, .results, .done-btn, .grab-status { width: 100%; max-width: 560px; margin-left: auto; margin-right: auto; }
    .grab-head { text-align: center; }
    .grab-head .page-title { margin: 8px 0 4px; }
    .grab-head .lede { margin: 0; font-size: 15px; }
    .field {
      position: relative; flex: 1; margin-top: 12px;
      display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 1fr; gap: 6px; align-items: center;
    }
    .note {
      width: 100%; height: 100%; min-height: 44px; max-height: 64px; padding: 0; border: 0; border-radius: 8px;
      background: linear-gradient(135deg, #22a35a, var(--mb-felt) 55%, #0f5f33);
      box-shadow: inset 0 0 0 3px var(--mb-felt), inset 0 0 0 4px rgba(245, 176, 20, 0.7), 0 6px 14px rgba(0, 0, 0, 0.45);
      color: #fff; font: 800 17px/1 var(--mb-font); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
      transform: translate(var(--dx), var(--dy)) rotate(var(--r));
      transition: transform 0.35s var(--mb-ease-out), opacity 0.35s;
      animation: note-drop 0.55s var(--mb-ease-out) backwards;
      animation-delay: calc(var(--i) * 28ms);
      touch-action: manipulation; cursor: pointer;
    }
    .waiting .note { filter: saturate(0.7) brightness(0.8); }
    .note:disabled { cursor: default; }
    .note.taken { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--r)) scale(0.5); pointer-events: none; }
    .note.mine { transform: translateY(-36px) scale(1.15); }
    .count {
      position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
      font: 400 120px/1 var(--mb-display); color: var(--mb-gold); text-shadow: 0 6px 30px rgba(0, 0, 0, 0.7);
      animation: count-pop 0.9s var(--mb-ease-out) both;
    }
    .grab-status { margin-top: 12px; margin-bottom: 0; min-height: 24px; text-align: center; font-size: 17px; font-weight: 700; }
    .results { margin-top: 16px; }
    .row-end.pos { color: var(--mb-pos); }
    .done-btn { margin-top: auto; }
    @keyframes note-drop { from { opacity: 0; transform: translateY(-45vh) rotate(calc(var(--r) * 4)); } }
    @keyframes count-pop { from { opacity: 0; transform: scale(1.6); } 30% { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      :host, .note, .count { animation: none; }
      .note { transition: opacity 0.15s; }
    }
  `,
})
export class CashGrab implements OnDestroy {
  readonly closed = output();

  protected readonly bank = inject(GameService);
  protected readonly fmt = fmt;
  protected readonly g = computed(() => this.bank.grab()!);
  private readonly id = computed(() => this.g().id);

  private readonly now = signal(Date.now());
  private readonly tick = setInterval(() => this.now.set(Date.now()), 100);
  /** Seconds left in the 3-2-1, from the grab's server time (the database refuses earlier grabs anyway). */
  protected readonly countdown = computed(() =>
    Math.max(0, Math.ceil(((this.g().createdAt?.getTime() ?? 0) + GRAB_COUNTDOWN_MS - this.now()) / 1000)));

  private readonly offsets = computed(() => {
    const rand = seeded(this.id());
    return Array.from({ length: this.g().count }, () => ({ dx: (rand() - 0.5) * 12, dy: (rand() - 0.5) * 8, r: (rand() - 0.5) * 20 }));
  });
  protected readonly notes = computed(() => {
    const claims = this.bank.claims();
    return this.offsets().map((o, i) => ({ ...o, i, by: claims[String(i)] ?? null }));
  });
  protected readonly canGrab = computed(() => !!this.bank.me() && !this.bank.me()!.bankrupt);
  private readonly mine = computed(() => this.notes().filter(n => n.by === this.bank.uid()).length * this.g().each);
  private readonly left = computed(() => this.notes().filter(n => !n.by).length);
  protected readonly done = computed(() => this.left() === 0);
  protected readonly results = computed(() => {
    const won = new Map<string, number>();
    for (const n of this.notes()) if (n.by) won.set(n.by, (won.get(n.by) ?? 0) + this.g().each);
    return this.bank.players()
      .filter(p => !p.bankrupt || won.has(p.id))
      .map(p => ({ p, amount: won.get(p.id) ?? 0 }))
      .sort((a, b) => b.amount - a.amount);
  });

  /** Taps still on their way to the database; the log waits for them so it records what actually landed. */
  private readonly pending = signal(0);
  private readonly message = signal('');
  private messageTimer?: ReturnType<typeof setTimeout>;
  private logged = false;

  protected readonly status = computed(() => {
    if (this.message()) return this.message();
    const me = this.bank.me();
    if (!me) return 'You threw the cash. Watch them grab it!';
    if (me.bankrupt) return 'You’re out of the game, so you can’t grab.';
    if (this.countdown() > 0) return 'Get ready…';
    return `You’ve grabbed ${fmt(this.mine())} · ${this.left()} left`;
  });

  constructor() {
    effect(() => {
      if (!this.done() || this.pending() || this.logged) return;
      this.logged = true;
      if (this.mine()) void this.bank.logGrab(this.g(), this.mine());
    });
  }

  ngOnDestroy() {
    clearInterval(this.tick);
    clearTimeout(this.messageTimer);
  }

  protected async take(note: number) {
    if (!this.canGrab() || this.countdown() > 0) return;
    buzz(12);
    this.pending.update(n => n + 1);
    try {
      await this.bank.grabNote(note);
    } catch (e) {
      const missed = String((e as { code?: string })?.code ?? '').includes('permission-denied');
      this.message.set(missed ? 'Missed! Someone was faster.' : errorText(e));
      clearTimeout(this.messageTimer);
      this.messageTimer = setTimeout(() => this.message.set(''), 1400);
    } finally {
      this.pending.update(n => n - 1);
    }
  }
}
