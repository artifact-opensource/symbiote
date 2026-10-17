import { getApp, getApps, initializeApp } from '@firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from '@firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const configured = Object.values(firebaseConfig).every(value => typeof value === 'string' && value.trim().length > 0);
const auth = configured
  ? getAuth(getApps().length ? getApp() : initializeApp(firebaseConfig))
  : null;

export function observeGoogleUser(onChange: (user: User | null) => void, onError?: (error: Error) => void): () => void {
  if (!auth) {
    onChange(null);
    onError?.(new Error('Google Workspace sign-in is not configured. Set the VITE_FIREBASE_* values and rebuild the web app.'));
    return () => {};
  }
  return onAuthStateChanged(auth, onChange, onError);
}

export async function googleSignIn(scopes: readonly string[] = []): Promise<{ user: User; accessToken?: string }> {
  if (!auth) throw new Error('Google Workspace sign-in is not configured. Set the VITE_FIREBASE_* values and rebuild the web app.');
  const provider = new GoogleAuthProvider();
  for (const scope of scopes) provider.addScope(scope);

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  return { user: result.user, accessToken: credential?.accessToken ?? undefined };
}

export async function googleSignOut(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}
