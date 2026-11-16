// ============================================================================
//  PASTE YOUR FIREBASE WEB CONFIG HERE (Firebase console -> Project settings ->
//  Your apps -> Web app -> "SDK setup and configuration" -> Config).
//  These values are NOT secret: security comes from the Firestore rules.
// ============================================================================
export const firebaseConfig = {
  apiKey: "AIzaSyDF0liqApVQ7_gtcvDC3uRZq90gca9eQqM",
  authDomain: "pm-sensor-inail--sajjad-rasmi.firebaseapp.com",
  projectId: "pm-sensor-inail--sajjad-rasmi",
  storageBucket: "pm-sensor-inail--sajjad-rasmi.firebasestorage.app",
  messagingSenderId: "459699182588",
  appId: "1:459699182588:web:c9833bf9fe0a983147f079",
};

export const APP = {
  title: 'PM Monitor — INAIL & Sapienza',
  version: '2.3.1',
  chunkSize: 60,        // readings per cloud chunk (60 = one chunk per minute per box)
  chartPoints: 300,     // points kept on the live charts (~5 min at 1 Hz)
};
