import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AlertController, IonButton, IonContent, IonIcon, ModalController, ToastController, ViewWillEnter } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircle, businessOutline, chevronForward, downloadOutline, scanOutline } from 'ionicons/icons';
import { GameService, errorText } from '../game.service';
import { Status, parseQr, prefs } from '../money';
import { ScanModal } from '../ui/scan-modal';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonContent, IonButton, IonIcon, RouterLink],
})
export class HomePage implements ViewWillEnter {
  private readonly bank = inject(GameService);
  private readonly router = inject(Router);
  private readonly modals = inject(ModalController);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);

  protected readonly resume = signal<{ code: string; status?: Status } | null>(null);
  protected readonly setupError = signal('');
  private readonly iosBrowser =
    /iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone;
  protected readonly canInstall = computed(() => !!this.bank.installPrompt() || this.iosBrowser);

  constructor() {
    addIcons({ alertCircle, businessOutline, chevronForward, downloadOutline, scanOutline });
  }

  async ionViewWillEnter() {
    this.bank.stop();
    const code = prefs.get('game');
    // Show the shortcut straight away (works offline), then drop it if the game is over.
    this.resume.set(code ? { code } : null);
    try {
      await this.bank.signIn();
      this.setupError.set('');
    } catch (e) {
      this.setupError.set(errorText(e));
      return;
    }
    if (!code) return;
    try {
      const { game, member } = await this.bank.preview(code);
      if (member && game.status !== 'ended') this.resume.set({ code, status: game.status });
      else this.forget();
    } catch (e) {
      if (navigator.onLine) this.forget();
    }
  }

  protected open(code: string) {
    this.router.navigateByUrl(`/game/${code}`);
  }

  protected async scan() {
    const m = await this.modals.create({
      component: ScanModal,
      componentProps: { title: 'Join a game', hint: 'Scan the QR code on the banker’s phone', alt: 'Type the code instead' },
    });
    await m.present();
    const { data, role } = await m.onDidDismiss<string>();
    if (role === 'alt') return void this.router.navigateByUrl('/join');
    if (role !== 'scan') return;
    const qr = parseQr(data ?? '');
    if (!qr) {
      const t = await this.toasts.create({ message: 'That isn’t a Board Banker code.', duration: 3000, color: 'danger', position: 'top' });
      return void t.present();
    }
    this.router.navigateByUrl(qr.req ? `/game/${qr.code}?pay=${qr.req}` : `/join/${qr.code}`);
  }

  protected async install() {
    const prompt = this.bank.installPrompt();
    if (prompt) {
      await prompt.prompt();
      this.bank.installPrompt.set(null);
      return;
    }
    const a = await this.alerts.create({
      header: 'Install on iPhone',
      message: 'In Safari, tap the Share button, then “Add to Home Screen”. Install before you join a game, so your seat stays with the app.',
      buttons: ['Got it'],
    });
    await a.present();
  }

  private forget() {
    prefs.set('game', null);
    this.resume.set(null);
  }
}
