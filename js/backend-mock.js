// In-memory backend used ONLY on localhost with ?dev (for testing the screens without Firebase).
export function createMockBackend(role = 'admin') {
  const listeners = { auth: [], users: [], profile: new Map() };
  const me = { uid: 'owner', email: 'owner@example.com', name: 'Owner (dev)', photo: '' };
  const users = new Map([
    ['owner', { email: me.email, name: me.name, status: role === 'admin' ? 'approved' : role, requestedAt: Date.now() - 9e6, message: '' }],
    ['u2', { email: 'colleague@uniroma1.it', name: 'A Colleague', status: 'pending', requestedAt: Date.now() - 3e6, message: 'Hi, I am in the INAIL team' }],
    ['u3', { email: 'student@example.com', name: 'Student', status: 'revoked', requestedAt: Date.now() - 6e6, message: '' }],
  ]);
  const sessions = new Map(); // uid -> Map(sid -> {meta, chunks:[]})
  let signedIn = false;
  const usersList = () => [...users.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.requestedAt - a.requestedAt);
  const notify = () => {
    listeners.users.forEach(cb => cb(usersList()));
    for (const [uid, cbs] of listeners.profile) cbs.forEach(cb => cb(users.has(uid) ? { id: uid, ...users.get(uid) } : null));
  };
  const S = uid => { if (!sessions.has(uid)) sessions.set(uid, new Map()); return sessions.get(uid); };
  let n = 0;
  return {
    kind: 'mock',
    onAuth(cb) { listeners.auth.push(cb); setTimeout(() => cb(signedIn ? me : null), 0); return () => {}; },
    async signIn() { signedIn = true; listeners.auth.forEach(cb => cb(me)); },
    async signOut() { signedIn = false; listeners.auth.forEach(cb => cb(null)); },
    async ensureProfile() {},
    watchProfile(uid, cb) {
      if (!listeners.profile.has(uid)) listeners.profile.set(uid, []);
      listeners.profile.get(uid).push(cb);
      setTimeout(() => cb(users.has(uid) ? { id: uid, ...users.get(uid) } : null), 0);
      return () => {};
    },
    watchAllUsers(cb, err) {
      if (role !== 'admin') { setTimeout(() => err({ code: 'permission-denied' }), 0); return () => {}; }
      listeners.users.push(cb); setTimeout(() => cb(usersList()), 0); return () => {};
    },
    async setUserStatus(uid, status) { users.get(uid).status = status; notify(); },
    async removeUser(uid) { users.delete(uid); notify(); },
    async sendMessage(uid, message) { users.get(uid).message = message; users.get(uid).requestedAt = Date.now(); notify(); },
    createSession(uid, meta) { const sid = 's' + (++n); S(uid).set(sid, { meta: { ...meta, rowCount: 0, status: 'recording' }, chunks: [] }); return sid; },
    addChunk(uid, sid, i, payload) { S(uid).get(sid).chunks[i] = payload; },
    updateSession(uid, sid, patch) { Object.assign(S(uid).get(sid).meta, patch); },
    async listSessions(uid) { return [...S(uid).entries()].map(([id, v]) => ({ id, ...v.meta })).sort((a, b) => b.startedAtMs - a.startedAtMs); },
    async getSessionCsvBody(uid, sid) { return S(uid).get(sid).chunks.filter(Boolean).map(c => c.csv).join('\n'); },
    async deleteSession(uid, sid) { S(uid).delete(sid); },
  };
}
