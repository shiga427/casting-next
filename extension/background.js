/* background.js — サービスワーカー。
 *  ① content_ig からの最終JSONLをファイルにダウンロード（記録・バックアップ）
 *  ② ダッシュボードのタブが開いていれば、そこへ自動で流し込んで解析まで走らせる
 * chrome.downloads / chrome.scripting は content script から呼べないのでここで行う。
 * popup が閉じていても完了する。 */

// ダッシュボードのタブ内(MAIN world)で実行される関数。
// 収集画面の隠しファイル入力に File を差し込み、change を発火して既存の取り込み処理に載せる。
// （ダッシュボードのコードは変更しない。ドラッグ&ドロップと同じ経路を再現するだけ）
async function injectResult(jsonl, filename) {
  function tryImport() {
    const input = document.getElementById('file');
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([jsonl], filename, { type: 'application/jsonl' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (tryImport()) return 'ok';
  // 収集ビュー以外なら収集画面へ移動して1回だけ再試行
  if (!String(location.hash).startsWith('#/collect')) location.hash = '#/collect';
  await new Promise((r) => setTimeout(r, 1000));
  return tryImport() ? 'ok-after-nav' : 'no-input';
}

// 精査の3ファイル（先頭ハンドル分）を精査画面の隠しファイル入力に差し込む（ドロップ再現）
async function injectQualFiles(files) {
  function tryImport() {
    const input = document.getElementById('fileQual');
    if (!input) return false;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (tryImport()) return 'ok';
  if (!String(location.hash).startsWith('#/qual')) location.hash = '#/qual';
  await new Promise((r) => setTimeout(r, 1000));
  return tryImport() ? 'ok-after-nav' : 'no-input';
}

async function autoImportQual(files) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://shiga427.github.io/casting-next*'] });
    if (!tabs || !tabs.length) return { done: false, reason: 'no-dashboard-tab' };
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, world: 'MAIN', func: injectQualFiles, args: [files] });
    return { done: (res && (res.result === 'ok' || res.result === 'ok-after-nav')), result: res && res.result };
  } catch (e) { return { done: false, reason: String(e && e.message) }; }
}

async function autoImport(jsonl, filename) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://shiga427.github.io/casting-next*'] });
    if (!tabs || !tabs.length) return { done: false, reason: 'no-dashboard-tab' };
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id }, world: 'MAIN', func: injectResult, args: [jsonl, filename],
    });
    return { done: (res && (res.result === 'ok' || res.result === 'ok-after-nav')), result: res && res.result };
  } catch (e) {
    return { done: false, reason: String(e && e.message) }; // 失敗してもDL済みなので手動ドロップで復旧可
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  // 進捗をツールバーのアイコンにバッジ表示（どのタブを見ていても分かる）
  if (msg && msg.type === 'IGF_PROGRESS' && msg.p) {
    const p = msg.p;
    chrome.action.setBadgeBackgroundColor({ color: '#6d1f3a' });
    if (p.phase === 'discover') { chrome.action.setBadgeText({ text: '🔍' }); chrome.action.setTitle({ title: `発掘中 ${p.i}/${p.n}（候補${p.found || 0}）` }); }
    else if (p.phase === 'discover_done') { chrome.action.setBadgeText({ text: '…' }); chrome.action.setTitle({ title: `発掘完了 取得対象${p.picked}件` }); }
    else if (p.phase === 'collect') { chrome.action.setBadgeText({ text: String(p.i) }); chrome.action.setTitle({ title: `取得中 ${p.i}/${p.n}｜@${p.handle}` }); }
    else if (p.phase === 'qual') { chrome.action.setBadgeText({ text: '📝' }); chrome.action.setTitle({ title: `精査データ収集 ${p.i}/${p.n}｜@${p.handle}` }); }
    return;
  }
  // 精査3ファイル: 全件ダウンロード＋先頭ハンドルを精査画面へ自動反映
  if (msg && msg.type === 'IGF_QUAL_DONE') {
    const files = msg.files || [];
    for (const f of files) {
      chrome.downloads.download({
        url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(f.text || ''),
        filename: 'casting-next/qual/' + String(f.name).replace(/[^\w.\-]/g, '_'), saveAs: false, conflictAction: 'uniquify',
      });
    }
    const st = msg.stats || {};
    chrome.action.setBadgeBackgroundColor({ color: st.stopped ? '#b3261e' : '#1a7f4b' });
    chrome.action.setBadgeText({ text: st.stopped ? '!' : '✓' });
    chrome.action.setTitle({ title: `精査データ完了 ${st.ok || 0}名分` });
    setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (e) { /* noop */ } }, 20000);
    const first = String(msg.firstHandle || '').toLowerCase();
    const firstFiles = files.filter((f) => String(f.name).toLowerCase().startsWith(first + '_'));
    autoImportQual(firstFiles).then((r) => { try { chrome.runtime.sendMessage({ type: 'IGF_AUTOIMPORT', result: r, qual: true }); } catch (e) { /* noop */ } });
    return;
  }
  if (!msg || msg.type !== 'IGF_DONE_DOWNLOAD') return;
  const st = msg.stats || {};
  chrome.action.setBadgeBackgroundColor({ color: st.stopped ? '#b3261e' : '#1a7f4b' });
  chrome.action.setBadgeText({ text: st.stopped ? '!' : '✓' });
  chrome.action.setTitle({ title: `完了 OK ${st.ok || 0} / NG ${st.err || 0}` });
  setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (e) { /* noop */ } }, 20000);
  const tag = (msg.runTag || 'run').replace(/[^\w.\-]/g, '_');
  const filename = tag + '_compact.jsonl';
  const jsonl = msg.jsonl || '';
  // ① ダウンロード（バックアップ・記録）
  chrome.downloads.download({
    url: 'data:application/jsonl;charset=utf-8,' + encodeURIComponent(jsonl),
    filename: 'casting-next/' + filename, saveAs: false, conflictAction: 'uniquify',
  });
  // ② ダッシュボードへ自動反映（開いていれば）。結果を popup に通知（開いていれば表示）
  autoImport(jsonl, filename).then((r) => {
    try { chrome.runtime.sendMessage({ type: 'IGF_AUTOIMPORT', result: r }); } catch (e) { /* noop */ }
  });
});
