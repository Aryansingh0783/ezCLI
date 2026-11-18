"""Compare the model with and without the adapter on the held-out questions (never trained on).

For each question it sends the full ezCLI user turn to a running llama-server and checks the reply the way ezCLI
does (src/features/websearch.ts `request()`): a one-line tool request of the right kind, or a plain answer.
Run once against the plain model, once with the adapter loaded (--lora), and compare the scores.

Run:  python eval.py --label base      (server started without --lora)
      python eval.py --label tuned     (server started with --lora out\\adapter.gguf)
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

import requests

HERE = Path(__file__).parent
URL = "http://127.0.0.1:8088/v1/chat/completions"
REQ = re.compile(r"^(SEARCH|BROWSE|SKILL|RUN|KNOW|IMAGE|VIDEO)\s*:\s*(.+)$", re.I)


def tool_of(text):
    """ezCLI's rule: a request is a reply of at most 3 short lines, one of which is the tool line."""
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if not lines or len(lines) > 3 or len(" ".join(lines)) > 600:
        return "ANSWER"
    for raw in lines:
        line = re.sub(r"[*_`]+", "", re.sub(r"^(?:[-*>•]|\d+[.)])\s+", "", raw)).strip()
        m = REQ.match(line)
        if m:
            return m.group(1).upper()
    return "ANSWER"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(HERE / "data" / "heldout.jsonl", encoding="utf-8")]
    score, total, wrong = Counter(), Counter(), []
    for r in rows:
        res = requests.post(URL, json={"messages": [{"role": "user", "content": r["user"]}], "temperature": 0.2, "max_tokens": 1200}, timeout=600).json()
        text = (res["choices"][0]["message"].get("content") or "").strip()
        text = re.sub(r"^.*?</think>\s*", "", text, flags=re.S)
        got = tool_of(text)
        total[r["kind"]] += 1
        if got == r["kind"]:
            score[r["kind"]] += 1
        else:
            wrong.append({"question": r["question"], "want": r["kind"], "got": got, "reply": text[:160]})
    print(f"== {a.label}: {sum(score.values())}/{len(rows)} right")
    for k in sorted(total):
        print(f"  {k:7} {score[k]:3}/{total[k]}")
    out = HERE / "out" / f"eval-{a.label}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"score": dict(score), "total": dict(total), "wrong": wrong}, indent=1, ensure_ascii=False), encoding="utf-8")
    print("details in", out)


if __name__ == "__main__":
    main()
