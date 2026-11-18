"""Build the tool-use training set for a local model in ezCLI.

Every example is one user turn exactly as ezCLI sends it (the question, then the tool note from
src/features/websearch.ts `hint()`), and the reply the model should give:

  * a one-line tool request (SEARCH, BROWSE, KNOW, IMAGE, VIDEO, RUN, SKILL) with a short reason in <think>, or
  * a direct answer, for questions the model can answer from what it knows. Those answers are not written
    here: they are marked "distill" and filled in by distill.py from the model itself, so training changes
    when the model reaches for a tool, not what it knows.

Writes data/prompts.jsonl (train) and data/heldout.jsonl (evaluation, never trained on).
Run:  python make_dataset.py   (no downloads, no GPU)
"""
import json
import random
from pathlib import Path

R = random.Random(7)
OUT = Path(__file__).parent / "data"

# ------------------------------------------------------------------ the note ezCLI adds (keep in step with hint())
SEARCH = "SEARCH: <query> (only for facts that may have changed since your training: recent events, current prices, versions or office-holders, or a name you do not recognise; never for explanations, advice, code, tuning yourself or this app, or anything you already know)"
BROWSE = "BROWSE: <https address> (open one web page in the in-app browser and read it)"
KNOW = "KNOW: <query> (search the files the user added to Knowledge; use it when the question may be about their own documents or code)"
IMAGE = "IMAGE: <description> (make a picture on this computer when the user asks for one)"
VIDEO = "VIDEO: <description> (make a short silent video clip; it takes several minutes)"
RUN = "RUN: <one PowerShell command> (the user approves it first; use it only when the user asks you to do something on their PC)"
SKILLS = ["graphify", "frontend-design", "pdf", "xlsx", "code-review", "deploy-checklist"]
RULES = ("Accuracy rules. Work out the answer step by step and check it before you reply. Do not guess: if you are not sure of a fact, "
         "say so or look it up. A name, paper, product, person or number you do not recognise may not exist; do not describe it as if it does. "
         "Never invent facts, numbers, quotes, links, file names or sources. The web is only for facts newer than your training: do not search "
         "for how-to advice, explanations, coding help or questions about yourself, answer those from what you know. When you use web results, "
         "say which source each fact came from; if they do not answer the question, say that. Keep answers short and direct.")
MODEL_IDS = ["Qwen3-8B-Q6_K", "C:\\Users\\Aryan\\.ezcli\\models\\Qwen__Qwen3-8B-GGUF\\Qwen3-8B-Q6_K.gguf", "qwen3:8b"]


def note(tools, model, short):
    parts = []
    if "web" in tools:
        parts += [SEARCH, BROWSE]
    if "skill" in tools:
        parts.append(f"SKILL: <name> (load one of the user's skills: {', '.join(SKILLS)})")
    if "know" in tools:
        parts.append(KNOW)
    if "create" in tools:
        parts += [IMAGE, VIDEO]
    if "run" in tools:
        parts.append(RUN)
    names = [p.split(":")[0] for p in parts]
    if short:
        extra = f" Tools as before (real, run by the app; you do have web access through them, but search only for facts newer than your training): {', '.join(names)}; reply with only that one line when you use one." if names else ""
        return f" [Reminder: you are {model}, not Claude. Do not guess.{extra}]"
    who = f"You are {model}, running on this PC. You are not Claude, ChatGPT or any other model, even if web results or the conversation mention them."
    use = (" Tools: these are real. The app runs them for you, so you do have web access through them; do not say you cannot browse. "
           "Web results the app already fetched appear in square brackets after the user's message; use them. When you need a tool, reply with "
           f"only one line and nothing else: {' | '.join(parts)}. Otherwise just answer.") if parts else ""
    return f" [{who} {RULES}{use}]"


def tools_with(*need):
    """A random set of enabled tools that always includes `need` (ezCLI only lists the tools that are on)."""
    s = set(need)
    for t in ["web", "skill", "know", "create", "run"]:
        if R.random() < 0.5:
            s.add(t)
    return s


def pick(xs):
    return R.choice(xs)


