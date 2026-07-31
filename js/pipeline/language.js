/* 言語判定(設計書§6-1)。移植元:igfinder/enrich.py の detect_language。
 * 文字種の比率から推定し、判定不能なら null(0や"unknown"で埋めない=§6-2 の7)。
 * 仮名が1文字でもまとまってあれば日本語(漢字は中国語と共有なので仮名を決定打にする)。
 */

const URL_RE = /https?:\/\/[^\s<>"'）)、,]+/gi;

export function detectLanguage(text) {
  if (!text) return null;
  let stripped = String(text).replace(URL_RE, " ");
  stripped = stripped.replace(/[#＃@][^\s]*/g, " ");

  const letters = [];
  for (const ch of stripped) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0);
    /* Python の str.isalpha() 相当:ASCII英字 or 0x2E80 超のCJK等 */
    if (/\p{L}/u.test(ch) || cp > 0x2E80) letters.push(ch);
  }
  if (letters.length < 2) return null;

  const counts = { kana: 0, hangul: 0, han: 0, thai: 0, cyrillic: 0, arabic: 0, latin: 0 };
  for (const ch of letters) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0xFF66 && cp <= 0xFF9D)) counts.kana++;
    else if ((cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x1100 && cp <= 0x11FF)) counts.hangul++;
    else if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) counts.han++;
    else if (cp >= 0x0E00 && cp <= 0x0E7F) counts.thai++;
    else if (cp >= 0x0400 && cp <= 0x04FF) counts.cyrillic++;
    else if (cp >= 0x0600 && cp <= 0x06FF) counts.arabic++;
    else if (cp < 128 && /[A-Za-z]/.test(ch)) counts.latin++;
  }

  const total = letters.length;
  if (counts.kana >= 1 && counts.kana / total > 0.02) return "ja";
  if (counts.hangul / total > 0.1) return "ko";
  if (counts.thai / total > 0.1) return "th";
  if (counts.cyrillic / total > 0.2) return "ru";
  if (counts.arabic / total > 0.2) return "ar";
  if (counts.han / total > 0.2) return "zh";
  if (counts.latin / total > 0.5) return "en";
  return null;
}
