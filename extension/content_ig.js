/* content_ig.js — instagram.com のタブ(分離ワールド)で動く収集ランナー。
 *
 * この前に igf/ig_probe.js と igf/prof_compact.js が注入され、window.IGF と
 * window.__PROF が同じ分離ワールドに定義されている（manifest 参照）。
 * 取得ロジックは kit の実装そのまま。ここは配線＋発掘(タグ→ハンドル)だけを担う。
 *
 * 分離ワールドの fetch は instagram.com と同一オリジンなので Cookie が乗る。
 * DM/フォロー/いいね/投稿はしない。 */
(function () {
  'use strict';
  if (window.__CASTNEXT_RUNNER__) return;
  window.__CASTNEXT_RUNNER__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (lo, hi) => lo + Math.random() * Math.max(0, hi - lo);
  const firstBody = (r) => ((r && r.responses) || []).map((x) => x && x.body).find(Boolean) || null;

  // instagram.com ページ上に「実行中」バナーを出す（ポップアップを閉じても見える）
  function setBanner(text, kind) {
    let el = document.getElementById('__castnext_banner');
    if (!el) {
      el = document.createElement('div'); el.id = '__castnext_banner';
      el.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;color:#fff;'
        + 'font:600 13px/1.45 -apple-system,system-ui,sans-serif;padding:10px 14px;border-radius:10px;'
        + 'box-shadow:0 6px 20px rgba(0,0,0,.28);max-width:340px;pointer-events:none;white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.background = kind === 'error' ? '#b3261e' : (kind === 'done' ? '#1a7f4b' : '#6d1f3a');
    el.textContent = '🟣 Casting Next｜' + text;
  }
  function clearBanner(delay) {
    const el = document.getElementById('__castnext_banner'); if (!el) return;
    setTimeout(() => { try { el.remove(); } catch (e) { /* noop */ } }, delay || 0);
  }

  // ---------------- 発掘: タグ応答からハンドル＋いいね数を取り出す ----------------
  // 形は実データ(2026-08)で確認: data.top/recent.sections[].layout_content の
  //   fill_items[].media と one_by_two_item.clips.items[].media に user.username / like_count
  function harvestHashtag(body, tag) {
    const out = []; const data = body && body.data; if (!data) return out;
    const secs = [].concat((data.top && data.top.sections) || [], (data.recent && data.recent.sections) || []);
    for (const s of secs) {
      const lc = (s && s.layout_content) || {}; const medias = [];
      for (const it of (lc.fill_items || [])) if (it && it.media) medias.push(it.media);
      const clips = lc.one_by_two_item && lc.one_by_two_item.clips && lc.one_by_two_item.clips.items;
      for (const it of (clips || [])) if (it && it.media) medias.push(it.media);
      for (const m of medias) {
        const h = m.user && m.user.username;
        if (h) out.push({ handle: String(h).toLowerCase(), likes: (m.like_count == null ? null : m.like_count), tag });
      }
    }
    return out;
  }
  // topsearch の users[].user.username（いいね数は取れないので後回し扱い）
  function harvestSearch(body, tag) {
    const out = [];
    for (const u of ((body && body.users) || [])) {
      const un = u.user && u.user.username;
      if (un) out.push({ handle: String(un).toLowerCase(), likes: null, tag });
    }
    return out;
  }

  // 並べ替え規則は discovery_template.md の移植（Claudeの判断ではなく決定的ルール）:
  // 1 タグ横断が多い順 → 2 生活文脈タグ由来 → 3 いいね100〜8,000 → 4 いいね不明 → 5 法人語/媒体名は最後尾(捨てない)
  const CORP_RE = /(official|shop|store|salon|clinic|cosmetic|magazine|academy|corp|inc)/i;
  const BRAND_RE = /(chanel|dior|shiseido|canmake|^lips$|muji|voce|maquia)/i;
  const GENRE_RE = /(music|anime|game|idol|kpop)/i;
  const STOP = new Set(['the','beauty','cosme','life','daily','gram','days','labo','lab','happy','love','my','official','shop','store','salon','clinic','magazine','academy']);
  function isDeprioritized(handle) {
    const h = handle.toLowerCase();
    if (BRAND_RE.test(h)) return true;
    if (!(CORP_RE.test(h) || GENRE_RE.test(h))) return false;
    const parts = h.split(/[._]/).filter(Boolean);
    const nameLike = parts.some((p) => /^[a-z]{3,}$/.test(p) && !STOP.has(p) && !CORP_RE.test(p) && !GENRE_RE.test(p));
    return !nameLike; // 人名が読み取れれば救済（best-effort）
  }
  function rankCandidates(cands, lifeTags) {
    const byHandle = new Map();
    for (const c of cands) {
      let e = byHandle.get(c.handle);
      if (!e) { e = { handle: c.handle, tags: new Set(), likes: [] }; byHandle.set(c.handle, e); }
      e.tags.add(c.tag); if (c.likes != null) e.likes.push(c.likes);
    }
    const lifeSet = new Set(lifeTags || []);
    const arr = [...byHandle.values()].map((e) => {
      const likes = e.likes.length ? Math.max(...e.likes) : null;
      const inWindow = likes != null && likes >= 100 && likes <= 8000;
      return {
        handle: e.handle, tags: [...e.tags], likes,
        crossTag: e.tags.size, lifeOrigin: [...e.tags].some((t) => lifeSet.has(t)),
        likeRank: inWindow ? 0 : (likes != null ? 1 : 2), dep: isDeprioritized(e.handle),
      };
    });
    arr.sort((a, b) => (a.dep - b.dep) || (b.crossTag - a.crossTag)
      || ((a.lifeOrigin ? 0 : 1) - (b.lifeOrigin ? 0 : 1)) || (a.likeRank - b.likeRank) || ((b.likes || 0) - (a.likes || 0)));
    return arr;
  }

  async function ensureViewer() {
    if (typeof window.IGF === 'undefined' || typeof window.__PROF !== 'function') {
      return { ok: false, error: 'IGF未読込。instagram.com のタブで拡張が有効か確認してください。' };
    }
    let v = null; try { v = await window.IGF.viewer(); } catch (e) { /* noop */ }
    if (!v || !v.logged_in) return { ok: false, error: 'Instagram にログインしていません。' };
    return { ok: true, viewer: v };
  }

  // ---------------- 取得ループ（発掘・プール共通） ----------------
  async function collectHandles(items, opts, onProgress) {
    const lo = opts.minWait == null ? 4000 : opts.minWait;
    const hi = opts.maxWait == null ? 12000 : opts.maxWait;
    const records = []; const stats = { ok: 0, err: 0, byErr: {} };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const h = String((it && it.handle) || it || '').replace(/^@/, '').trim();
      if (!h) continue;
      if (i > 0) await sleep(jitter(lo, hi));
      const tagText = (it && it.tagText) || (opts.tags || '');
      const src = (it && it.src) || opts.src || '';
      let rec, err = null;
      try {
        const res = await window.IGF.profile(h);
        rec = window.__PROF(res, tagText, src);
        err = rec.err || res.error || null;
      } catch (e) { rec = { h, err: 'exception: ' + String(e && e.message).slice(0, 200) }; err = rec.err; }
      records.push(rec);
      if (err) { stats.err++; stats.byErr[err] = (stats.byErr[err] || 0) + 1; } else stats.ok++;
      onProgress({ phase: 'collect', i: i + 1, n: items.length, handle: h, err });
      if (err === 'rate_limited') { stats.stopped = 'rate_limited'; break; }
    }
    return { records, stats };
  }

  async function runCollect(payload, onProgress) {
    const v = await ensureViewer(); if (!v.ok) return v;
    const items = (payload.handles || []).map((x) => ({ handle: (x && x.handle) || x, tagText: (x && x.tags) || payload.tags || '', src: payload.src || '' }));
    const { records, stats } = await collectHandles(items, payload, onProgress);
    stats.viewer = v.viewer.username || v.viewer.viewer_id;
    return { ok: true, jsonl: records.map((r) => JSON.stringify(r)).join('\n') + '\n', stats, runTag: payload.runTag || 'run' };
  }

  async function runDiscover(payload, onProgress) {
    const v = await ensureViewer(); if (!v.ok) return v;
    const tags = payload.tags || [];              // [{tag, life}]
    const lifeTags = tags.filter((t) => t.life).map((t) => t.tag);
    const done = new Set((payload.done || []).map((h) => String(h).replace(/^@/, '').toLowerCase()));
    const cands = [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i].tag;
      if (i > 0) await sleep(jitter(2500, 5000));
      try {
        const hr = await window.IGF.hashtag(tag); cands.push(...harvestHashtag(firstBody(hr), tag));
        const sr = await window.IGF.search(tag); cands.push(...harvestSearch(firstBody(sr), tag));
      } catch (e) { /* このタグはスキップ */ }
      onProgress({ phase: 'discover', i: i + 1, n: tags.length, handle: tag, found: cands.length });
    }
    const ranked = rankCandidates(cands, lifeTags);
    const fresh = ranked.filter((r) => !done.has(r.handle));     // 取得済みは②から除外（記録はしている）
    const target = payload.target || 100;
    const pick = fresh.slice(0, target).map((r) => ({ handle: r.handle, tagText: r.tags.join('|'), src: 'E1:' + r.tags.join('|') }));
    onProgress({ phase: 'discover_done', discovered: ranked.length, fresh: fresh.length, picked: pick.length });
    const { records, stats } = await collectHandles(pick, payload, onProgress);
    stats.viewer = v.viewer.username || v.viewer.viewer_id;
    stats.discovered = ranked.length; stats.fresh = fresh.length; stats.picked = pick.length;
    return { ok: true, jsonl: records.map((r) => JSON.stringify(r)).join('\n') + '\n', stats, runTag: payload.runTag || 'run' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || (msg.type !== 'IGF_COLLECT' && msg.type !== 'IGF_DISCOVER')) return;
    const onProgress = (p) => {
      try { chrome.runtime.sendMessage({ type: 'IGF_PROGRESS', p }); } catch (e) { /* popup閉 */ }
      if (p.phase === 'discover') setBanner(`発掘中 ${p.i}/${p.n}（候補 ${p.found}）`);
      else if (p.phase === 'discover_done') setBanner(`発掘完了：取得対象 ${p.picked}件。取得を開始…`);
      else if (p.phase === 'collect') setBanner(`取得中 ${p.i}/${p.n}｜@${p.handle}${p.err ? ' NG' : ''}`);
    };
    setBanner('開始しています…');
    (async () => {
      try {
        const result = msg.type === 'IGF_DISCOVER'
          ? await runDiscover(msg.payload || {}, onProgress)
          : await runCollect(msg.payload || {}, onProgress);
        if (result && result.ok) {
          const s = result.stats || {};
          setBanner(`完了 ✓ OK ${s.ok} / NG ${s.err}${s.stopped ? '（' + s.stopped + 'で中断）' : ''}\n→ ダウンロード＆ダッシュボード反映`, s.stopped ? 'error' : 'done');
          clearBanner(9000);
          try { chrome.runtime.sendMessage({ type: 'IGF_DONE_DOWNLOAD', jsonl: result.jsonl, runTag: result.runTag, stats: result.stats }); } catch (e) { /* noop */ }
        } else {
          setBanner('失敗: ' + ((result && result.error) || '不明'), 'error'); clearBanner(12000);
        }
        sendResponse(result || { ok: false, error: '結果が空です' });
      } catch (e) {
        setBanner('例外で停止しました', 'error'); clearBanner(12000);
        sendResponse({ ok: false, error: 'content_ig例外: ' + String((e && (e.stack || e.message)) || e).slice(0, 500) });
      }
    })();
    return true; // 非同期応答
  });
})();