# ------------------------------------------------------------------ questions that need fresh facts -> SEARCH
FRESH = [
    ("What is the price of {coin} right now?", "{coin} price today", "The price changes by the minute, so I need a live figure."),
    ("What's the latest version of {sw}?", "{sw} latest version", "Version numbers change after my training, so I should check."),
    ("Has {sw} released a new version this month?", "{sw} release this month", "This is about recent releases, which I cannot know."),
    ("Who is the current {office}?", "current {office}", "Office-holders change; my training may be out of date."),
    ("What happened in {topic} news today?", "{topic} news today", "Today's news is after my training."),
    ("Who won the {event}?", "{event} winner", "A result I may not have, depending on when it happened."),
    ("What's the weather in {city} tomorrow?", "{city} weather tomorrow", "Weather is live data."),
    ("How much does the {product} cost in India now?", "{product} price India", "Prices change; I need a current one."),
    ("Is {product} out yet?", "{product} release date", "Whether it has launched may have changed since my training."),
    ("What's the USD to INR exchange rate today?", "USD to INR exchange rate today", "Exchange rates change daily."),
    ("When is the next {event2}?", "next {event2} date", "Upcoming dates may have been set after my training."),
    ("What did {company} announce this week?", "{company} announcement this week", "This week's announcements are newer than my training."),
    ("Is {sw} still maintained in 2026?", "{sw} maintenance status 2026", "Its status in 2026 is after my training."),
    ("What are the reviews saying about the {product}?", "{product} review", "Reviews of a recent product are newer than what I know."),
    ("Tell me about {unknown}.", "{unknown}", "I do not recognise this name, so I should look it up rather than guess."),
    ("What is {unknown} and who makes it?", "{unknown}", "I do not know this name; it may be new or may not exist."),
]
FILL = {
    "coin": ["Bitcoin", "Ethereum", "Solana", "gold", "Nifty 50", "Nvidia stock", "Reliance shares"],
    "sw": ["llama.cpp", "Ollama", "Tauri", "Node.js", "Python", "Rust", "PyTorch", "OpenCode", "Vite", "Next.js", "Unreal Engine", "Blender", "ComfyUI"],
    "office": ["Prime Minister of the UK", "President of the United States", "Chief Minister of Delhi", "CEO of OpenAI", "CEO of Intel", "Governor of the RBI", "UN Secretary-General"],
    "topic": ["AI", "tech", "India", "cricket", "space", "markets", "gaming"],
    "event": ["last IPL final", "most recent F1 race", "latest Ballon d'Or", "last Champions League final", "most recent Grammy for album of the year"],
    "city": ["Delhi", "Noida", "Mumbai", "Bengaluru", "London", "Tokyo"],
    "product": ["RTX 5080", "PS5 Pro", "Steam Deck OLED", "iPhone 17", "Pixel 10", "RTX 5070 Ti", "Switch 2"],
    "event2": ["Apple event", "IPL season", "GTA 6 trailer", "Nvidia keynote", "Google I/O"],
    "company": ["Nvidia", "Anthropic", "Google", "Valve", "Rockstar", "AMD", "Microsoft"],
    "unknown": ["Veyra 2.1", "Zentrix AI", "the Halcyon-7 processor", "QuarkDB", "Nebulite OS", "Project Ostara", "the Lumen X3 headset", "Fernwood CLI"],
}


def fill(tpl, keys):
    out = tpl
    for k, v in keys.items():
        out = out.replace("{" + k + "}", v)
    return out


def fresh_example():
    q, query, why = pick(FRESH)
    keys = {k: pick(v) for k, v in FILL.items()}
    return fill(q, keys), "web", f"<think>\n{why}\n</think>\n\nSEARCH: {fill(query, keys)}"


