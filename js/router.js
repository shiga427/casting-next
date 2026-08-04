/* ハッシュルーティング(設計書§3)。GitHub Pages はサーバ側リライトができないため
 * `#/dash` 形式にする。1画面=1モジュール(js/views/*.js)。 */

export const ROUTES = [
  { group: "実績", path: "dash", label: "概要", view: "dash" },
  { group: "実績", path: "board", label: "候補ボード", view: "board" },
  { group: "実績", path: "kanban", label: "パイプライン", view: "kanban" },
  { group: "分析", path: "analysis", label: "分析結果(run別)", view: "analysis" },
  { group: "分析", path: "qual", label: "精査・定性評価", view: "qual" },
  { group: "分析", path: "coverage", label: "探索カバレッジ", view: "coverage" },
  { group: "分析", path: "revive", label: "敗者復活", view: "revive" },
  { group: "運用", path: "collect", label: "収集(発掘と取得)", view: "collect" },
  { group: "運用", path: "io", label: "データ入出力", view: "io" },
  { group: "運用", path: "settings", label: "設定・基準", view: "settings" },
  { group: "運用", path: "oplog", label: "運用ログ", view: "oplog" },
  /* group が空のものはナビに出さない(初回ウィザード用の隠しルート) */
  { group: "", path: "setup", label: "はじめの設定", view: "onboarding" },
];

export function currentRoute() {
  const raw = (location.hash || "#/dash").replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const route = ROUTES.find(r => r.path === path) || ROUTES[0];
  const params = new URLSearchParams(query || "");
  return { ...route, params };
}

export function go(path, params) {
  const q = params ? "?" + new URLSearchParams(params).toString() : "";
  const next = "#/" + path + q;
  if (location.hash === next) {
    /* 同じ画面にいるときは hashchange が飛ばないので、明示的に再描画させる
       (分析結果を開いたまま2つ目のファイルをドロップしても更新されるように) */
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  location.hash = next;
}

export function onRoute(fn) {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}
