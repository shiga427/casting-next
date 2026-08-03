/* popup.js — ②プールから取得 と ①発掘して収集 の2タブ。
 * 収集/発掘の本体は instagram.com のタブ(content_ig.js)で走るので、
 * popup を閉じても最後まで完走し、ダウンロードも行われる。 */
const $ = (id) => document.getElementById(id);
let queue = null; // ②用 { handles:[{handle,tags}], runTag }

function findTab(patterns) {
  return chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url && patterns.some((p) => t.url.startsWith(p))));
}
async function readDashboard(key) {
  const tab = await findTab(['https://shiga427.github.io/casting-next']);
  if (!tab) return { error: 'ダッシュボードのタブが見つかりません。casting-next を開いてください。' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [key],
      func: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    });
    return { raw: res && res.result };
  } catch (e) { return { error: '読取失敗: ' + (e && e.message) }; }
}
async function ensureIgTab() {
  let t = await findTab(['https://www.instagram.com/', 'https://instagram.com/']);
  if (!t) { t = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false }); await new Promise((r) => setTimeout(r, 4000)); }
  return t;
}
function bindProgress(barId, statusId) {
  const setBar = (d, n) => { $(barId).style.width = n ? Math.round((d / n) * 100) + '%' : '0'; };
  const onMsg = (msg) => {
    if (!msg || msg.type !== 'IGF_PROGRESS' || !msg.p) return;
    const p = msg.p;
    if (p.phase === 'discover') { $(statusId).textContent = `発掘中 [${p.i}/${p.n}] ${p.handle}（候補 ${p.found}）`; setBar(p.i, p.n); }
    else if (p.phase === 'discover_done') { $(statusId).textContent = `発掘完了：候補${p.discovered} / 新規${p.fresh} / 取得対象${p.picked}。取得を開始します…`; setBar(0, 1); }
    else if (p.phase === 'collect') { $(statusId).textContent = `取得中 [${p.i}/${p.n}] ${p.handle} ${p.err ? 'NG(' + p.err + ')' : 'OK'}`; setBar(p.i, p.n); }
  };
  chrome.runtime.onMessage.addListener(onMsg);
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}
function doneSummary(statusId, result) {
  const s = (result && result.stats) || {};
  const errLines = Object.entries(s.byErr || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const head = s.picked != null ? `発掘→取得 完了（@${s.viewer}）\n候補${s.discovered} / 新規${s.fresh} / 取得${s.picked}\n` : `完了（@${s.viewer}）\n`;
  $(statusId).textContent = head + `OK ${s.ok} / NG ${s.err}`
    + (s.stopped ? `\n⚠ ${s.stopped} で中断（時間を置いて再実行で続きから）` : '')
    + (errLines ? '\n' + errLines : '')
    + `\n→ ${(result.runTag || 'run')}_compact.jsonl を保存。ダッシュボードを開いていれば自動反映します…`;
}

// 自動反映の結果（background から）を、開いていれば表示に足す
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'IGF_AUTOIMPORT') return;
  const el = document.querySelector('.pane.on #status, .pane.on #dstatus') || document.getElementById('dstatus');
  if (!el) return;
  el.textContent += (msg.result && msg.result.done)
    ? '\n✔ ダッシュボードに自動反映しました（分析画面をご確認ください）'
    : '\n（ダッシュボードが開いていないため未反映。保存したjsonlを「取得結果のドロップ」に入れてください）';
});

/* ---------------- ② プールから取得 ---------------- */
function parseManual() {
  const lines = $('manual').value.split(/\r?\n/).map((l) => l.trim().replace(/^@/, '')).filter(Boolean);
  return lines.length ? { handles: lines.map((h) => ({ handle: h, tags: '' })), runTag: 'manual' } : null;
}
function refreshRun() { const m = parseManual(); $('btnRun').disabled = !((queue && queue.handles && queue.handles.length) || (m && m.handles.length)); }
async function reloadQueue() {
  $('queueInfo').textContent = 'ダッシュボードからキュー取得中…';
  const r = await readDashboard('castnext_cdp_queue');
  if (r.error || !r.raw) { queue = null; $('queueInfo').textContent = r.error || 'ダッシュボードにキューがありません。casting-next で「キューを作る」を押してください。'; }
  else { try { const q = JSON.parse(r.raw); queue = (q.handles && q.handles.length) ? q : null;
    $('queueInfo').textContent = queue ? `キュー ${queue.handles.length}件（run: ${queue.runTag || '?'}）を読み込みました` : 'キューが空です。'; } catch { queue = null; $('queueInfo').textContent = 'キューの読取に失敗しました。'; } }
  refreshRun();
}
async function runPool() {
  const q = (queue && queue.handles && queue.handles.length) ? queue : parseManual();
  if (!q) { $('status').textContent = 'キューがありません。'; return; }
  const ig = await ensureIgTab();
  $('btnRun').disabled = true; $('status').textContent = `${q.handles.length}件の収集を開始…`;
  const unbind = bindProgress('barFill', 'status');
  try {
    const result = await chrome.tabs.sendMessage(ig.id, { type: 'IGF_COLLECT', payload: { handles: q.handles, runTag: q.runTag || 'run', src: '' } });
    unbind();
    if (!result || !result.ok) $('status').textContent = '失敗: ' + ((result && result.error) || '不明') ;
    else doneSummary('status', result);
  } catch (e) { unbind(); $('status').textContent = 'タブ送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを再読込して再実行してください。'; }
  finally { $('btnRun').disabled = false; }
}

