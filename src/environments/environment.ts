import { appCheckDebugToken } from '../app/firebase.config';

// `ng build` swaps this file for environment.prod.ts (see angular.json fileReplacements).
export const environment = {
  production: false,
  // `npm run dev` starts the Firebase emulators alongside `ng serve`.
  useEmulators: true,
  // Lets local scans pass App Check. Only this dev file reads it, so it never reaches a production build.
  appCheckDebugToken,
};
