import { AfterViewInit, Component, ElementRef, OnDestroy, inject, input, signal, viewChild } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar, ModalController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { videocamOffOutline } from 'ionicons/icons';
import type QrScanner from 'qr-scanner';
import { buzz } from '../money';

/** Full-screen camera. Dismisses with the decoded text (role 'scan'), or role 'alt' for the fallback button. */
@Component({
  selector: 'app-scan-modal',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonFooter, IonIcon],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="dark-bar">
        <ion-title>{{ title() }}</ion-title>
        <ion-buttons slot="end"><ion-button (click)="close()">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="scan" [scrollY]="false">
      <video #video playsinline muted aria-hidden="true"></video>
      @if (failed()) {
        <div class="scan-msg" role="alert">
          <ion-icon name="videocam-off-outline" aria-hidden="true" />
          <h2>Camera unavailable</h2>
          <p>{{ failed() }}</p>
        </div>
      } @else {
        <div class="viewfinder" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <p class="scan-hint">{{ hint() }}</p>
      }
    </ion-content>

    @if (alt()) {
      <ion-footer class="ion-no-border dark-footer">
        <div class="footer-bar">
          <ion-button expand="block" size="large" fill="outline" color="light" (click)="useAlt()">{{ alt() }}</ion-button>
        </div>
      </ion-footer>
    }
  `,
  styles: `
    .dark-bar { --background: #000; --color: #fff; }
    .dark-footer { background: #000; }
    .scan { --background: #000; }
    video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .viewfinder {
      position: absolute; left: 50%; top: 46%;
      width: min(70vw, 280px); aspect-ratio: 1;
      transform: translate(-50%, -50%);
      border-radius: 24px;
      box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.5);
    }
    .viewfinder i { position: absolute; width: 40px; height: 40px; border: 4px solid var(--mb-gold); }
    .viewfinder i:nth-child(1) { top: 0; left: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 24px; }
    .viewfinder i:nth-child(2) { top: 0; right: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 24px; }
    .viewfinder i:nth-child(3) { bottom: 0; left: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 24px; }
    .viewfinder i:nth-child(4) { bottom: 0; right: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 24px; }
    .scan-hint {
      position: absolute; left: 0; right: 0; bottom: 28px; margin: 0; padding: 0 24px;
      color: #fff; font-size: 17px; font-weight: 600; text-align: center;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
    }
    .scan-msg {
      position: absolute; inset: 0; padding: 32px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
      color: #fff; text-align: center; line-height: 1.5;
    }
    .scan-msg ion-icon { font-size: 52px; color: var(--mb-gold); }
    .scan-msg h2 { margin: 8px 0 0; font-size: 20px; }
    .scan-msg p { margin: 0; color: #cbd5e1; max-width: 340px; }
  `,
})
export class ScanModal implements AfterViewInit, OnDestroy {
  readonly title = input('Scan QR code');
  readonly hint = input('Point your camera at the QR code');
  /** Label for a fallback action, e.g. "Choose a player instead". */
  readonly alt = input('');

  private readonly modalCtrl = inject(ModalController);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  protected readonly failed = signal('');
  private scanner?: QrScanner;
  private handled = false;
  private destroyed = false;

  constructor() {
    addIcons({ videocamOffOutline });
  }

  async ngAfterViewInit() {
    try {
      const { default: Scanner } = await import('qr-scanner');
      if (this.destroyed) return;
      this.scanner = new Scanner(this.video().nativeElement, r => this.found(r.data), {
        preferredCamera: 'environment',
        maxScansPerSecond: 12,
        returnDetailedScanResult: true,
        // Whole frame (downscaled), so a code anywhere in view reads, not just inside the viewfinder.
        calculateScanRegion: v => {
          const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
          return {
            x: 0, y: 0, width: v.videoWidth, height: v.videoHeight,
            downScaledWidth: Math.round(v.videoWidth * k), downScaledHeight: Math.round(v.videoHeight * k),
          };
        },
      });
      await this.scanner.start();
    } catch (e) {
      const text = `${(e as Error)?.name ?? ''} ${e}`;
      this.failed.set(
        !isSecureContext ? 'The camera only works over a secure (https) connection.'
        : /NotAllowed|Permission|denied/i.test(text) ? 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.'
        : 'No camera was found on this device.',
      );
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.scanner?.destroy();
  }

  private found(text: string) {
    if (this.handled || !text) return;
    this.handled = true;
    buzz(20);
    this.scanner?.stop();
    this.modalCtrl.dismiss(text, 'scan');
  }

  protected useAlt() {
    this.modalCtrl.dismiss(null, 'alt');
  }

  protected close() {
    this.modalCtrl.dismiss(null, 'cancel');
  }
}
