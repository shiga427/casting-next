/* background.js — サービスワーカー。content_ig からの最終JSONLを受けて
 * ファイルとしてダウンロードする（chrome.downloads は content script から呼べないため）。
 * popup が閉じていても完了する。 */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'IGF_DONE_DOWNLOAD') return;
  const tag = (msg.runTag || 'run').replace(/[^\w.\-]/g, '_');
  // data URL でダウンロード（数百件でも軽量。外部送信は一切なし）
  const url = 'data:application/jsonl;charset=utf-8,' + encodeURIComponent(msg.jsonl || '');
  chrome.downloads.download({
    url,
    filename: `casting-next/${tag}_compact.jsonl`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
});
