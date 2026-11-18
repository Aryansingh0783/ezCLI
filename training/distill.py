"""Fill in the direct answers ("distill" rows) with the model's own replies, so training teaches when to use a
tool without changing what the model knows.

Each question is sent to a running llama-server with the model that will be fine-tuned, with no tool note, so the
model answers as it normally would. Its thinking is kept in <think>, the way Qwen3 writes it. Answers that still
ask for a tool or claim the model cannot browse are dropped.

Start the server first (ezCLI's own llama.cpp build has it), e.g.:
  llama-server -m Qwen3-8B-Q6_K.gguf -ngl 99 --device Vulkan1 --jinja --port 8088 -c 16384 -np 4
Run:  python distill.py   (reads data/prompts.jsonl + data/heldout.jsonl, writes data/train.jsonl)
"""
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

DATA = Path(__file__).parent / "data"
URL = "http://127.0.0.1:8088/v1/chat/completions"
TOOL_LINE = re.compile(r"^\s*(?:[-*>•]|\d+[.)])?\s*[*_`]*(SEARCH|BROWSE|SKILL|RUN|KNOW|IMAGE|VIDEO)\s*:", re.I | re.M)
REFUSAL = re.compile(r"(can(?:no|')t|unable to|don't have (?:the ability|access)).{0,40}(browse|internet|real[- ]time|search)", re.I)


def model_name(user):
    m = re.search(r"you are (.+?)(?:, running on this PC|, not Claude)", user)
    return m.group(1) if m else "a local model"


def answer(row):
    name = model_name(row["user"])
    msgs = [
        {"role": "system", "content": f"You are {name}, a local model running on the user's PC inside the ezCLI app. Answer directly, short and accurate. If a question needs live data you do not have, say so plainly in one sentence."},
        {"role": "user", "content": row["question"]},
    ]
    r = requests.post(URL, json={"messages": msgs, "temperature": 0.6, "top_p": 0.95, "max_tokens": 1500}, timeout=600)
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    think = (msg.get("reasoning_content") or "").strip()
    text = (msg.get("content") or "").strip()
    if "<think>" in text:  # server without a reasoning parser: the thinking is inline
        m = re.match(r"<think>(.*?)</think>\s*(.*)", text, re.S)
        if m:
            think, text = m.group(1).strip(), m.group(2).strip()
    if not text or TOOL_LINE.search(text) or REFUSAL.search(text):
        return None
    return f"<think>\n{think}\n</think>\n\n{text}"


def main():
    rows = [json.loads(l) for l in open(DATA / "prompts.jsonl", encoding="utf-8")]
    todo = [r for r in rows if r["target"] == "distill"]
    print(f"{len(todo)} answers to distill", flush=True)
    done = 0

    def work(r):
        nonlocal done
        try:
            r["target"] = answer(r)
        except Exception as e:  # noqa: BLE001 - one failed request drops one row
            print("failed:", e, file=sys.stderr)
            r["target"] = None
        done += 1
        if done % 25 == 0:
            print(f"{done}/{len(todo)}", flush=True)

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(work, todo))
    kept = [r for r in rows if r["target"]]
    with open(DATA / "train.jsonl", "w", encoding="utf-8") as f:
        for r in kept:
            f.write(json.dumps({"messages": [{"role": "user", "content": r["user"]}, {"role": "assistant", "content": r["target"]}], "kind": r["kind"]}, ensure_ascii=False) + "\n")
    print(f"wrote {len(kept)} rows ({len(rows) - len(kept)} dropped)")


if __name__ == "__main__":
    main()
