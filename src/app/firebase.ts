import { initializeApp } from 'firebase/app';
import { browserLocalPersistence, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { environment } from '../environments/environment';
import { firebaseConfig } from './firebase.config';

// Web config ships in the bundle anyway; the Firestore rules are what protect the data.
const app = initializeApp(firebaseConfig);

// Anonymous auth only: the persisted uid is what lets a player rejoin after a refresh.
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
export const db = getFirestore(app);

if (environment.useEmulators) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
}
