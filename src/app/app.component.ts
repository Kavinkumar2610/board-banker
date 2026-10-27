import { Component, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { IonApp, IonIcon, IonRouterOutlet, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { cloudOfflineOutline } from 'ionicons/icons';
import { GameService } from './game.service';

@Component({
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet, IonIcon],
  template: `
    <ion-app>
      @if (!bank.online()) {
        <div class="offline-pill" role="status">
          <ion-icon name="cloud-offline-outline" aria-hidden="true" /> Offline · payments paused
        </div>
      }
      <ion-router-outlet />
    </ion-app>
  `,
})
export class AppComponent {
  protected readonly bank = inject(GameService);

  constructor() {
    addIcons({ cloudOfflineOutline });
    const sw = inject(SwUpdate);
    const toasts = inject(ToastController);
    if (!sw.isEnabled) return;
    sw.unrecoverable.subscribe(() => location.reload());
    sw.versionUpdates.subscribe(async e => {
      if (e.type !== 'VERSION_READY') return;
      const t = await toasts.create({
        message: 'A new version of the bank is ready.',
        position: 'top',
        buttons: [{ text: 'Reload', handler: () => location.reload() }],
      });
      await t.present();
    });
  }
}
