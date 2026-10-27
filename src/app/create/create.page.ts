import { Component, computed, inject, signal } from '@angular/core';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonSpinner, IonTitle, IonToggle,
  IonToolbar, NavController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircle } from 'ionicons/icons';
import { GameService, errorText } from '../game.service';
import { prefs } from '../money';

@Component({
  selector: 'app-create',
  templateUrl: 'create.page.html',
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonInput, IonToggle, IonFooter, IonButton, IonSpinner, IonIcon],
})
export class CreatePage {
  private readonly bank = inject(GameService);
  private readonly nav = inject(NavController);

  protected readonly name = signal(prefs.get('name') ?? '');
  protected readonly plays = signal(true);
  protected readonly tried = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly valid = computed(() => this.name().trim().length > 0);

  constructor() {
    addIcons({ alertCircle });
  }

  protected async create() {
    this.tried.set(true);
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const name = this.name().trim();
      const code = await this.bank.createGame(name, this.plays());
      prefs.set('name', name);
      prefs.set('game', code);
      await this.nav.navigateRoot(`/game/${code}`, { animationDirection: 'forward' });
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