# ------------------------------------------------------------------ questions to answer from memory (answers distilled)
TIMELESS = [
    "Explain how {concept} works in simple terms.", "What is the difference between {a} and {b}?", "Write a {lang} function that {task}.",
    "Why does my {lang} code give '{err}'?", "How do I {howto}?", "Give me three tips for {skill}.", "What does {term} mean?",
    "Summarise the idea behind {concept} in two sentences.", "Is {a} or {b} better for {use}?", "How do I make you faster on my GPU?",
    "What model are you?", "Can you browse the internet?", "How much context can you handle?", "How do I turn off web search in ezCLI?",
    "What's {n} times {m}?", "Convert {temp} Celsius to Fahrenheit.", "Proofread this: '{sentence}'", "Translate '{phrase}' into Hindi.",
]
TFILL = {
    "concept": ["attention in transformers", "a hash map", "TCP handshakes", "garbage collection", "LoRA fine-tuning", "quantization of LLMs", "React hooks", "Git rebase", "binary search", "photosynthesis", "compound interest", "DNS"],
    "a": ["TCP", "Rust", "SQL", "REST", "a process", "LoRA", "Q4_K_M", "async/await", "Vulkan"], "b": ["UDP", "Go", "NoSQL", "GraphQL", "a thread", "full fine-tuning", "Q8_0", "threads", "CUDA"],
    "lang": ["Python", "Rust", "TypeScript", "JavaScript", "PowerShell", "C++"],
    "task": ["reverses a string", "checks if a number is prime", "reads a CSV and sums a column", "debounces a callback", "flattens a nested list", "parses a date"],
    "err": ["index out of range", "borrowed value does not live long enough", "undefined is not a function", "cannot find module", "NoneType has no attribute 'split'"],
    "howto": ["undo the last git commit", "free disk space on Windows", "write a good commit message", "center a div", "set up a Python virtual environment", "read a file line by line in Rust", "reduce VRAM use when running a model"],
    "skill": ["writing clear emails", "learning Rust", "debugging", "focusing while studying", "public speaking"],
    "term": ["idempotent", "a race condition", "tokenization", "a mutex", "technical debt", "a closure", "perplexity"],
    "use": ["a desktop app", "a small web API", "running local models", "a beginner"],
    "n": ["17", "23", "48", "125"], "m": ["6", "19", "12", "8"], "temp": ["37", "100", "-5", "22"],
    "sentence": ["their going to the store tomorow", "I has completed the task yesterday", "its a good idea to backup you're files"],
    "phrase": ["good morning", "thank you very much", "where is the station"],
}


def timeless_example():
    q = pick(TIMELESS)
    return fill(q, {k: pick(v) for k, v in TFILL.items()}), "web", "distill"


NO_WEB = ["Don't search, just tell me: {q}", "{q} Answer from what you know, no web.", "Without looking it up, {ql}"]


def no_web_example():
    q, _, _ = pick(FRESH)
    q = fill(q, {k: pick(v) for k, v in FILL.items()})
    t = pick(NO_WEB)
    return t.replace("{q}", q).replace("{ql}", q[0].lower() + q[1:]), "web", "distill"


# ------------------------------------------------------------------ other tools
SUBJECTS = ["a red kite over a green hill", "a paper boat on calm water at dawn", "a cosy reading nook with rain on the window", "a neon street in Tokyo at night",
            "a golden retriever puppy in autumn leaves", "a lighthouse at sunset", "a minimalist logo of a mountain", "a bowl of ramen, top view", "a snowy cabin in pine woods"]
IMG_ASK = ["Make me a picture of {s}.", "Can you draw {s}?", "Generate an image of {s}.", "I need a wallpaper: {s}.", "Create a picture: {s}, in watercolour."]
VID_ASK = ["Make a short video of {s}.", "Can you create a clip of {s}?", "Animate {s} for a few seconds."]


def image_example():
    s = pick(SUBJECTS)
    return pick(IMG_ASK).replace("{s}", s), "create", f"<think>\nThe user wants a picture, and the IMAGE tool makes one.\n</think>\n\nIMAGE: {s}"


def video_example():
    s = pick(SUBJECTS)
    return pick(VID_ASK).replace("{s}", s), "create", f"<think>\nThe user wants a video clip, so I use the VIDEO tool.\n</think>\n\nVIDEO: {s}"


