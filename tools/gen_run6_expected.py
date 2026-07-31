#!/usr/bin/env python3
"""ゴールデンテストの期待値を **Python版パイプラインそのもの** から作る。

  python3 tools/gen_run6_expected.py [--ref ../reference]

入力:  tests/fixtures/run6_compact.jsonl(匿名化済み。tools/build_fixtures.mjs が生成)
        reference/ingest_compact.py(移植元。コミットしない)
出力:  tests/fixtures/run6_expected.json
          summary   … Python版が出した summary(= summary_run6.json と同値であることを検証済み)
          rows      … Python版が出した全100件の拡張CSV25列(定性列・適合コメント本文まで)

JS版のゴールデンテストはこのファイルと**1文字単位で**突合する。
期待値を手で書かないのが要点(手で書くと移植ミスを一緒に写してしまう)。
"""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ref_idx = sys.argv.index("--ref") if "--ref" in sys.argv else -1
REF = Path(sys.argv[ref_idx + 1]) if ref_idx > 0 else ROOT.parent / "reference"
FIXTURE = ROOT / "tests" / "fixtures" / "run6_compact.jsonl"
OUT = ROOT / "tests" / "fixtures" / "run6_expected.json"

if not FIXTURE.exists():
    raise SystemExit(f"fixture がありません: {FIXTURE}(先に tools/build_fixtures.mjs を実行)")
ingest = REF / "ingest_compact.py"
if not ingest.exists():
    raise SystemExit(f"移植元がありません: {ingest}(--ref でキットの reference/ を指定)")

with tempfile.TemporaryDirectory() as tmp:
    subprocess.run([sys.executable, str(ingest), str(FIXTURE), "golden"],
                   cwd=tmp, check=True, stdout=subprocess.DEVNULL)
    out_dir = Path(tmp) / "成果物_golden"
    summary = json.loads((out_dir / "summary_golden.json").read_text(encoding="utf-8"))
    rows = list(csv.DictReader((out_dir / "all_golden.csv").open(encoding="utf-8-sig")))
    matched = [r["username"].lstrip("@") for r in
               csv.DictReader((out_dir / "matched_golden.csv").open(encoding="utf-8-sig"))]

# run#6 の実績値との一致も同時に確認する(fixture が run#6 を代表していることの担保)
real = json.loads((REF / "成果物_run6" / "summary_run6.json").read_text(encoding="utf-8"))
CHECK = ["取得試行", "取得成功", "取得失敗", "帯内(5千〜10万)", "機械合格", "純度ゲート除外",
         "シグナル内訳(全取得)", "落ち理由", "rate_limited"]
diff = [k for k in CHECK if summary[k] != real[k]]
stance_ok = (summary["定性列の信頼性(v2.7)"]["語りの向きの内訳"]
             == real["定性列の信頼性(v2.7)"]["語りの向きの内訳"])
OUT.write_text(json.dumps({
    "_生成": "tools/gen_run6_expected.py が reference/ingest_compact.py を fixture に適用した出力",
    "_run6実績との差": diff,
    "_stance内訳がrun6実績と一致": stance_ok,
    "summary": summary,
    "matched": matched,
    "rows": rows,
}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"書き出し: {OUT.relative_to(ROOT)}  行数={len(rows)} 機械合格={len(matched)}")
print(f"run#6実績との差: {diff or 'なし'} / stance内訳一致: {stance_ok}")
