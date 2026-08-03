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

  // ---------------- 精査データ収集（全文キャプ・コメント・bio。140字に切り詰めない） ----------------
  function igAppId() { const m = document.documentElement.innerHTML.match(/"X-IG-App-ID"\s*:\s*"(\d+)"/); return m ? m[1] : '936619743392459'; }
  async function igFetch(url) {
    try {
      const r = await fetch(url, { headers: { 'X-IG-App-ID': igAppId(), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }, credentials: 'include', referrer: location.href });
      const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch (e) { /* noop */ }
      return { status: r.status, body: b };
    } catch (e) { return { status: 0, error: String(e) }; }
  }
  // IGF.profile の raw レスポンスから、全文キャプション付きの投稿配列を作る（taken_at降順・上位12）
  function fullPosts(res) {
    const posts = []; const R = res.responses || [];
    for (const rr of R) {
      const b = rr && rr.body; if (!b) continue;
      const w = b.data && (b.data.user || (b.data.xdt_api__v1__users__web_profile_info && b.data.xdt_api__v1__users__web_profile_info.user));
      if (w && w.edge_owner_to_timeline_media) {
        for (const e of (w.edge_owner_to_timeline_media.edges || [])) {
          const n = e.node || {};
          posts.push({
            code: n.shortcode, media_id: n.id, taken_at: n.taken_at_timestamp, media_type: n.is_video ? 2 : 1,
            like: (n.edge_media_preview_like || {}).count, comment: (n.edge_media_to_comment || {}).count,
            paid: !!n.is_paid_partnership, comments_disabled: !!n.comments_disabled,
            caption: (((n.edge_media_to_caption || {}).edges || [{ node: {} }])[0] || { node: {} }).node.text || '',
          });
        }
      }
      if (b.items && b.items.length) {
        for (const m of b.items) {
          posts.push({
            code: m.code, media_id: m.pk || m.id || '', taken_at: m.taken_at, media_type: m.media_type,
            like: m.like_and_view_counts_disabled ? null : m.like_count, comment: m.comment_count,
            paid: !!m.is_paid_partnership, comments_disabled: !!m.comments_disabled,
            caption: (m.caption || {}).text || '',
          });
        }
      }
    }
    const seen = new Set(); const uniq = [];
    for (const p of posts) { if (!p.code || seen.has(p.code)) continue; seen.add(p.code); uniq.push(p); }
    uniq.sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0));
    return uniq.slice(0, 12);
  }
  function fullProfile(res) {
    for (const rr of (res.responses || [])) {
      const b = rr && rr.body; if (!b) continue;
      const w = b.data && (b.data.user || (b.data.xdt_api__v1__users__web_profile_info && b.data.xdt_api__v1__users__web_profile_info.user));
      if (w) return { full_name: w.full_name, biography: w.biography, followers: (w.edge_followed_by || {}).count, following: (w.edge_follow || {}).count, media_count: (w.edge_owner_to_timeline_media || {}).count, external: w.external_url || '', bio_links: (w.bio_links || []).map((x) => x.url).filter(Boolean) };
      if (b.user) { const u = b.user; return { full_name: u.full_name, biography: u.biography, followers: u.follower_count, following: u.following_count, media_count: u.media_count, external: u.external_url || '', bio_links: [] }; }
    }
    return null;
  }
  // コメント欄の生JSONは形が一定でないので、username+text を持つノードを木探索で拾う（形無依存）
  function walkComments(body) {
    const out = [];
    (function w(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(w); return; }
      if (typeof o.text === 'string' && o.user && o.user.username) out.push({ username: o.user.username, text: o.text, created: o.created_at || o.created_at_utc || 0 });
      for (const k in o) w(o[k]);
    })(body);
    // 重複除去（同一 username+text）
    const seen = new Set(); const uniq = [];
    for (const c of out) { const k = c.username + '' + c.text; if (seen.has(k)) continue; seen.add(k); uniq.push(c); }
    uniq.sort((a, b) => (a.created || 0) - (b.created || 0));
    return uniq;
  }
  async function fetchComments(mediaId) {
    if (!mediaId) return [];
    const r = await igFetch('/api/v1/media/' + encodeURIComponent(mediaId) + '/comments/?can_support_threading=true&permalink_enabled=false');
    return r.body ? walkComments(r.body).slice(0, 50) : [];
  }
  function ymd(ts) { if (!ts) return '????-??-??'; return new Date(ts * 1000).toISOString().slice(0, 10); }
  function typeName(mt) { return mt === 2 ? 'reel' : (mt === 8 ? 'carousel' : 'photo'); }
  const today10 = () => new Date().toISOString().slice(0, 10);
  function buildCaptions(handle, pk, posts) {
    let out = `# handle=${handle} pk=${pk || ''} 直近12投稿(taken_at降順) 取得 ${today10()}\n# キャプションは API が返した全文をそのまま記載(切り詰めなし)\n\n`;
    posts.forEach((p, i) => {
      out += `[${i + 1}] ${ymd(p.taken_at)} like=${p.like == null ? '?' : p.like} comment=${p.comment == null ? '?' : p.comment} type=${typeName(p.media_type)} paid=${p.paid}\n`;
      out += `code=${p.code || ''} media_id=${p.media_id || ''} taken_at=${p.taken_at || ''} media_type=${p.media_type || ''} comments_disabled=${p.comments_disabled} cap_len=${(p.caption || '').length}\n`;
      out += (p.caption || '') + '\n';
      if (i < posts.length - 1) out += '---\n';
    });
    return out;
  }
  function buildProfile(handle, prof) {
    let out = `# handle=${handle} プロフィール 取得 ${today10()}\n`;
    out += `full_name = ${(prof && prof.full_name) || ''}\n`;
    out += `followers = ${prof && prof.followers != null ? prof.followers : ''}\n`;
    out += `following = ${prof && prof.following != null ? prof.following : ''}\n`;
    out += `media_count = ${prof && prof.media_count != null ? prof.media_count : ''}\n\n`;
    const links = (prof && prof.bio_links && prof.bio_links.length) ? prof.bio_links.join('\n') : ((prof && prof.external) || '');
    out += `[bio_links]\n${links}\n\n`;
    out += `[biography 全文]\n${(prof && prof.biography) || ''}\n`;
    return out;
  }
  function buildComments(handle, byPost) {
    let out = `# handle=${handle} コメント欄(上位4投稿×最大50件) 取得 ${today10()}\n\n`;
    let idx = 0, any = false;
    for (const bp of byPost) {
      for (const c of bp.comments) {
        idx++; any = true;
        const own = c.username && c.username.toLowerCase() === handle.toLowerCase();
        out += `--- #${idx}  user=@${c.username || '?'}  own_reply=${own ? 'YES' : 'no'}  post=${bp.code}\n${c.text || ''}\n`;
      }
    }
    if (!any) out += '(コメントを取得できませんでした)\n';
    return out;
  }
  async function runQual(payload, onProgress) {
    const v = await ensureViewer(); if (!v.ok) return v;
    const handles = (payload.handles || []).slice(0, payload.target || 2);
    const files = []; const stats = { ok: 0, err: 0, byErr: {} };
    for (let i = 0; i < handles.length; i++) {
      const h = String(handles[i]).replace(/^@/, '').trim(); if (!h) continue;
      if (i > 0) await sleep(jitter(payload.minWait == null ? 4000 : payload.minWait, payload.maxWait == null ? 12000 : payload.maxWait));
      onProgress({ phase: 'qual', i: i + 1, n: handles.length, handle: h });
      try {
        const res = await window.IGF.profile(h);
        if (res.error) { stats.err++; stats.byErr[res.error] = (stats.byErr[res.error] || 0) + 1; if (res.error === 'rate_limited') { stats.stopped = 'rate_limited'; break; } continue; }
        const prof = fullProfile(res); const posts = fullPosts(res); const pk = (posts[0] && posts[0].media_id) || '';
        const top4 = [...posts].filter((p) => p.media_id && !p.comments_disabled).sort((a, b) => (b.like || 0) - (a.like || 0)).slice(0, 4);
        const byPost = [];
        for (const p of top4) { await sleep(jitter(1500, 3500)); byPost.push({ code: p.code, comments: await fetchComments(p.media_id) }); }
        files.push({ name: h + '_captions.txt', text: buildCaptions(h, pk, posts) });
        files.push({ name: h + '_profile.txt', text: buildProfile(h, prof) });
        files.push({ name: h + '_comments.txt', text: buildComments(h, byPost) });
        stats.ok++;
      } catch (e) { stats.err++; stats.byErr.exception = (stats.byErr.exception || 0) + 1; }
    }
    stats.viewer = v.viewer.username || v.viewer.viewer_id; stats.handles = handles.length;
    return { ok: true, qualFiles: files, firstHandle: (handles[0] || '').replace(/^@/, ''), stats, runTag: 'qual' };
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
    if (!msg || (msg.type !== 'IGF_COLLECT' && msg.type !== 'IGF_DISCOVER' && msg.type !== 'IGF_QUAL')) return;
    const onProgress = (p) => {
      try { chrome.runtime.sendMessage({ type: 'IGF_PROGRESS', p }); } catch (e) { /* popup閉 */ }
      if (p.phase === 'discover') setBanner(`発掘中 ${p.i}/${p.n}（候補 ${p.found}）`);
      else if (p.phase === 'discover_done') setBanner(`発掘完了：取得対象 ${p.picked}件。取得を開始…`);
      else if (p.phase === 'collect') setBanner(`取得中 ${p.i}/${p.n}｜@${p.handle}${p.err ? ' NG' : ''}`);
      else if (p.phase === 'qual') setBanner(`精査データ収集 ${p.i}/${p.n}｜@${p.handle}`);
    };
    setBanner('開始しています…');
    (async () => {
      try {
        const result = msg.type === 'IGF_QUAL' ? await runQual(msg.payload || {}, onProgress)
          : msg.type === 'IGF_DISCOVER' ? await runDiscover(msg.payload || {}, onProgress)
          : await runCollect(msg.payload || {}, onProgress);
        if (result && result.ok) {
          const s = result.stats || {};
          if (msg.type === 'IGF_QUAL') {
            setBanner(`精査データ完了 ✓ ${s.ok}名分（NG ${s.err}）${s.stopped ? '（中断）' : ''}\n→ 保存＆精査画面へ`, s.stopped ? 'error' : 'done');
            clearBanner(9000);
            try { chrome.runtime.sendMessage({ type: 'IGF_QUAL_DONE', files: result.qualFiles, firstHandle: result.firstHandle, stats: result.stats }); } catch (e) { /* noop */ }
          } else {
            setBanner(`完了 ✓ OK ${s.ok} / NG ${s.err}${s.stopped ? '（' + s.stopped + 'で中断）' : ''}\n→ ダウンロード＆ダッシュボード反映`, s.stopped ? 'error' : 'done');
            clearBanner(9000);
            try { chrome.runtime.sendMessage({ type: 'IGF_DONE_DOWNLOAD', jsonl: result.jsonl, runTag: result.runTag, stats: result.stats }); } catch (e) { /* noop */ }
          }
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
