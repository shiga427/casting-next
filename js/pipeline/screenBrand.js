/* ブランド公式疑いの隔離(設計書§6-1・指示書§2-2)。移植元:screen_brand.py。
 * 判定は3値:keep / keep_person(ayaka_official 型は残す)/ brand_susp(隔離)。
 * **隔離であって破棄ではない**。件数と理由を必ず残す(判断7の記録原則)。
 */

/* 強いブランド語:業態そのもの。人名が併記されていても法人アカウントである可能性が高い */
export const BRAND_STRONG = ["shop", "store", "clinic", "salon", "magazine", "_inc", "inc_", "corp", "kabushiki"];
/* 弱いブランド語:個人も使う。人名が読み取れれば残す */
export const BRAND_WEAK = ["official", "japan", "jp", "kr", "korea", "cosmetics", "cosmetic", "beautyhack"];

/* ローマ字日本語人名(given name)。ayaka_official 型を救うための最小辞書 */
export const NAMES = `
ai aika aiko aimi airi aki akane akari akemi aki akiko akira ami amane an ana ane anna aoi arisa asaka asami asuka atsuko aya ayaka ayako ayame ayane ayano ayumi
chiaki chie chieko chiharu chihiro chika chikako chiyo chiyuki
emi emiko emiri ena eri erika eriko etsuko
fumi fumika fumiko futaba
hana hanae hanako haru haruka haruko haruna haruhi hazuki hikari hikaru hina hinako hinata hiro hiroe hiroko hiromi hitomi honami hono honoka
ibuki ichika iku ikuko ikumi ina io ise itsuki izumi
juri junko jun
kae kaede kaho kana kanae kanako kanna kanon kaori kaoru karen kasumi kayo kazuha kazuko kazumi keiko kei kiho kiki kimiko kiyomi ko koharu kokoro koto kotoha kotomi kumi kumiko kurumi kyoko
madoka mai maiko maki makiko mako mami mamiko mana manaka manami mao mari maria marie mariko marina mariya masako mayu mayuko mayumi megu megumi mei mika mikako miki mikiko miku mimi mina minako minami minori mio misa misaki misako mitsuki miu miwa miwako miyu miyuki mizuki moe moeka moka momo momoka momoko mona mutsumi
na nagisa nami namie nana nanako nanami nao naoko naomi natsu natsuki natsuko natsumi nazuna nemu nene noa nodoka nozomi noriko
rei reika reiko ren rena riho rie rika rikako riko rin rina rinka rino rio riona risa risako ritsuko riyo rui rumi runa ruri ryoko
sachi sachiko sae saeko saki sakiko sakura sana sanae saori sara satoko satomi satsuki saya sayaka sayo sayuri seira sena shiho shiina shina shiori shizuka shoko sora sumire suzu suzuka
tae taeko takako tama tamaki tomoe tomoka tomoko tomomi toshiko tsubaki tsubasa tsukasa tsukushi
ui umi urara uta utako
wakana waka
yae yayoi yoko yori yoshie yoshiko yu yua yui yuika yuina yuka yukako yukari yuki yukiko yukino yuko yumi yumiko yuna yuri yurika yuriko yuu yuuka yuuki yuuna yuzu yuzuki
ken kenta kenji koji kota kouki daiki dai daisuke hiroshi haruto kaito makoto masa masaki naoya ryo ryota ryusei sho shota shun sota takumi taro tatsuya tomo tomoya yuta yuto yusuke wataru
`.trim().split(/\s+/);
const NAMESET = new Set(NAMES);

const SPLIT = /[^a-z0-9]+/;

/* ハンドルを英字トークンに割る。数字は落とす(usamimi080 → usamimi) */
export function tokens(handle) {
  const h = String(handle || "").toLowerCase();
  const out = [];
  h.split(SPLIT).filter(Boolean).forEach(p => {
    p.split(/\d+/).forEach(q => { if (q) out.push(q); });
  });
  return out;
}

/* 人名が読み取れるか。読み取れたらその名前を返す */
export function hasPersonName(handle) {
  const tk = tokens(handle);
  for (const t of tk) if (NAMESET.has(t)) return t;
  /* 連結表記(maryhatsumi / usamimi)は、先頭から既知の名前で始まり残りも2文字以上なら人名扱い */
  for (const t of tk) {
    if (t.length >= 6) {
      for (const n of NAMESET) {
        if (n.length >= 4 && t.startsWith(n) && t.length - n.length >= 2) return n;
      }
    }
  }
  return null;
}

export function screen(handle) {
  const h = String(handle || "").toLowerCase();
  const strong = BRAND_STRONG.filter(w => h.includes(w.replace(/^_+|_+$/g, "")));
  const tk = new Set(tokens(h));
  const weak = BRAND_WEAK.filter(w => tk.has(w) || (w.length > 3 && h.includes(w)));
  const person = hasPersonName(h);
  if (strong.length) return { verdict: "brand_susp", reason: "強ブランド語:" + strong.join(",") };
  if (weak.length) {
    if (person) return { verdict: "keep_person", reason: `ブランド語(${weak.join(",")})だが人名 '${person}' を検出 → 残す` };
    return { verdict: "brand_susp", reason: "ブランド語:" + weak.join(",") + " / 人名なし" };
  }
  return { verdict: "keep", reason: "" };
}

/* ハンドル一覧 → {keep[], brandSusp[]}。隔離件数は探索カバレッジの副産物欄に記録する */
export function screenAll(handles) {
  const keep = [], brandSusp = [];
  handles.forEach(h => {
    const handle = String(h || "").trim().replace(/^@/, "").toLowerCase();
    if (!handle) return;
    const r = screen(handle);
    (r.verdict === "brand_susp" ? brandSusp : keep).push({ handle, ...r });
  });
  return {
    keep, brandSusp,
    counts: {
      keep: keep.filter(r => r.verdict === "keep").length,
      keep_person: keep.filter(r => r.verdict === "keep_person").length,
      brand_susp: brandSusp.length
    }
  };
}
