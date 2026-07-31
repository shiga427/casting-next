/* 自前SVGチャート(設計書§3):ドーナツ・横棒・スパークラインの3種だけ。
 * 外部CDNに依存しない。色はトークン(css/tokens.css)から取る。 */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* items: [{label, value, color}] / center: {title, sub} */
export function donut(items, center, size = 110) {
  const data = items.filter(i => i.value > 0);
  const total = data.reduce((s, i) => s + i.value, 0);
  const R = 15.9155;              /* 円周が 100 になる半径 */
  let offset = 25;                /* 12時から開始 */
  const rings = data.map(i => {
    const pct = total ? (i.value / total) * 100 : 0;
    const dash = `${pct.toFixed(2)} ${(100 - pct).toFixed(2)}`;
    const el = `<circle cx="21" cy="21" r="${R}" fill="none" stroke="${i.color}" stroke-width="6" stroke-dasharray="${dash}" stroke-dashoffset="${offset.toFixed(2)}"/>`;
    offset -= pct;
    return el;
  }).join("");
  const legend = items.map(i => `<div><i style="background:${i.color}"></i>${esc(i.label)}<b>${i.value}</b></div>`).join("");
  return `<div class="donut">
    <svg width="${size}" height="${size}" viewBox="0 0 42 42" role="img" aria-label="${esc(center && center.title || "")}">
      <circle cx="21" cy="21" r="${R}" fill="none" stroke="#F0E9E0" stroke-width="6"/>
      ${rings}
      <text x="21" y="20" text-anchor="middle" font-size="${(center && center.title || "").length > 4 ? 5 : 6}" font-weight="800" fill="#2B2430">${esc(center && center.title || "")}</text>
      <text x="21" y="27" text-anchor="middle" font-size="4.4" fill="#857A82">${esc(center && center.sub || "")}</text>
    </svg>
    <div class="legend">${legend}</div>
  </div>`;
}

/* items: [{label, value, key}] — クリックで詳細を開く(data-key を使う) */
export function hbar(items, opts) {
  const o = opts || {};
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="hbar">` + items.map(i => `
    <div class="row" data-key="${esc(i.key ?? i.label)}" title="クリックで該当ハンドルを表示">
      <span class="lab">${esc(i.label)}</span>
      <span class="track"><span class="fill" style="width:${(i.value / max * 100).toFixed(1)}%"></span></span>
      <span class="n">${i.value}</span>
    </div>
    <div class="detail" data-detail="${esc(i.key ?? i.label)}" hidden></div>`).join("") +
    (o.note ? `<div class="note">${esc(o.note)}</div>` : "") + `</div>`;
}

/* ファネル(取得100 → 帯内35 → … → 機械合格13) */
export function funnel(steps) {
  const max = Math.max(1, ...steps.map(s => s.value));
  return `<div class="funnel">` + steps.map((s, i) => `
    <div class="row">
      <span class="lab">${esc(s.label)}</span>
      <span class="bar${i === steps.length - 1 ? " on" : ""}" style="width:${Math.max(2, s.value / max * 100).toFixed(1)}%"></span>
      <b>${s.value}</b>${s.note ? `<span class="note" style="margin:0 0 0 8px">${esc(s.note)}</span>` : ""}
    </div>`).join("") + `</div>`;
}

/* スパークライン(run別の推移。値が2点未満なら描かない) */
export function sparkline(values, width = 120, height = 28, color = "#6D2E46") {
  const v = values.filter(x => typeof x === "number");
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v), span = (max - min) || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1) * width).toFixed(1)},${(height - (x - min) / span * height).toFixed(1)}`).join(" ");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><polyline fill="none" stroke="${color}" stroke-width="1.6" points="${pts}"/></svg>`;
}
