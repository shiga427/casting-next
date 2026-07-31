/* アプリの状態と保存(設計書§4)。
 * ・データは IndexedDB(このブラウザの中)にだけ置く。サーバには一切送らない(三原則1)
 * ・v3(管制室 v1.4 の書き出し)の読み込み互換を必ず維持する(§4-4)
 * ・保存できない環境(プライベートモード等)では警告を出し、書き出しを促す(現行仕様の継承)
 */
import { idb, openDb, wipeAll } from "./db.js";
import { DEFAULT_CONF, SBIS_VER, TOOL_VER } from "./pipeline/conf.js";
import { rescoreAll } from "./pipeline/sbis.js";
import { blankCovMeta, readAnyExport, exportV4, migrate } from "./pipeline/schema.js";

export const state = {
  ready: false,
  storageOk: false,
  savedAt: null,
  project: null,          // { id, name, brandName, preset, createdAt, params }
  conf: { ...DEFAULT_CONF },
  cands: [],
  rejected: [],
  confLog: [],
  coverage: [],
  covMeta: blankCovMeta(),
  govLog: [],
  runs: [],               // §4-3 run(分析結果の正体)
  queue: null,
  activeRunTag: null,
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => fn()); }

export const DEFAULT_PROJECT = {
  id: "p1", name: "ステムボーテ", brandName: "Stem beauté", preset: "stembeaute_v26",
  createdAt: null, params: null
};

/* ---- 読み込み ---------------------------------------------------------- */
export async function boot() {
  try {
    await openDb();
    state.storageOk = true;
  } catch (e) {
    state.storageOk = false;
  }
  if (state.storageOk) {
    const meta = (await idb.get("meta", "meta")) || {};
    const projectId = meta.activeProjectId || DEFAULT_PROJECT.id;
    const project = (await idb.get("projects", projectId)) || null;
    state.project = project;
    if (project) {
      const doc = (await idb.get("meta", "state:" + projectId)) || null;
      if (doc) {
        state.conf = Object.assign({ ...DEFAULT_CONF }, doc.conf || {});
        state.confLog = doc.confLog || [];
        state.coverage = doc.coverage || [];
        state.covMeta = Object.assign(blankCovMeta(), doc.covMeta || {});
        state.govLog = doc.govLog || [];
        state.rejected = doc.rejected || [];
        state.queue = doc.queue || null;
      }
      state.cands = ((await idb.all("candidates")) || []).filter(c => c._pid === projectId).map(migrate);
      state.runs = ((await idb.all("runs")) || []).filter(r => r._pid === projectId)
        .sort((a, b) => String(b.ingestedAt).localeCompare(String(a.ingestedAt)));
      state.activeRunTag = state.runs.length ? state.runs[0].runTag : null;
      rescoreAll(state.cands, state.conf);
      state.savedAt = meta.savedAt || null;
    }
  }
  state.ready = true;
  emit();
  return state;
}

/* ---- 保存 -------------------------------------------------------------- */
let saveTimer = null;
export function markDirty() {
  emit();
  if (!state.storageOk || !state.project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); }, 300);
}

export async function persist() {
  if (!state.storageOk || !state.project) return false;
  const pid = state.project.id;
  state.savedAt = new Date().toISOString();
  await idb.set("projects", pid, state.project);
  await idb.set("meta", "meta", { schemaVersion: 1, activeProjectId: pid, savedAt: state.savedAt, tool: TOOL_VER });
  await idb.set("meta", "state:" + pid, {
    conf: state.conf, confLog: state.confLog, coverage: state.coverage,
    covMeta: state.covMeta, govLog: state.govLog, rejected: state.rejected, queue: state.queue
  });
  await idb.bulkSet("candidates", state.cands.map(c => [pid + "|" + c.username, { ...c, _pid: pid }]));
  await idb.bulkSet("runs", state.runs.map(r => [pid + "|" + r.runTag, { ...r, _pid: pid }]));
  emit();
  return true;
}

/* タブを閉じる/バックグラウンド化の直前に書き切る(現行 flushSave の継承) */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { clearTimeout(saveTimer); persist(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { clearTimeout(saveTimer); persist(); }
  });
}

/* ---- プロジェクト ------------------------------------------------------ */
export async function createProject(input) {
  const p = { ...DEFAULT_PROJECT, ...input, createdAt: new Date().toISOString() };
  state.project = p;
  state.conf = { ...DEFAULT_CONF, ...(input && input.conf ? input.conf : {}) };
  await persist();
  emit();
  return p;
}

/* ---- run の登録(§4-3)------------------------------------------------- */
export function addRun(run) {
  const idx = state.runs.findIndex(r => r.runTag === run.runTag);
  if (idx >= 0) state.runs[idx] = run; else state.runs.unshift(run);
  state.activeRunTag = run.runTag;
  markDirty();
}
export function activeRun() {
  if (!state.runs.length) return null;
  return state.runs.find(r => r.runTag === state.activeRunTag) || state.runs[0];
}

/* ---- 入出力(§5-7)----------------------------------------------------- */
export function importAnyJson(text) {
  const d = JSON.parse(text);
  const s = readAnyExport(d, new Date().toISOString());
  state.conf = s.conf; state.confLog = s.confLog;
  state.cands = s.cands; state.rejected = s.rejected;
  state.coverage = s.coverage; state.covMeta = s.covMeta; state.govLog = s.govLog;
  if (s.project) state.project = s.project;
  if (s.runs && s.runs.length) { state.runs = s.runs; state.activeRunTag = s.runs[0].runTag; }
  if (s.queue) state.queue = s.queue;
  if (!state.project) state.project = { ...DEFAULT_PROJECT, createdAt: new Date().toISOString() };
  rescoreAll(state.cands, state.conf);
  markDirty();
  return { count: state.cands.length, sourceVersion: s.sourceVersion, confLog: state.confLog };
}

export function exportJson() {
  return exportV4({ ...state }, { now: new Date().toISOString(), tool: TOOL_VER });
}

export async function wipe() {
  await wipeAll();
  state.cands = []; state.rejected = []; state.runs = []; state.confLog = [];
  state.coverage = []; state.covMeta = blankCovMeta(); state.govLog = []; state.queue = null;
  state.conf = { ...DEFAULT_CONF }; state.savedAt = null; state.activeRunTag = null;
  emit();
}

export { SBIS_VER, TOOL_VER };
