// Saves projects and their audio in IndexedDB on this device.
// Everything here is best-effort: if storage is unavailable (e.g. private
// browsing) the app keeps working for the current session.

const DB_NAME = 'audio-charter';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const store = {
  async list() {
    try {
      const all = await tx('projects', 'readonly', s => s.getAll());
      return (all || []).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    } catch { return []; }
  },
  async get(id) {
    try { return await tx('projects', 'readonly', s => s.get(id)); } catch { return null; }
  },
  async save(project) {
    try { await tx('projects', 'readwrite', s => s.put(project)); return true; } catch { return false; }
  },
  async saveAudio(id, blob, name) {
    try {
      await tx('audio', 'readwrite', s => s.put({ id, blob, name, type: blob.type }));
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      return true;
    } catch { return false; }
  },
  async getAudio(id) {
    try { return await tx('audio', 'readonly', s => s.get(id)); } catch { return null; }
  },
  async remove(id) {
    try {
      await tx('projects', 'readwrite', s => s.delete(id));
      await tx('audio', 'readwrite', s => s.delete(id));
    } catch { /* ignore */ }
  },
};
