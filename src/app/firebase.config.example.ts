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