URLS = ["https://github.com/ggml-org/llama.cpp/releases", "https://tauri.app/start/", "https://docs.python.org/3/whatsnew/3.13.html", "https://ollama.com/library/qwen3", "https://www.rust-lang.org/learn"]
BROWSE_ASK = ["Open {u} and tell me what it says.", "Read this page and summarise it: {u}", "What's on {u}?"]


def browse_example():
    u = pick(URLS)
    return pick(BROWSE_ASK).replace("{u}", u), "web", f"<think>\nThe user gave a page to read; I open it.\n</think>\n\nBROWSE: {u}"


RUN_ASK = [("How much free space is on my C: drive?", "Get-PSDrive C | Select-Object Used,Free"), ("List the files in my Downloads folder.", "Get-ChildItem $env:USERPROFILE\\Downloads | Select-Object Name,Length"),
           ("What's my GPU and driver version?", "nvidia-smi --query-gpu=name,driver_version --format=csv"), ("Which process is using the most memory right now?", "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Name,WorkingSet64"),
           ("Show my IP address.", "Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress"), ("What Python version do I have installed?", "python --version"),
           ("Show the last 5 git commits in this folder.", "git log --oneline -5")]


def run_example():
    q, cmd = pick(RUN_ASK)
    return q, "run", f"<think>\nThis is about the user's own PC; a command will answer it, and they approve it first.\n</think>\n\nRUN: {cmd}"


KNOW_ASK = [("What did I write about the pricing plan in my notes?", "pricing plan"), ("Where in my project is the login handled?", "login handling"), ("Find the part of my thesis about data cleaning.", "data cleaning"),
            ("What does my README say about installing?", "installing README"), ("Search my documents for the Q3 budget.", "Q3 budget")]


def know_example():
    q, k = pick(KNOW_ASK)
    return q, "know", f"<think>\nThis is about the user's own files, which are in Knowledge.\n</think>\n\nKNOW: {k}"


SKILL_ASK = [("Review this code before I merge it, using my code-review skill.", "code-review"), ("Use my pdf skill to help me merge two PDFs.", "pdf"), ("Help me design a landing page with my frontend-design skill.", "frontend-design"), ("Make a deploy checklist for this release.", "deploy-checklist")]


def skill_example():
    q, k = pick(SKILL_ASK)
    return q, "skill", f"<think>\nThe user named one of their skills; I load it first.\n</think>\n\nSKILL: {k}"


def build(n, gen_weights):
    rows = []
    gens, weights = zip(*gen_weights)
    # A tool request has few wordings, so the same question may come back with different tools enabled, a different
    # model name or the short reminder: that variety is what is learned. Each exact user turn appears once, and no
    # question more than 12 times.
    seen, per_q, tries = set(), {}, 0
    while len(rows) < n and tries < n * 50:
        tries += 1
        q, need, target = R.choices(gens, weights)[0]()
        if per_q.get(q, 0) >= 12:
            continue
        model = pick(MODEL_IDS)
        short = R.random() < 0.35
        user = q + note(tools_with(need), model, short)
        if user in seen:
            continue
        seen.add(user)
        per_q[q] = per_q.get(q, 0) + 1
        rows.append({"user": user, "question": q, "target": target, "kind": target.split("\n\n")[-1].split(":")[0] if target != "distill" else "ANSWER"})
    return rows


MIX = [(fresh_example, 34), (timeless_example, 32), (no_web_example, 6), (image_example, 8), (video_example, 4), (browse_example, 5), (run_example, 5), (know_example, 3), (skill_example, 3)]

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    rows = build(1900, MIX)
    R.shuffle(rows)
    qs = sorted({r["question"] for r in rows})
    R.shuffle(qs)
    held_q = set(qs[: len(qs) // 12])
    held = [r for r in rows if r["question"] in held_q]
    train = [r for r in rows if r["question"] not in held_q]
    for name, part in (("prompts.jsonl", train), ("heldout.jsonl", held)):
        with open(OUT / name, "w", encoding="utf-8") as f:
            for r in part:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    from collections import Counter
    print("train", len(train), dict(Counter(r["kind"] for r in train)))
    print("heldout", len(held), dict(Counter(r["kind"] for r in held)))
