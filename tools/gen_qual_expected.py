#!/usr/bin/env python3
"""精査・定性評価(P6)の期待値を **Python版 qual_report.py そのもの** から作る。

  python3 tools/gen_qual_expected.py [--ref ../reference]

入力: tests/fixtures/sample_qual_{captions,comments,profile}.txt(匿名化済み)
出力: tests/fixtures/qual_expected.json(語りの向き・引用・コメント統計・PR件数)
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ref_idx = sys.argv.index("--ref") if "--ref" in sys.argv else -1
REF = Path(sys.argv[ref_idx + 1]) if ref_idx > 0 else ROOT.parent / "reference"
FIX = ROOT / "tests" / "fixtures"
HANDLE = "sample_qual"

sys.path.insert(0, str(REF / "igf_scripts"))
from igfinder import qualsignals as Q  # noqa: E402

qr_path = REF / "qual_report.py"
if not qr_path.exists():
    raise SystemExit(f"移植元がありません: {qr_path}")

# qual_report.py は import すると main() を走らせて終了するので、関数だけを取り出す
src = qr_path.read_text(encoding="utf-8").split("def main()")[0]
ns: dict = {"__file__": str(qr_path)}
exec(compile(src, str(qr_path), "exec"), ns)

with tempfile.TemporaryDirectory() as tmp:
    out_dir = Path(tmp) / "成果物_fixture"
    out_dir.mkdir()
    for kind in ("captions", "comments", "profile"):
        src_file = FIX / f"{HANDLE}_{kind}.txt"
        if src_file.exists():
            shutil.copyfile(src_file, out_dir / f"定性_{HANDLE}_{kind}.txt")
    md_path = ns["render"](HANDLE, out_dir)
    md = md_path.read_text(encoding="utf-8")

    posts = ns["parse_captions"](out_dir / f"定性_{HANDLE}_captions.txt")
    comments = ns["parse_comments"](out_dir / f"定性_{HANDLE}_comments.txt")
    bio, full_name = ns["parse_profile"](out_dir / f"定性_{HANDLE}_profile.txt")
    captions = [p["caption"] for p in posts]
    pr_posts = sum(1 for p in posts if p["paid"] or re.search(r"#\s*(PR|提供|ad|タイアップ)", Q.norm(p["caption"])))
    qual = Q.extract({"bio_text": bio, "full_name": full_name}, captions, pr_posts)
    own = [c for c in comments if c["own"]]
    readers = [c for c in comments if not c["own"]]

expected = {
    "_生成": "tools/gen_qual_expected.py が reference/qual_report.py を fixture に適用した出力",
    "posts": len(posts),
    "comments": len(comments),
    "own": len(own),
    "readers": len(readers),
    "uniqueOwn": len({c["text"] for c in own}),
    "questions": len([c for c in readers if re.search(r"[?？]|教えて|どこで|いくら|どれ|悩み", c["text"])]),
    "pairs": [{"reader": f"@{q.split(':',1)[0].lstrip('@')}", "own": a} for q, a in ns["qa_pairs"](comments, HANDLE)],
    "pr_posts": pr_posts,
    "stance": qual["stance"],
    "witness": qual["witness_score"],
    "authority": qual["authority_score"],
    "captionAvg": qual["counts"]["キャプション平均文字数"],
    "reliability": qual["counts"]["定性列の信頼性"],
    "quotes": {k: v for k, v in qual["quotes"].items()},
    "counts": {k: v for k, v in qual["counts"].items()},
    "md_sections": re.findall(r"^##\s+(.+)$", md, re.M),
}
(FIX / "qual_expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"書き出し: tests/fixtures/qual_expected.json  投稿{expected['posts']} コメント{expected['comments']} "
      f"本人返信{expected['own']} 語りの向き={expected['stance'][:12]}")
