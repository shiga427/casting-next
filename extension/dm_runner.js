/* dm_runner.js — DM送付ループの本体(設計書_DM自動一括送付_v1.0 §5-2・§6)。
 *
 * ★なぜ content_ig.js から切り出すか
 *   送付は**書き込み操作**で、レート制御・日次上限・キルスイッチ・重複ガードの
 *   どれか1つでも壊れると不可逆な事故になる(§0-1・§10)。
 *   IGへの実アクセス(resolveUserId / sendDirect / openDraft)を全て**外から注入**する形にして、
 *   ループそのものを tools/e2e_dm_dryrun.mjs で stub 実行・検証できるようにしている。
 *   ここは DOM も chrome API も直接触らない。
 *
 * ★このファイルは instagram.com のタブと Node の両方で読まれる(classic script)。
 *   window が無い環境では globalThis に付ける。
 */
(function (root) {
  'use strict';

  /* 既定値の正本はダッシュボードの js/pipeline/conf.js。
   * ここはキューに値が載っていなかったときのフォールバック(拡張だけで暴走させないため)。 */
  var DEFAULTS = { minWaitMs: 45000, maxWaitMs: 90000, perMinMax: 1, dailyCap: 30 };
  var MIN_WINDOW_MS = 60000;   /* perMinMax を数える窓(1分) */

  /* 安全側クランプ。**緩める向きの指定を受け付けない**(§6-1)。
   * 待機は伸ばす方向だけ、上限は下げる方向だけを通す。 */
  function clampPayload(p) {
    var o = p || {};
    var n = function (v, d) { return (v == null || isNaN(Number(v))) ? d : Number(v); };
    var minWaitMs = Math.max(DEFAULTS.minWaitMs, n(o.minWaitMs, DEFAULTS.minWaitMs));
    var maxWaitMs = Math.max(minWaitMs, Math.max(DEFAULTS.maxWaitMs, n(o.maxWaitMs, DEFAULTS.maxWaitMs)));
    return {
      items: (o.items || []).slice(),
      mode: o.mode === 'auto' ? 'auto' : 'semi',      /* 既定は半自動(§5-1) */
      dryRun: !!o.dryRun,
      minWaitMs: minWaitMs, maxWaitMs: maxWaitMs,
      perMinMax: Math.max(1, Math.min(DEFAULTS.perMinMax, n(o.perMinMax, DEFAULTS.perMinMax))),
      dailyCap: Math.max(0, Math.min(DEFAULTS.dailyCap, n(o.dailyCap, DEFAULTS.dailyCap))),
    };
  }

  /* 監査ログ用の本文要約(§6-6・§10)。本文全文をログに残さない */
  function textHash(text) {
    var t = String(text || '');
    return 'len=' + t.length + ':' + t.slice(0, 120).replace(/\s+/g, ' ');
  }

  /* スパム判定・チェックポイントの検出(§5-3)。1件でも踏んだらその回は全停止する */
  var CHALLENGE_RE = /(challenge|checkpoint|spam|feedback_required|consent_required|login_required)/i;
  function isChallenge(res) {
    if (!res) return false;
    if (res.spam_or_challenge) return true;
    var blob = '';
    try { blob = JSON.stringify(res); } catch (e) { blob = String(res.reason || ''); }
    return CHALLENGE_RE.test(blob);
  }

  /* ループ本体。deps で IG アクセスと時間を注入する:
   *   sleep(ms) / now() / random() / isAborted() / onProgress(p)
   *   resolveUserId(handle) -> userId | null
   *   sendDirect(userId, text) -> { ok, threadId, reason, spam_or_challenge }
   *   openDraft(item)         -> { ok, reason }      ※半自動。**送信はしない**
   *   dailyCount()            -> 本日すでに送った件数(拡張側の二重ガード・§6-2)
   *   onSent(record)          -> 送信成功のたびに呼ぶ(日次カウンタの永続化)
   */
  async function runDm(payload, deps) {
    var p = clampPayload(payload);
    var d = deps || {};
    var sleep = d.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var now = d.now || function () { return Date.now(); };
    var random = d.random || Math.random;
    var isAborted = d.isAborted || function () { return false; };
    var onProgress = d.onProgress || function () { };
    var results = [], log = [], stamps = [];
    var stats = {
      mode: p.mode, dryRun: p.dryRun, n: p.items.length,
      attempted: 0, sent: 0, draft: 0, failed: 0, skipped: 0, waitedMs: 0, stopped: '',
    };

    /* 本日の既送数(§6-2)。ダッシュボードのカウントを信用しきらず拡張側でも数える */
    var already = 0;
    try { already = Number((d.dailyCount ? await d.dailyCount() : 0)) || 0; } catch (e) { already = 0; }
    stats.alreadySentToday = already;

    function record(it, userId, result, extra) {
      var rec = {
        at: new Date(now()).toISOString(), handle: it.handle, userId: userId || '',
        mode: p.mode, dryRun: p.dryRun, result: result, textHash: textHash(it.text),
      };
      if (extra && extra.threadId) rec.threadId = extra.threadId;
      log.push(rec);
      results.push(rec);
      return rec;
    }

    /* 半自動は **Instagramに1回もアクセスしない**（下書きをキューに積むだけ。
     * 宛先は ig.me/m/<handle> で開くので user_id の解決も要らない）。
     * アクセスしないものにレート制御は要らないので、待機と user_id 解決は auto のときだけ行う。
     * ※これはレート制限の緩和ではない。半自動で45〜90秒待っても抑制する通信が存在しない
     *   （下書き30件で最大45分かかるだけで、得るものが無い）。 */
    var needsIg = (p.mode === 'auto');

    for (var i = 0; i < p.items.length; i++) {
      var it = p.items[i];

      /* 日次上限(§6-2)。実送信のみを数える。ドライラン・下書きは消費しない */
      if (!p.dryRun && p.mode === 'auto' && (stats.sent + already) >= p.dailyCap) { stats.stopped = 'daily_cap'; break; }
      /* キルスイッチ(§6-5)。ループ先頭で毎回検査する */
      if (isAborted()) { stats.stopped = 'aborted'; break; }

      /* レート制御(§6-1)。ドライランでも待つ(「レート待機まで行う」= §6-4)。
         半自動は通信が無いので待たない(needsIg) */
      if (needsIg && i > 0) {
        var w = Math.round(p.minWaitMs + random() * Math.max(0, p.maxWaitMs - p.minWaitMs));
        stats.waitedMs += w;
        onProgress({ phase: 'dm_wait', i: i + 1, n: p.items.length, handle: it.handle, waitMs: w });
        await sleep(w);
        if (isAborted()) { stats.stopped = 'aborted'; break; }
        /* 1分あたり perMinMax 通の上限。待ち時間が短いパターンでも窓で頭を押さえる */
        for (var guard = 0; guard < 10; guard++) {
          var t = now();
          var recent = stamps.filter(function (s) { return t - s < MIN_WINDOW_MS; });
          if (recent.length < p.perMinMax) break;
          var extra = MIN_WINDOW_MS - (t - recent[0]) + 1;
          stats.waitedMs += extra;
          await sleep(extra);
        }
      }
      stamps.push(now());
      stats.attempted++;
      onProgress({ phase: 'dm', i: i + 1, n: p.items.length, handle: it.handle });

      /* user_id は auto のときだけ要る。収集済みがあればそれを使い、無ければ1回だけ引く(§5-3)。
         半自動は handle で開くので解決しない(＝新規IGアクセス0) */
      var userId = it.userId || '';
      if (needsIg) {
        if (!userId) {
          try { userId = (d.resolveUserId ? await d.resolveUserId(it.handle) : '') || ''; } catch (e) { userId = ''; }
        }
        if (!userId) {
          stats.failed++; record(it, '', 'failed:no_user_id');
          onProgress({ phase: 'dm_result', i: i + 1, n: p.items.length, handle: it.handle, ok: false, result: 'failed:no_user_id' });
          continue;
        }
      }

      /* ドライラン(§6-4):user_id解決・文面確定・レート待機まで行い、**送信APIを呼ばない** */
      if (p.dryRun) {
        stats.skipped++; record(it, userId, 'dryrun');
        onProgress({ phase: 'dm_result', i: i + 1, n: p.items.length, handle: it.handle, ok: true, result: 'dryrun' });
        continue;
      }

      /* 半自動(§5-1):スレッドを開いて本文を流し込むところまで。**送信ボタンは人が押す**。
         人が送ったかは分からないので status は進めず draft に留める(§7)。 */
      if (p.mode === 'semi') {
        var dr = { ok: false, reason: 'no_open_draft' };
        try { dr = (d.openDraft ? await d.openDraft(it, userId) : dr) || dr; } catch (e) { dr = { ok: false, reason: String(e && e.message) }; }
        if (dr.ok) { stats.draft++; record(it, userId, 'draft'); }
        else { stats.failed++; record(it, userId, 'failed:' + (dr.reason || 'draft_failed')); }
        onProgress({ phase: 'dm_result', i: i + 1, n: p.items.length, handle: it.handle, ok: !!dr.ok, result: dr.ok ? 'draft' : 'failed' });
        continue;
      }

      /* === auto: 実送信 === */
      var res = null;
      try { res = await d.sendDirect(userId, it.text); } catch (e) { res = { ok: false, reason: 'exception:' + String(e && e.message).slice(0, 200) }; }
      if (isChallenge(res)) {
        /* スパム判定・チェックポイントを1件でも踏んだらその回は全停止。握りつぶさない(§10) */
        stats.failed++; record(it, userId, 'failed:challenge');
        stats.stopped = 'challenge';
        onProgress({ phase: 'dm_result', i: i + 1, n: p.items.length, handle: it.handle, ok: false, result: 'challenge' });
        break;
      }
      if (res && res.ok) {
        stats.sent++;
        var rec = record(it, userId, 'ok', { threadId: res.threadId });
        try { if (d.onSent) await d.onSent(rec); } catch (e) { /* カウンタ更新失敗でループは止めない */ }
        onProgress({ phase: 'dm_result', i: i + 1, n: p.items.length, handle: it.handle, ok: true, result: 'ok' });
      } else {
        stats.failed++;
        record(it, userId, 'failed:' + String((res && res.reason) || 'unknown').slice(0, 80));
        onProgress({ phase: 'dm_result', i: i + 1, n: p.items.length, handle: it.handle, ok: false, result: 'failed' });
      }
    }
    return { ok: true, results: results, log: log, stats: stats };
  }

  root.__CASTNEXT_DM = { runDm: runDm, clampPayload: clampPayload, textHash: textHash, isChallenge: isChallenge, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
