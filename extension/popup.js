/* popup.js — キュー取得 → instagram.com タブへ収集指示 → 進捗表示。
 * 収集ループ本体は instagram.com タブ側(content_ig.js)で動くので、
 * popup を閉じても収集とダウンロードは完走する。 */
const $ = (id) => document.getElementById(id);
let queue = null; // { handles:[{handle,tags}], runTag, at }

function setStatus(t, warn) { const el = $('status'); el.textContent = t; el.classList.toggle('warn', !!warn); }
function setProgress(done, total) { $('barFill').style.width = total ? Math.round((done / total) * 100) + '%' : '0'; }

async function findTab(patterns) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && patterns.some((p) => t.url.startsWith(p)));
}

// ダッシュボードのタブから localStorage のキュー(素のハンドル列)を読む
async function loadQueueFromDashboard() {
  const tab = await findTab(['https://shiga427.github.io/casting-next']);
  if (!tab) return { error: 'ダッシュボードのタブが見つかりません。casting-next を開いて「キューを作る」を押してください。' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { try { return localStorage.getItem('castnext_cdp_queue'); } catch (e) { return null; } },
    });
    const raw = res && res.result;
    if (!raw) return { error: 'ダッシュボードにキューがありません。casting-next で「キューを作る」を押してください。' };
    const q = JSON.parse(raw);
    if (!q.handles || !q.handles.length) return { error: 'キューが空です。' };
    return { queue: q };
  } catch (e) {
    return { error: 'キュー読取に失敗: ' + (e && e.message) };
  }
}

function parseManual() {
  const lines = $('manual').value.split(/\r?\n/).map((l) => l.trim().replace(/^@/, '')).filter(Boolean);
  return lines.length ? { handles: lines.map((h) => ({ handle: h, tags: '' })), runTag: 'manual', at: '' } : null;
}

function refreshRunButton() {
  const m = parseManual();
  const has = (queue && queue.handles && queue.handles.length) || (m && m.handles.length);
  $('btnRun').disabled = !has;
}

async function reloadQueue() {
  $('queueInfo').textContent = 'ダッシュボードからキュー取得中…';
  const r = await loadQueueFromDashboard();
  if (r.error) { queue = null; $('queueInfo').innerHTML = r.error; }
  else {
    queue = r.queue;
    $('queueInfo').textContent = `キュー ${queue.handles.length}件（run: ${queue.runTag || '?'}）を読み込みました`;
  }
  refreshRunButton();
}

async function run() {
  const q = (queue && queue.handles && queue.handles.length) ? queue : parseManual();
  if (!q) { setStatus('キューがありません。', true); return; }

  let igTab = await findTab(['https://www.instagram.com/', 'https://instagram.com/']);
  if (!igTab) {
    setStatus('instagram.com のタブを開いています…');
    igTab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
    // content script が読み込まれるまで少し待つ
    await new Promise((r) => setTimeout(r, 4000));
  }

  $('btnRun').disabled = true;
  setStatus(`@${q.handles.length}件の収集を開始します…`);
  setProgress(0, q.handles.length);

  const onMsg = (msg) => {
    if (msg && msg.type === 'IGF_PROGRESS' && msg.p) {
      const { i, n, handle, err } = msg.p;
      setProgress(i, n);
      setStatus(`[${i}/${n}] ${handle} ${err ? 'NG(' + err + ')' : 'OK'}`);
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  try {
    const result = await chrome.tabs.sendMessage(igTab.id, {
      type: 'IGF_COLLECT',
      payload: { handles: q.handles, runTag: q.runTag || 'run', src: '' },
    });
    chrome.runtime.onMessage.removeListener(onMsg);
    if (!result || !result.ok) {
      setStatus('失敗: ' + ((result && result.error) || '不明なエラー'), true);
    } else {
      const s = result.stats || {};
      const errLines = Object.entries(s.byErr || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n');
      setStatus(
        `完了（@${s.viewer} で取得）\nOK ${s.ok} / NG ${s.err}` +
        (s.stopped ? `\n⚠ ${s.stopped} で中断（時間を置いて再実行で続きから）` : '') +
        (errLines ? '\n' + errLines : '') +
        `\n→ ダウンロード: ${(result.runTag || 'run')}_compact.jsonl\n次: ダッシュボードの「取得結果のドロップ」へこのファイルを入れてください`
      );
    }
  } catch (e) {
    chrome.runtime.onMessage.removeListener(onMsg);
    setStatus('タブへの送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを一度再読込してから、もう一度お試しください。', true);
  } finally {
    $('btnRun').disabled = false;
  }
}

$('btnReload').onclick = reloadQueue;
$('btnRun').onclick = run;
$('manual').oninput = refreshRunButton;
reloadQueue(); // popup を開くたびに現在のキューを取りにいく
