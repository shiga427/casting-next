/* __PROF — IGF.profile() の結果を ingest_compact.py が読む圧縮レコードに落とす。
 *
 * これが正本。引き継ぎ書に貼られたスニペットではなくこのファイルを注入すること。
 * キー名は ingest_compact.py の to_record() と1対1。**1文字でも変えると壊れる。**
 *
 * v2.7 の変更(run#6の定性評価の機械化に必要だった2点):
 *   cap の上限を 60字 → 140字          定性シグナルは「本文の引用」で作るため、
 *                                      60字では引用が語の途中で切れて使えなかった。
 *   prl / capl を追加                  `#PR` はキャプション末尾に付くので、切り詰めた
 *                                      テキストからは検出できない。**全文で判定して
 *                                      真偽値だけ持ち帰る。** capl は元の文字数。
 *
 * 転送量:12投稿 × 140字 ≒ 1.8KB/レコード。article ダンプは 15〜20レコードずつ。
 */
window.__R = window.__R || [];
window.__CAP = 140;                        /* キャプションの持ち帰り上限(140字以上を維持) */
window.__PRRE = /#\s*(PR|ＰＲ|pr|ad|AD|提供|タイアップ)|Paid partnership|提供いただ|いただきもの/i;

window.__PROF = function (res, tags, src) {
  var out = { h: res.handle, src: src || '', tags: tags || '', media: res.media_source || null };
  if (res.error) { out.err = res.error; return out; }
  var R = res.responses || [], u = null, posts = [];

  /* 全文でPR表記を判定してから切り詰める(順序が重要) */
  function pack(full, extra) {
    var t = String(full || '');
    var rec = { cap: t.slice(0, window.__CAP), capl: t.length, prl: window.__PRRE.test(t) };
    for (var k in extra) rec[k] = extra[k];
    return rec;
  }

  for (var i = 0; i < R.length; i++) {
    var b = R[i] && R[i].body; if (!b) continue;
    var w = b.data && (b.data.user || (b.data.xdt_api__v1__users__web_profile_info &&
                                       b.data.xdt_api__v1__users__web_profile_info.user));
    if (w && !u) {
      u = { un: w.username, fn: w.full_name, bio: w.biography,
            f: (w.edge_followed_by || {}).count, fg: (w.edge_follow || {}).count,
            mc: (w.edge_owner_to_timeline_media || {}).count,
            ext: w.external_url || '', priv: !!w.is_private, ver: !!w.is_verified, cat: null };
      var eg = ((w.edge_owner_to_timeline_media || {}).edges) || [];
      for (var j = 0; j < eg.length; j++) {
        var n = eg[j].node || {};
        var cap = (((n.edge_media_to_caption || {}).edges || [])[0] || { node: {} }).node.text || '';
        posts.push(pack(cap, {
          l: (n.edge_media_preview_like || n.edge_liked_by || {}).count,
          c: (n.edge_media_to_comment || {}).count,
          lv: false, cd: !!n.comments_disabled,
          t: n.taken_at_timestamp, mt: n.is_video ? 2 : 1,
          pp: !!n.is_paid_partnership
        }));
      }
    }
    if (b.user && !u) {
      var iu = b.user;
      u = { un: iu.username, fn: iu.full_name, bio: iu.biography, f: iu.follower_count,
            fg: iu.following_count, mc: iu.media_count, ext: iu.external_url || '',
            priv: !!iu.is_private, ver: !!iu.is_verified, cat: iu.category || null };
    }
    if (b.items && b.items.length && !posts.length) {
      var items = b.items.slice(0, 12);
      for (var k2 = 0; k2 < items.length; k2++) {
        var m = items[k2];
        posts.push(pack((m.caption || {}).text || '', {
          l: m.like_and_view_counts_disabled ? null : (m.like_count == null ? null : m.like_count),
          c: m.comment_count == null ? null : m.comment_count,
          lv: !!m.like_and_view_counts_disabled, cd: !!m.comments_disabled,
          t: m.taken_at, mt: m.media_type, pp: !!m.is_paid_partnership
        }));
      }
    }
  }
  if (!u) { out.err = 'no_user'; return out; }
  var ph = res.profile_hint || {};
  u.cat = u.cat || ph.category_name || ph.business_category_name || ph.category ||
          ph.category_enum || null;
  out.u = u; out.p = posts; out.rec = res.recovered_via || null; out.pk_via = res.pk_via || null;
  return out;
};
'__PROF ready cap=' + window.__CAP;
