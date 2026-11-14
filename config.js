// ============================================================================
//  PASTE YOUR FIREBASE WEB CONFIG HERE (Firebase console -> Project settings ->
//  Your apps -> Web app -> "SDK setup and configuration" -> Config).
//  These values are NOT secret: security comes from the Firestore rules.
// ============================================================================
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

export const APP = {
  title: 'PM Monitor — INAIL & Sapienza',
  version: '2.0.0',
  chunkSize: 60,        // readings per cloud chunk (60 = one chunk per minute per box)
  chartPoints: 300,     // points kept on the live charts (~5 min at 1 Hz)
};
