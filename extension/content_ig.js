/* content_ig.js — instagram.com のタブ(分離ワールド)で動く収集ランナー。
 *
 * このファイルの前に igf/ig_probe.js と igf/prof_compact.js が注入され、
 * window.IGF と window.__PROF が同じ分離ワールドに定義されている（manifest 参照）。
 * 収集ロジックは kit の実装そのまま。ここは「メッセージを受けてループを回し、
 * 進捗を送り、最後に JSONL を background に渡してダウンロードさせる」配線だけ。
 *
 * 分離ワールドの fetch は instagram.com と同一オリジンなので Cookie が乗る
 * （＝ログインセッションでそのまま内部APIを叩ける）。DM/フォロー/いいねはしない。 */
(function () {
  'use strict';
  if (window.__CASTNEXT_RUNNER__) return; // 二重登録防止
  window.__CASTNEXT_RUNNER__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function collect(payload, onProgress) {
    const handles = payload.handles || [];
    const tags = String(payload.tags || '');
    const src = String(payload.src || '');
    const lo = payload.minWait == null ? 4000 : payload.minWait;
    const hi = payload.maxWait == null ? 12000 : payload.maxWait;

    if (typeof window.IGF === 'undefined' || typeof window.__PROF !== 'function') {
      return { ok: false, error: 'IGF未読込。instagram.com のタブで拡張が有効か確認してください。' };
    }
    // 誰のセッションで取るかを明示（呼び出し側が確認に使う）
    let viewer = null;
    try { viewer = await window.IGF.viewer(); } catch (e) { /* noop */ }
    if (!viewer || !viewer.logged_in) {
      return { ok: false, error: 'Instagram にログインしていません。' };
    }

    const records = [];
    const stats = { ok: 0, err: 0, byErr: {}, viewer: viewer.username || viewer.viewer_id };
    for (let i = 0; i < handles.length; i++) {
      const item = handles[i];
      const h = String((item && item.handle) || item || '').replace(/^@/, '').trim();
      if (!h) continue;
      if (i > 0) await sleep(lo + Math.random() * Math.max(0, hi - lo));
      let rec, err = null;
      try {
        const res = await window.IGF.profile(h);
        rec = window.__PROF(res, (item && item.tags) || tags, src);
        err = rec.err || res.error || null;
      } catch (e) {
        rec = { h, err: 'exception: ' + String(e && e.message).slice(0, 200) };
        err = rec.err;
      }
      records.push(rec);
      if (err) { stats.err++; stats.byErr[err] = (stats.byErr[err] || 0) + 1; }
      else stats.ok++;
      onProgress({ i: i + 1, n: handles.length, handle: h, err });
      if (err === 'rate_limited') { stats.stopped = 'rate_limited'; break; }
    }
    const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    return { ok: true, jsonl, stats, runTag: payload.runTag || '' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'IGF_COLLECT') return;
    collect(msg.payload || {}, (p) => {
      try { chrome.runtime.sendMessage({ type: 'IGF_PROGRESS', p }); } catch (e) { /* popup閉時 */ }
    }).then((result) => {
      // 最終結果は background に渡してダウンロードさせる（popupが閉じても完了する）
      if (result.ok) {
        chrome.runtime.sendMessage({
          type: 'IGF_DONE_DOWNLOAD',
          jsonl: result.jsonl, runTag: result.runTag, stats: result.stats,
        });
      }
      sendResponse(result);
    });
    return true; // 非同期応答
  });
})();