/* ---------------- ① 発掘して収集 ---------------- */
function parseTags() {
  return $('dtags').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const life = l.startsWith('*'); const t = l.replace(/^\*/, '').trim();
    const tag = t.startsWith('#') ? t : '#' + t;
    return { tag, life };
  });
}
function refreshDiscover() { $('btnDiscover').disabled = parseTags().length === 0; }
async function reloadDiscoverTags() {
  const r = await readDashboard('castnext_cdp_discover');
  if (r.error || !r.raw) { $('dstatus').textContent = r.error || 'ダッシュボードの発掘設定が見つかりません。「①発掘から始める」タブでタグを選んでください。'; return; }
  try {
    const cfg = JSON.parse(r.raw);
    $('dtags').value = (cfg.tags || []).map((t) => (t.life ? '*' : '') + t.tag).join('\n');
    if (cfg.target) $('dtarget').value = cfg.target;
    window.__cdp_done = cfg.done || [];
    $('dstatus').textContent = `タグ${(cfg.tags || []).length}件・取得済み${(cfg.done || []).length}件を取り込みました。`;
  } catch { $('dstatus').textContent = '発掘設定の読取に失敗しました。'; }
  refreshDiscover();
}
async function runDiscover() {
  const tags = parseTags();
  if (!tags.length) { $('dstatus').textContent = 'タグを1つ以上入れてください。'; return; }
  const target = Number($('dtarget').value) || 100;
  // done は「ダッシュボードのタグを取り込む」で取得済み。無ければ空（＝全部新規扱い）
  let done = window.__cdp_done || [];
  if (!done.length) { const r = await readDashboard('castnext_cdp_discover'); try { done = JSON.parse(r.raw).done || []; } catch {} }
  const ig = await ensureIgTab();
  $('btnDiscover').disabled = true; $('dstatus').textContent = `${tags.length}タグの発掘を開始…`;
  const unbind = bindProgress('dbarFill', 'dstatus');
  try {
    const result = await chrome.tabs.sendMessage(ig.id, { type: 'IGF_DISCOVER', payload: { tags, target, done, runTag: 'disc' } });
    unbind();
    if (!result || !result.ok) $('dstatus').textContent = '失敗: ' + ((result && result.error) || '不明');
    else doneSummary('dstatus', result);
  } catch (e) { unbind(); $('dstatus').textContent = 'タブ送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを再読込して再実行してください。'; }
  finally { $('btnDiscover').disabled = false; }
}

/* ---------------- タブ切替・初期化 ---------------- */
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + t.dataset.pane));
});
$('btnReload').onclick = reloadQueue;
$('btnRun').onclick = runPool;
$('manual').oninput = refreshRun;
$('btnDReload').onclick = reloadDiscoverTags;
$('btnDiscover').onclick = runDiscover;
// タグ・目標件数はブラウザに保存して、次に開いたとき復元する（都度入力しなくてよい）
$('dtags').oninput = () => { refreshDiscover(); try { chrome.storage.local.set({ dtags: $('dtags').value }); } catch (e) {} };
$('dtarget').oninput = () => { refreshDiscover(); try { chrome.storage.local.set({ dtarget: $('dtarget').value }); } catch (e) {} };
try {
  chrome.storage.local.get(['dtags', 'dtarget'], (v) => {
    if (v && v.dtags && !$('dtags').value) $('dtags').value = v.dtags;
    if (v && v.dtarget) $('dtarget').value = v.dtarget;
    refreshDiscover();
  });
} catch (e) { /* noop */ }
reloadQueue();
refreshDiscover();
