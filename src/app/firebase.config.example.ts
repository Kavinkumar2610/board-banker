// Copy to firebase.config.ts (gitignored) and fill in from Firebase console → Project settings → Your apps → Web app.
// The emulators (`npm run dev`) accept any apiKey, but projectId must match .firebaserc.
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

// App Check for card scanning: a reCAPTCHA Enterprise site key registered in Firebase console → App Check, and a
// debug token (Manage debug tokens) so local development can scan. Keep the debug token out of git.
export const recaptchaSiteKey = 'YOUR_RECAPTCHA_SITE_KEY';
export const appCheckDebugToken = 'YOUR_DEBUG_TOKEN';
