/* IndexedDB の最小ラッパ(設計書§3「idb-keyval 相当を自前実装・50行程度」)。
 * ストア構成は §4-1。キーは呼び出し側が組み立てる(projectId+username 等)。
 * 依存ゼロ・Promise のみ。使えない環境(プライベートモード等)では open が reject する。 */

const DB_NAME = "castnext";
const DB_VERSION = 1;
export const STORES = ["projects", "candidates", "runs", "coverage", "oplog", "queue", "meta"];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB が使えません"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      STORES.forEach(name => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name); });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const idb = {
  get: (store, key) => tx(store, "readonly", s => s.get(key)),
  set: (store, key, value) => tx(store, "readwrite", s => s.put(value, key)),
  del: (store, key) => tx(store, "readwrite", s => s.delete(key)),
  clear: store => tx(store, "readwrite", s => s.clear()),
  keys: store => tx(store, "readonly", s => s.getAllKeys()),
  all: store => tx(store, "readonly", s => s.getAll()),
  /* 複数件をまとめて書く(候補の一括保存。1トランザクションで済ませる) */
  bulkSet: (store, entries) => tx(store, "readwrite", s => {
    entries.forEach(([k, v]) => s.put(v, k));
    return null;
  })
};

export async function wipeAll() {
  for (const s of STORES) await idb.clear(s);
}
