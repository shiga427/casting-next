/**
 * T2: Browser Driver — Claude in Chrome の `javascript_tool` で評価するヘルパ群.
 *
 * 設計書 2.2 の優先順位を素直に実装する:
 *   1. 内部API JSON（ページ自身の fetch を使うので Cookie / CSRF / App-ID が自動で乗る）
 *   2. 埋め込みJSON（__additionalData / ld+json / RelayPrefetchedStreamCache）
 *   3. DOM テキスト
 *
 * 使い方（Claude in Chrome 側）:
 *   1) instagram.com のタブでこのファイルの内容を評価して window.IGF を定義
 *   2) `await IGF.profile('handle')` などを評価し、返った JSON を保存して
 *      `igfinder profile --payload <file>` に流し込む
 *
 * 設計上のポイント: DOM をクリック/スクロールする `computer` 操作は最終手段。
 * ここでページ内 fetch を使うことで、1アカウント = 1〜2リクエストに抑えられる。
 */
(function () {
  'use strict';

  // Instagram Web の公開 App ID。取れない場合のフォールバックとして保持する。
  const FALLBACK_APP_ID = '936619743392459';

  function findAppId() {
    // ページ内のスクリプトから X-IG-App-ID を拾う（バージョン差異に強い）
    const patterns = [
      /"X-IG-App-ID"\s*:\s*"(\d+)"/,
      /"appId"\s*:\s*"(\d+)"/,
      /X-IG-App-ID['"]?\s*[:=]\s*['"](\d+)['"]/,
    ];
    const html = document.documentElement.innerHTML;
    for (const re of patterns) {
      const m = html.match(re);
      if (m) return m[1];
    }
    return FALLBACK_APP_ID;
  }

  function headers() {
    return {
      'X-IG-App-ID': findAppId(),
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    };
  }

  async function getJSON(url) {
    const res = await fetch(url, {
      headers: headers(),
      credentials: 'include',
      referrer: location.href,
    });
    const status = res.status;
    let body = null;
    let text = null;
    try {
      text = await res.text();
      body = JSON.parse(text);
    } catch (e) {
      body = null;
    }
    return { url, status, ok: res.ok, body, raw: body ? null : (text || '').slice(0, 2000) };
  }

  /** 埋め込みJSON（フォールバック #2）を集める。 */
  function embeddedJSON() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      try {
        out.push(JSON.parse(el.textContent));
      } catch (e) {
        /* ignore */
      }
    });
    document.querySelectorAll('script[type="application/json"]').forEach((el) => {
      const text = el.textContent || '';
      if (text.length > 2_000_000) return;
      if (!/username|edge_followed_by|follower_count/.test(text)) return;
      try {
        out.push(JSON.parse(text));
      } catch (e) {
        /* ignore */
      }
    });
    return out;
  }

  /** DOM テキスト（フォールバック #3）。 */
  function domText() {
    return (document.body ? document.body.innerText : '').slice(0, 20000);
  }

  const IGF = {
    version: '1.0.0',
    appId: findAppId,

    /**
     * Phase2 の主役: プロフィール + 直近投稿（通常12件）を1リクエストで取得。
     * 設計書リスク#1「内部APIレスポンスの形」と #3「いいね/コメント取得可否」を
     * ここで同時に解決する（投稿を開かずにグリッド分の like/comment が入る）。
     */
    async profile(handle) {
      const username = String(handle).replace(/^@/, '').trim();
      const primary = await getJSON(
        '/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username)
      );
      // run#3 実測: Instagram が HTTP 400 +
      //   {"status":"fail","message":"Asset asset://laser.provider/ig_business_category_subvertical
      //    has been deleted..."}
      // を返すことがある(run#3 では100件中33件)。この場合 primary.body は **存在してしまう** ため、
      // `if (!primary.body)` のフォールバックが発火せず、取得枠がそのまま欠測になっていた。
      // → JSON が返っていても「中身がユーザーではない」場合は失敗扱いにしてフォールバックへ落とす。
      const primaryFailed =
        !primary.body ||
        primary.body.status === 'fail' ||
        (primary.status >= 400 && !(primary.body.data && primary.body.data.user));

      const result = {
        _igf: 'profile',
        handle: username,
        fetched_at: new Date().toISOString(),
        responses: [primary],
        embedded: primaryFailed ? embeddedJSON() : [],
        dom_text: primaryFailed ? domText() : null,
      };
      if (primaryFailed) {
        result.error = primary.status === 404 ? 'not_found' : 'no_json';
        if (primary.status === 429 || primary.status === 401) result.error = 'rate_limited';
        if (primary.body && primary.body.status === 'fail') result.error = 'schema_error';

        // 復旧経路: web_profile_info がスキーマエラーでも、pk が分かれば
        // /api/v1/users/<pk>/info/ は別スキーマなので生きていることがある。
        // pk は埋め込みJSON か、ユーザー名検索から拾う。
        let pk = null;
        const m = document.documentElement.innerHTML.match(
          new RegExp('"username"\\s*:\\s*"' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                     '"[^}]*?"(?:id|pk)"\\s*:\\s*"?(\\d+)'));
        if (m) pk = m[1];
        if (!pk) {
          const s = await getJSON('/api/v1/users/web_profile_info/?username=' +
                                  encodeURIComponent(username) + '&__a=1');
          const su = s.body && s.body.data && s.body.data.user;
          if (su) pk = su.id || su.pk;
        }
        // run#4 §2-1 の未適用改修を run#6 で適用:pk 解決に検索経路を足す。
        // run#3b の復旧18件は上の2経路が両方空振りし、その場しのぎの差し替えで回していた。
        // run#6 実測:/api/v1/fbsearch/topsearch/ は 404(廃止)。/web/search/topsearch/ が 200 を返す。
        if (!pk) {
          for (const url of ['/web/search/topsearch/?context=blended&query=',
                             '/api/v1/fbsearch/account_serp/?query=']) {
            const s2 = await getJSON(url + encodeURIComponent(username));
            if (!s2.body) continue;
            const found = [];
            (function walk(o) {
              if (!o || typeof o !== 'object') return;
              if (Array.isArray(o)) { o.forEach(walk); return; }
              if (o.username && (o.pk || o.id)) found.push(o);
              for (const k in o) walk(o[k]);
            })(s2.body);
            const hit = found.find(u => String(u.username).toLowerCase() === username.toLowerCase());
            if (hit) { pk = String(hit.pk || hit.id); result.pk_via = 'search'; break; }
          }
        }
        if (pk) {
          const info = await getJSON('/api/v1/users/' + encodeURIComponent(String(pk)) + '/info/');
          result.responses.push(info);
          if (info.body && info.body.user) {
            result.recovered_via = 'users_info';
            result.error = null;
            // users/info はキー名が別系統。extract が読む形に寄せる。
            const iu = info.body.user;
            result.profile_hint = {
              username: iu.username || username,
              category_name: iu.category || iu.account_category || null,
              business_category_name: null,
              category_enum: null,
              category: iu.category || iu.account_category || null,
              is_business_account: iu.is_business == null ? null : !!iu.is_business,
              is_professional_account: iu.is_professional_account == null ? null : !!iu.is_professional_account,
              is_verified: iu.is_verified == null ? null : !!iu.is_verified,
              _from: 'users_info',
            };
            const feed2 = await getJSON('/api/v1/feed/user/' + encodeURIComponent(String(pk)) + '/?count=12');
            result.responses.push(feed2);
            result.media_source = feed2.body ? 'v1_feed' : 'none';
          }
        }
        return result;
      }

      // 実測（2026-07）: web_profile_info が `edge_owner_to_timeline_media.edges` を
      // **空配列**で返すことがある。プロフィールは取れているのに投稿指標が丸ごと
      // 欠ける状態なので、v1 のユーザーフィードで補う。
      const user =
        (primary.body.data &&
          (primary.body.data.user ||
            (primary.body.data.xdt_api__v1__users__web_profile_info &&
              primary.body.data.xdt_api__v1__users__web_profile_info.user))) ||
        null;
      const edges =
        (user && user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
      const pk = user && (user.id || user.pk);
      // v2.3 判断9: v1_feed へフォールバックするとカテゴリ系フィールドが落ちるため、
      // web_profile_info 側のユーザーノードから先に抜き出して result に持たせる。
      // **追加リクエストはしない**（このレスポンスは既に取得済み）。
      if (user) {
        result.profile_hint = {
          username: user.username || null,
          category_name: user.category_name || null,
          business_category_name: user.business_category_name || null,
          category_enum: user.category_enum || null,
          category: user.category || null,
          is_business_account: user.is_business_account == null ? null : !!user.is_business_account,
          is_professional_account:
            user.is_professional_account == null ? null : !!user.is_professional_account,
          is_verified: user.is_verified == null ? null : !!user.is_verified,
          _from: 'web_profile_info',
        };
      }
      if (edges.length === 0 && pk && !user.is_private) {
        const feed = await getJSON('/api/v1/feed/user/' + encodeURIComponent(String(pk)) + '/?count=12');
        result.responses.push(feed);
        result.media_source = feed.body ? 'v1_feed' : 'none';
      } else {
        result.media_source = edges.length ? 'web_profile_info' : 'none';
      }
      return result;
    },

    /**
     * 投稿をもっと取りたい場合（posts_sampled > 12）。
     * end_cursor でページングする。呼びすぎるとレート制限に当たるので必要時のみ。
     */
    async moreMedia(userId, after, count) {
      const variables = {
        id: String(userId),
        first: count || 12,
        after: after || null,
      };
      const res = await getJSON(
        '/graphql/query/?query_hash=e769aa130647d2354c40ea6a439bfc08&variables=' +
          encodeURIComponent(JSON.stringify(variables))
      );
      return { _igf: 'media_page', user_id: String(userId), responses: [res] };
    },

    /** Phase1: keyword_search 経路。「アカウント」タブ相当の結果を JSON で取る。 */
    async search(keyword) {
      const query = encodeURIComponent(keyword);
      const attempts = [
        '/api/v1/fbsearch/topsearch/?context=blended&query=' + query,
        '/web/search/topsearch/?context=blended&query=' + query,
        '/api/v1/fbsearch/account_serp/?query=' + query,
      ];
      const responses = [];
      for (const url of attempts) {
        const res = await getJSON(url);
        responses.push(res);
        if (res.body) break;
      }
      return {
        _igf: 'search',
        keyword: keyword,
        surface: 'keyword_search',
        fetched_at: new Date().toISOString(),
        responses: responses,
      };
    },

    /** Phase1: hashtag_from_keyword 経路。ハッシュタグ投稿の投稿者を集める。 */
    async hashtag(tag) {
      const name = String(tag).replace(/^#/, '').trim();
      const attempts = [
        '/api/v1/tags/web_info/?tag_name=' + encodeURIComponent(name),
        '/explore/tags/' + encodeURIComponent(name) + '/?__a=1&__d=dis',
      ];
      const responses = [];
      for (const url of attempts) {
        const res = await getJSON(url);
        responses.push(res);
        if (res.body) break;
      }
      return {
        _igf: 'hashtag',
        keyword: '#' + name,
        surface: 'hashtag_from_keyword',
        fetched_at: new Date().toISOString(),
        responses: responses,
      };
    },

    /** Phase1（拡張）: related_accounts 経路。有力アカウントから芋づる式に広げる。 */
    async related(userId) {
      const res = await getJSON(
        '/api/v1/discover/chaining/?target_id=' + encodeURIComponent(String(userId))
      );
      return {
        _igf: 'related',
        surface: 'related_accounts',
        target_id: String(userId),
        fetched_at: new Date().toISOString(),
        responses: [res],
      };
    },

    /** 複数ハンドルをレート制御しながら順次取得（1回の評価で数件まとめる用）。 */
    async profileBatch(handles, minDelayMs, maxDelayMs) {
      const lo = minDelayMs == null ? 4000 : minDelayMs;
      const hi = maxDelayMs == null ? 12000 : maxDelayMs;
      const out = [];
      for (let i = 0; i < handles.length; i++) {
        if (i > 0) {
          const wait = lo + Math.random() * (hi - lo);
          await new Promise((r) => setTimeout(r, wait));
        }
        try {
          const record = await IGF.profile(handles[i]);
          out.push(record);
          if (record.error === 'rate_limited') break; // 以降は打ち切って次回に回す
        } catch (e) {
          out.push({ _igf: 'profile', handle: handles[i], error: String(e) });
        }
      }
      return out;
    },

    /**
     * ログイン中のアカウントを特定する。ブラウザ操作の前に必ず呼び、
     * 「誰のセッションでデータを取るか」をユーザーに提示して許可を得る。
     */
    async viewer() {
      const html = document.documentElement.innerHTML;
      let id = (document.cookie.match(/ds_user_id=(\d+)/) || [])[1] || null;
      if (!id) {
        id = (html.match(/"viewerId"\s*:\s*"(\d+)"/) || html.match(/"actorID"\s*:\s*"(\d+)"/) || [])[1] || null;
      }
      const out = { logged_in: !!id, viewer_id: id };
      if (!id) return out;
      const r = await getJSON('/api/v1/users/' + id + '/info/');
      const u = r.body && (r.body.user || (r.body.data && r.body.data.user));
      if (u) {
        out.username = u.username;
        out.full_name = u.full_name;
        out.followers = u.follower_count;
        out.is_private = u.is_private;
      }
      return out;
    },

    // ---------------- 過去投稿の一括収集（グロース診断用） ----------------
    // javascript_tool は 45 秒でタイムアウトするため、1回の評価では数ページだけ進め、
    // 収集済みの行はページ側に溜め続ける。落ちても溜まった分は残り、次回は続きから。
    rows: [],
    _next: null,
    _started: false,

    /**
     * 過去投稿を maxPages 分だけ進めて収集する。何度も呼んで進捗を進める。
     * 返り値は 'collected=N more=y/n' の短い文字列（出力長制限を避けるため）。
     */
    async collect(pk, maxPages, delayMs) {
      const limit = maxPages || 4;
      const wait = delayMs == null ? 1500 : delayMs;
      let pages = 0;
      while (pages < limit) {
        if (IGF._started && !IGF._next) break; // 収集完了
        let url = '/api/v1/feed/user/' + encodeURIComponent(String(pk)) + '/?count=50';
        if (IGF._started && IGF._next) url += '&max_id=' + encodeURIComponent(IGF._next);
        const res = await getJSON(url);
        if (!res.body) { IGF._lastError = 'status ' + res.status; break; }
        IGF._started = true;
        const items = res.body.items || [];
        for (const n of items) {
          const cap = (n.caption && n.caption.text) || '';
          const cm = n.clips_metadata || {};
          IGF.rows.push({
            code: n.code,
            ts: n.taken_at,
            media_type: n.media_type,
            product_type: n.product_type || '',
            like: n.like_and_view_counts_disabled ? null : (n.like_count == null ? null : n.like_count),
            comment: n.comment_count == null ? null : n.comment_count,
            play: n.play_count != null ? n.play_count : (n.view_count != null ? n.view_count : null),
            pinned: (n.timeline_pinned_user_ids || []).length > 0,
            duration: n.video_duration ? Math.round(n.video_duration * 10) / 10 : null,
            audio: cm.original_sound_info ? 'orig' : (cm.music_info ? 'music' : (n.has_audio ? 'unknown' : 'none')),
            cap_len: cap.length,
            tags: (cap.match(/[#＃][^\s#＃]+/g) || []).length,
            slides: (n.carousel_media || []).length,
            coauthors: (n.coauthor_producers || []).length,
            title_len: (n.title || '').length,
          });
        }
        IGF._next = res.body.next_max_id || null;
        pages++;
        if (!IGF._next || items.length === 0) break;
        await new Promise(r => setTimeout(r, wait));
      }
      return 'collected=' + IGF.rows.length + ' more=' + (IGF._next ? 'y' : 'n');
    },

    /** 重複除去して IGF.posts を作る。ピン留めは既定で除外（表示順が先頭なだけで直近ではない）。 */
    finalize(includePinned) {
      const seen = new Set();
      const all = [];
      for (const r of IGF.rows) {
        if (seen.has(r.code)) continue;
        seen.add(r.code);
        all.push(r);
      }
      IGF.pinnedCount = all.filter(r => r.pinned).length;
      IGF.posts = includePinned ? all : all.filter(r => !r.pinned);
      IGF.posts.sort((a, b) => b.ts - a.ts);
      const ts = IGF.posts.map(r => r.ts);
      return 'unique=' + all.length + ' used=' + IGF.posts.length + ' pinned_excluded=' + IGF.pinnedCount
        + ' oldest=' + new Date(Math.min.apply(null, ts) * 1000).toISOString().slice(0, 10)
        + ' newest=' + new Date(Math.max.apply(null, ts) * 1000).toISOString().slice(0, 10);
    },

    // ---------------- 集計ヘルパ ----------------
    // 生データを持ち帰るのは出力長制限で不可能なので、集計はページ内で行い要約だけ返す。
    med(list) {
      const s = list.filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b);
      if (!s.length) return null;
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
    },
    mean(list) {
      const s = list.filter(v => typeof v === 'number' && !isNaN(v));
      return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
    },
    month(p) { return new Date(p.ts * 1000).toISOString().slice(0, 7); },
    hourJST(p) { return new Date((p.ts + 32400) * 1000).getUTCHours(); },
    dowJST(p) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date((p.ts + 32400) * 1000).getUTCDay()]; },
    isReel(p) { return p.product_type === 'clips'; },

    /**
     * グループ別に n / 中央値を出す。keyFn でグループ化、posts は既定で IGF.posts。
     * 平均ではなく中央値を主にするのは、上位数本が総再生の大半を占めるため。
     */
    group(keyFn, posts) {
      const src = posts || IGF.posts;
      const g = {};
      for (const p of src) { const k = String(keyFn(p)); (g[k] = g[k] || []).push(p); }
      return Object.keys(g).sort().map(k => k + ' n=' + g[k].length
        + ' like_med=' + IGF.med(g[k].map(p => p.like))
        + ' cmt_med=' + IGF.med(g[k].map(p => p.comment))
        + ' view_med=' + IGF.med(g[k].map(p => p.play))).join('\n');
    },

    /**
     * ★交絡チェック。グループごとに「どの月に出現したか」を並べる。
     * 出現時期が重なっていないグループ同士は比較できない。運用が上達している
     * アカウントでは、新しい習慣ほど何でも良く見えてしまうため。
     */
    confound(keyFn, posts) {
      const src = posts || IGF.posts;
      const g = {};
      for (const p of src) { const k = String(keyFn(p)); (g[k] = g[k] || []).push(p); }
      return Object.keys(g).sort().map(k => {
        const ms = [...new Set(g[k].map(IGF.month))].sort();
        return k + ' n=' + g[k].length + ' months=' + ms[0] + '..' + ms[ms.length - 1] + ' (' + ms.length + 'mo)';
      }).join('\n');
    },

    /** 交絡を除いた比較: 期間と他変数を filterFn で固定してから keyFn で切る。 */
    controlled(keyFn, filterFn, posts) {
      return IGF.group(keyFn, (posts || IGF.posts).filter(filterFn));
    },

    /** 再生数バケット別のいいね率。「届いているが刺さっていない」を可視化する。 */
    conversionLadder(posts) {
      const src = (posts || IGF.posts).filter(p => IGF.isReel(p) && p.play);
      const buckets = [[0, 1000], [1000, 5000], [5000, 20000], [20000, 100000], [100000, 500000], [500000, 1e12]];
      return buckets.map(b => {
        const a = src.filter(p => p.play >= b[0] && p.play < b[1]);
        if (!a.length) return null;
        const rates = a.map(p => Math.round((p.like || 0) / p.play * 1e6) / 1e4);
        return b[0] + '-' + b[1] + ' n=' + a.length + ' like%=' + IGF.med(rates.map(x => x * 1000)) / 1000
          + ' like_med=' + IGF.med(a.map(p => p.like)) + ' cmt_med=' + IGF.med(a.map(p => p.comment));
      }).filter(Boolean).join('\n');
    },

    /** ページ内の全ハンドルを DOM から拾う（JSON が取れなかったときの探索の保険）。 */
    harvestHandles() {
      const reserved = new Set([
        'explore', 'reels', 'reel', 'p', 'tv', 'stories', 'accounts', 'direct',
        'about', 'legal', 'privacy', 'terms', 'api', 'graphql', 'web', 's',
      ]);
      const set = new Set();
      document.querySelectorAll('a[href^="/"], a[href*="instagram.com/"]').forEach((a) => {
        const m = a.getAttribute('href').match(/^(?:https?:\/\/(?:www\.)?instagram\.com)?\/([A-Za-z0-9._]{1,30})\/?(?:$|\?)/);
        if (m && !reserved.has(m[1].toLowerCase())) set.add(m[1].toLowerCase());
      });
      return Array.from(set);
    },

    /** 遅延ロードを進める（設計書「最終手段」に相当。回数を明示的に絞る）。 */
    async scroll(times, pauseMs) {
      const n = times || 5;
      const pause = pauseMs || 1500;
      let before = document.body.scrollHeight;
      let unchanged = 0;
      for (let i = 0; i < n; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((r) => setTimeout(r, pause));
        const after = document.body.scrollHeight;
        if (after === before) {
          unchanged += 1;
          if (unchanged >= 2) break; // 連続で伸びなければ打ち切り（Phase1 停止条件）
        } else {
          unchanged = 0;
        }
        before = after;
      }
      return { scrolled: true, height: document.body.scrollHeight, handles: IGF.harvestHandles() };
    },
  };

  window.IGF = IGF;
  return { ok: true, version: IGF.version, appId: IGF.appId(), url: location.href };
})();
