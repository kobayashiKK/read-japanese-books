const DB_NAME = "read-japanese-books";
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("books", { keyPath: "id" });
      db.createObjectStore("chapters", { keyPath: ["bookId", "index"] });
      db.createObjectStore("audio", { keyPath: ["bookId", "chapter", "chunk", "speaker"] });
      db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(store, key) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).get(key));
}

export async function dbGetAll(store, range) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).getAll(range));
}

export async function dbPut(store, value) {
  const db = await openDB();
  return promisify(db.transaction(store, "readwrite").objectStore(store).put(value));
}

export async function dbDelete(store, key) {
  const db = await openDB();
  return promisify(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function dbDeleteRange(store, range) {
  const db = await openDB();
  return promisify(db.transaction(store, "readwrite").objectStore(store).delete(range));
}

export async function dbClear(store) {
  const db = await openDB();
  return promisify(db.transaction(store, "readwrite").objectStore(store).clear());
}

export function bookRange(bookId) {
  return IDBKeyRange.bound([bookId], [bookId, []]);
}

export async function getSetting(key, fallback) {
  const rec = await dbGet("settings", key);
  return rec ? rec.value : fallback;
}

export async function setSetting(key, value) {
  await dbPut("settings", { key, value });
}
