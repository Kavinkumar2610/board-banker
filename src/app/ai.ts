import { AIError, GoogleAIBackend, Schema, getAI, getGenerativeModel } from 'firebase/ai';
import { ReCaptchaEnterpriseProvider, initializeAppCheck } from 'firebase/app-check';
import { environment } from '../environments/environment';
import { app } from './firebase';
import { recaptchaSiteKey } from './firebase.config';
import { retry } from './money';

// App Check proves a scan comes from this app, so nobody else can spend the free Gemini allowance. It starts here,
// on the first scan, rather than at app start, so reCAPTCHA only loads for players who scan. Local development
// (emulators) uses a registered debug token instead, since test browsers rarely pass reCAPTCHA's bot check.
if (environment.appCheckDebugToken) {
  (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = environment.appCheckDebugToken;
}
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true });

/** Google's "too many requests" and "model busy" answers clear within seconds; anything else is a real failure. */
const busy = (e: unknown) => e instanceof AIError && [429, 500, 503].includes(e.customErrorData?.status ?? 0);

// ponytail: one model, named here; change it if Google retires it.
const MODEL = 'gemini-3.5-flash-lite';

const PROMPT = `These photos show property cards (title deeds) from a property-trading board game.
List each distinct card once, whether you see its front or back. For each card give:
- name: the property name as printed
- mortgage: its mortgage value
- house: the price of one house ("Houses cost RM2,000 each" → 2000), or 0 if the card has no houses
- hotel: the price of one hotel ("Hotels, RM2,000 plus 4 houses" → 2000), or 0 if the card has no hotels
Stations and utilities have no houses or hotels.
Numbers only, without currency symbols or separators. Skip any card you can't read clearly.`;

// Every field required (0 = not on this card): the model tends to leave optional fields out.
const deeds = Schema.array({
  items: Schema.object({
    properties: { name: Schema.string(), mortgage: Schema.integer(), house: Schema.integer(), hotel: Schema.integer() },
  }),
});

export interface ScannedDeed { name: string; mortgage: number; house?: number; hotel?: number }

/**
 * Reads property cards from photos with Gemini through Firebase AI Logic, so no API key lives in the app.
 * The player checks every value before submitting; this only saves the typing.
 */
export async function scanDeeds(photos: File[]): Promise<ScannedDeed[]> {
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), {
    model: MODEL,
    generationConfig: { responseMimeType: 'application/json', responseSchema: deeds },
  });
  const images = await Promise.all(photos.map(async f => ({
    type: 'inlineData' as const, inlineData: { mimeType: 'image/jpeg', data: await shrink(f) },
  })));
  const res = await retry(() => model.generateContent([PROMPT, ...images]), busy);
  const cards = JSON.parse(res.response.text()) as ScannedDeed[];
  return cards.filter(c => typeof c.name === 'string' && c.name.trim() && Number.isInteger(c.mortgage) && c.mortgage >= 0);
}

/** Phone photos are large; 1600px is plenty to read a card and keeps the upload small. Returns base64 JPEG. */
async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}
