// Firebase backend: Google sign-in + Firestore for access control and recorded sessions.
// The real protection is in the Firestore Security Rules (see setup/firestore.rules):
// only the owner can approve/revoke, and only approved users can read/write data.
import {
  initializeApp, getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, orderBy, limit, getDocs,
  serverTimestamp, writeBatch,
} from '../vendor/firebase.js';

export function createFirebaseBackend(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), // works offline, syncs later
  });
  getRedirectResult(auth).catch(() => {});

  const userRef = uid => doc(db, 'users', uid);
  const sessCol = uid => collection(db, 'users', uid, 'sessions');
  const chunkCol = (uid, sid) => collection(db, 'users', uid, 'sessions', sid, 'chunks');
  const fire = p => p.catch(e => console.warn('firestore:', e.code || e.message));  // offline-safe "fire and forget"

  return {
    kind: 'firebase',

    onAuth(cb) { return onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, email: u.email, name: u.displayName, photo: u.photoURL } : null)); },

    async signIn() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try { await signInWithPopup(auth, provider); }
      catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(auth, provider);
        } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          throw e;
        }
      }
    },
    signOut() { return signOut(auth); },

    // Creates the access request the first time someone signs in.
    async ensureProfile(u) {
      const ref = userRef(u.uid);
      let snap;
      try { snap = await getDoc(ref); } catch (e) { snap = null; }   // offline: cached copy or nothing
      if (snap && !snap.exists()) {
        await setDoc(ref, {
          email: u.email || '', name: u.name || '', photo: u.photo || '',
          status: 'pending', requestedAt: serverTimestamp(), lastSeen: serverTimestamp(), message: '',
        });
      } else if (snap) {
        fire(updateDoc(ref, { lastSeen: serverTimestamp(), name: u.name || '', photo: u.photo || '' }));
      }
    },

    watchProfile(uid, cb, err) {
      return onSnapshot(userRef(uid), s => cb(s.exists() ? { id: s.id, ...s.data({ serverTimestamps: 'estimate' }) } : null), err);
    },

    // Succeeds only for the owner (rules allow listing users only to the admin).
    watchAllUsers(cb, err) {
      return onSnapshot(query(collection(db, 'users'), orderBy('requestedAt', 'desc')),
        { includeMetadataChanges: true },
        qs => cb(qs.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })), qs.metadata.fromCache), err);
    },

    setUserStatus(uid, status) {
      return updateDoc(userRef(uid), { status, decidedAt: serverTimestamp() });
    },
    removeUser(uid) { return deleteDoc(userRef(uid)); },
    sendMessage(uid, message) {
      return updateDoc(userRef(uid), { message: String(message).slice(0, 500), requestedAt: serverTimestamp() });
    },

    // ---- recorded sessions ----
    createSession(uid, meta) {
      const ref = doc(sessCol(uid));
      fire(setDoc(ref, { ...meta, startedAt: serverTimestamp(), rowCount: 0, status: 'recording' }));
      return ref.id;
    },
    addChunk(uid, sid, index, payload) {
      fire(setDoc(doc(chunkCol(uid, sid), String(index).padStart(6, '0')), { i: index, ...payload }));
    },
    updateSession(uid, sid, patch) { fire(updateDoc(doc(sessCol(uid), sid), patch)); },

    async listSessions(uid) {
      const qs = await getDocs(query(sessCol(uid), orderBy('startedAtMs', 'desc'), limit(200)));
      return qs.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async getSessionCsvBody(uid, sid) {
      const qs = await getDocs(query(chunkCol(uid, sid), orderBy('i')));
      return qs.docs.map(d => d.data().csv).filter(Boolean).join('\n');
    },
    async deleteSession(uid, sid) {
      const qs = await getDocs(chunkCol(uid, sid));
      let batch = writeBatch(db), n = 0;
      for (const d of qs.docs) {
        batch.delete(d.ref);
        if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
      }
      batch.delete(doc(sessCol(uid), sid));
      await batch.commit();
    },
  };
}
