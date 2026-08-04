/* 発掘(E1タグ探索)の取り込み — 設計書§2-1・§5-2。
 *
 * 「発掘から始める」モードでは、利用者はプールCSVを持っていない。
 * 取得結果の JSONL に入っている出所(src / tags)から、
 *   ① プール(次回のキュー生成の母集団)
 *   ② 取得済み台帳(次回の除外)
 *   ③ 探索カバレッジ表の該当タグ行(収集数・取得済)
 * を自動で更新し、2周目以降は「プールから取得」モードにそのまま繋げる。
 *
 * **ハンドルは常に記録する**(§2-1 判断11:収集の原則)。除外はせず後回しにするだけ。
 * DOM に触れない純関数。
 */

/* `E1:#アラサー美容` / `#アラサー美容` / `アラサー美容` → すべて `#アラサー美容` 形式に正規化 */
export function normalizeTag(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  const body = t.replace(/^E\d+\s*[:：]\s*/, "").trim();
  if (!body) return "";
  return body.startsWith("#") ? body : "#" + body;
}

/* run の1行から**探索タグ**を取り出す。
 * discovered_via は `E1:#タグ` 形式のときだけタグとして扱う(`run6:queue_v6` のような
 * 経路メモをカバレッジ表に混ぜないため)。matched_keywords は一致した語=タグそのもの。 */
export function tagsOfRow(row) {
  const out = [];
  const push = (v, requireMarker) => {
    String(v || "").split(/[|,]/).forEach(part => {
      const raw = String(part || "").trim();
      if (!raw) return;
      if (requireMarker && !/^E\d+\s*[:：]/.test(raw) && !raw.startsWith("#")) return;
      const t = normalizeTag(raw);
      if (t && !out.includes(t)) out.push(t);
    });
  };
  push(row.discovered_via, true);
  push(row.matched_keywords, false);
  return out;
}

/* 取得結果 run を、プール・取得済み台帳・カバレッジ表に取り込む。
 * 引数は壊さず、新しい配列を返す(呼び出し側で state に入れ替える)。 */
export function absorbRun(run, current) {
  const cur = current || {};
  const pool = (cur.pool || []).map(p => ({ ...p }));
  const coverage = (cur.coverage || []).map(r => ({ ...r }));
  const done = new Set((cur.done || []).map(h => String(h).toLowerCase()));
  const poolIndex = new Map(pool.map((p, i) => [String(p.handle).toLowerCase(), i]));

  const perTag = new Map();      // タグ → { collected:Set(handle), fetched:Set(handle) }
  let addedToPool = 0, addedToDone = 0;

  (run.rows || []).forEach(row => {
    const handle = String(row.username || "").toLowerCase();
    if (!handle) return;
    const tags = tagsOfRow(row);
    const tagText = tags.join("|");

    /* ① プールに追記(既にあればタグと出所を足すだけ。数値は上書きしない) */
    const at = poolIndex.get(handle);
    if (at == null) {
      pool.push({
        handle, tags: tagText, likes: "",
        discovered_via: row.discovered_via || tagText, runTag: run.runTag
      });
      poolIndex.set(handle, pool.length - 1);
      addedToPool++;
    } else {
      const p = pool[at];
      const merged = new Set(String(p.tags || "").split("|").filter(Boolean).concat(tags));
      p.tags = [...merged].join("|");
      if (!p.discovered_via) p.discovered_via = row.discovered_via || tagText;
    }

    /* ② 取得済み台帳(username で照合。run#6 不具合1の修正を固定) */
    if (!done.has(handle)) { done.add(handle); addedToDone++; }

    /* ③ タグ別の集計 */
    tags.forEach(t => {
      if (!perTag.has(t)) perTag.set(t, { collected: new Set(), fetched: new Set() });
      perTag.get(t).collected.add(handle);
      perTag.get(t).fetched.add(handle);
    });
  });

  /* ③ カバレッジ表の該当行を更新(無ければ行を作る。E1経路として記録) */
  const touched = [];
  perTag.forEach((v, tag) => {
    const bare = tag.replace(/^#/, "");
    let row = coverage.find(r => {
      const term = String(r.term || "").replace(/^#/, "");
      return term === bare;
    });
    if (!row) {
      row = { route: "E1", term: tag, collected: "", fetched: "", st: "未実行" };
      coverage.push(row);
    }
    row.collected = String((Number(row.collected) || 0) + v.collected.size);
    row.fetched = String((Number(row.fetched) || 0) + v.fetched.size);
    row.st = "完了";
    touched.push({ tag, collected: v.collected.size, fetched: v.fetched.size });
  });

  return {
    pool, coverage, done: [...done],
    addedToPool, addedToDone,
    tags: touched.sort((a, b) => b.fetched - a.fetched)
  };
}

/* 発掘の対象タグ(拡張へ渡す候補)。プロジェクトのプリセットから作る(ステムボーテ固定にしない) */
export function discoveryTags(preset) {
  const s = (preset && preset.search) || {};
  const tags = [];
  (s.e1_life_tags || []).forEach(t => { const n = normalizeTag(t); if (n && !tags.includes(n)) tags.push({ tag: n, life: true }); });
  (s.e1_tags || []).forEach(t => { const n = normalizeTag(t); if (n && !tags.some(x => x.tag === n)) tags.push({ tag: n, life: false }); });
  return tags;
}
