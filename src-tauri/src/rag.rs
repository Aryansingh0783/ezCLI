//! Knowledge index (RAG) for local models. The user adds folders or files; the text is cut into passages and
//! saved in `~/.ezcli/knowledge/index.json`. A question is matched against the passages with BM25 (word
//! statistics, no embedding model and no download), and the best passages go to the model along with the
//! question. It works the same for llama.cpp, LM Studio and Ollama because it only changes the text sent.
//!
//! Only paths the user picks are read. The model can search the index but cannot add or read other files.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Characters per passage (a paragraph or a few lines; small enough that several fit in a small context).
const CHUNK_CHARS: usize = 900;
/// Largest single file that is indexed.
const MAX_FILE_BYTES: u64 = 1_500_000;
/// Files taken from one "add" request, and the most text the whole index may hold.
const MAX_FILES_PER_ADD: usize = 3000;
const MAX_TOTAL_CHARS: usize = 24_000_000;
const MAX_DEPTH: usize = 8;
/// A passage must score at least this much, and at least this share of the best passage, to be returned.
const MIN_SCORE: f64 = 0.25;
const MIN_SHARE: f64 = 0.35;
const MAX_PER_FILE: usize = 2;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "rs", "js",
    "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "go", "c", "h", "cpp", "hpp", "cs", "rb", "php", "sh", "ps1", "bat", "sql",
    "html", "htm", "xml", "css", "scss", "svelte", "vue", "tex", "org",
];
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__", "venv"];

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct Doc {
    path: String,
    chunks: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct Store {
    docs: Vec<Doc>,
}

/// One indexed file, for the list in the app.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Source {
    pub path: String,
    pub passages: usize,
}

/// What an "add" request did.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct AddReport {
    pub files: usize,
    pub passages: usize,
    pub skipped: usize,
    pub note: String,
}

/// One passage that matched a question.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit {
    pub source: String,
    pub text: String,
    pub score: f64,
}

fn store_file() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("knowledge").join("index.json")
}

fn load(file: &Path) -> Store {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(file: &Path, store: &Store) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(store).map_err(|e| e.to_string())?;
    // write beside the index, then rename, so a crash never leaves half an index
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

const STOP: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our", "out", "has", "his", "how",
    "its", "who", "did", "get", "may", "she", "too", "use", "that", "this", "with", "have", "from", "they", "will", "what", "when",
    "where", "which", "there", "their", "about", "would", "could", "should", "into", "than", "then", "them", "these", "those", "been",
    "were", "your", "does", "tell", "give", "show",
];

/// Lower-case words made of letters and digits. Short words are dropped unless they hold a digit.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .filter(|w| (w.chars().count() > 1 || w.chars().any(|c| c.is_ascii_digit())) && !STOP.contains(&w.as_str()))
        .collect()
}

/// Cut text into passages of about `CHUNK_CHARS` characters on paragraph and line boundaries.
fn chunk_text(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        let t = cur.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
        cur.clear();
    };
    for para in text.replace("\r\n", "\n").split("\n\n") {
        for line in para.lines() {
            // a line longer than a passage is split on characters
            let chars: Vec<char> = line.chars().collect();
            for piece in chars.chunks(CHUNK_CHARS) {
                let piece: String = piece.iter().collect();
                if cur.chars().count() + piece.chars().count() + 1 > CHUNK_CHARS {
                    flush(&mut cur, &mut out);
                }
                cur.push_str(&piece);
                cur.push('\n');
            }
        }
        // a blank line ends a passage once it is reasonably full, so short paragraphs stay together
        if cur.chars().count() >= CHUNK_CHARS / 2 {
            flush(&mut cur, &mut out);
        } else if !cur.is_empty() {
            cur.push('\n');
        }
    }
    flush(&mut cur, &mut out);
    out
}

fn is_text_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn collect_files(path: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_FILES_PER_ADD {
        return;
    }
    // links are skipped so an index of one folder never reads another
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.file_type().is_symlink() {
        return;
    }
    if meta.is_file() {
        out.push(path.to_path_buf());
    } else if meta.is_dir() && depth < MAX_DEPTH {
        let Ok(rd) = std::fs::read_dir(path) else { return };
        let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with('.') || (p.is_dir() && SKIP_DIRS.contains(&name)) {
                continue;
            }
            collect_files(&p, depth + 1, out);
        }
    }
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES || meta.len() == 0 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // a NUL byte near the start means a binary file with a text-like name
    if bytes.iter().take(4096).any(|b| *b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn total_chars(store: &Store) -> usize {
    store.docs.iter().flat_map(|d| d.chunks.iter()).map(|c| c.len()).sum()
}

/// Index a file or a folder. Adding a path again replaces what was indexed for each of its files.
fn add_in(file: &Path, target: &Path) -> Result<AddReport, String> {
    if !target.is_absolute() {
        return Err("Give the full path of a folder or file.".into());
    }
    if !target.exists() {
        return Err(format!("{} does not exist.", target.display()));
    }
    let mut files = Vec::new();
    collect_files(target, 0, &mut files);
    let mut store = load(file);
    let mut report = AddReport::default();
    for f in files {
        // a file named directly is indexed whatever its extension; a folder only brings text files
        if f != target && !is_text_file(&f) {
            continue;
        }
        let Some(text) = read_text(&f) else {
            report.skipped += 1;
            continue;
        };
        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            report.skipped += 1;
            continue;
        }
        let path = f.to_string_lossy().into_owned();
        store.docs.retain(|d| d.path != path);
        if total_chars(&store) + chunks.iter().map(|c| c.len()).sum::<usize>() > MAX_TOTAL_CHARS {
            report.note = "The index is full, so some files were left out. Remove files you no longer need.".into();
            report.skipped += 1;
            continue;
        }
        report.files += 1;
        report.passages += chunks.len();
        store.docs.push(Doc { path, chunks });
    }
    if report.files == 0 && report.note.is_empty() {
        report.note = "No readable text files were found there (text, code, markdown, csv, json and similar).".into();
    }
    save(file, &store)?;
    Ok(report)
}

fn sources_in(file: &Path) -> Vec<Source> {
    let mut v: Vec<Source> = load(file).docs.into_iter().map(|d| Source { passages: d.chunks.len(), path: d.path }).collect();
    v.sort_by(|a, b| a.path.cmp(&b.path));
    v
}

/// Remove one file, or every indexed file under a folder.
fn remove_in(file: &Path, target: &str) -> Result<usize, String> {
    let mut store = load(file);
    let before = store.docs.len();
    let base = Path::new(target);
    store.docs.retain(|d| d.path != target && !Path::new(&d.path).starts_with(base));
    let removed = before - store.docs.len();
    save(file, &store)?;
    Ok(removed)
}

/// BM25: passages that hold the question's rarer words, more than once, and are not padded with other text, rank first.
fn search_in(file: &Path, query: &str, k: usize) -> Vec<Hit> {
    let q: HashSet<String> = tokenize(query).into_iter().collect();
    if q.is_empty() || k == 0 {
        return Vec::new();
    }
    let store = load(file);
    let mut tfs: Vec<(usize, usize, HashMap<String, u32>, usize)> = Vec::new(); // doc, chunk, term counts, length
    let mut df: HashMap<String, u32> = HashMap::new();
    let mut total_len = 0usize;
    for (di, d) in store.docs.iter().enumerate() {
        for (ci, c) in d.chunks.iter().enumerate() {
            let toks = tokenize(c);
            let mut tf: HashMap<String, u32> = HashMap::new();
            for t in &toks {
                if q.contains(t) {
                    *tf.entry(t.clone()).or_insert(0) += 1;
                }
            }
            for t in tf.keys() {
                *df.entry(t.clone()).or_insert(0) += 1;
            }
            total_len += toks.len();
            tfs.push((di, ci, tf, toks.len()));
        }
    }
    if tfs.is_empty() {
        return Vec::new();
    }
    let n = tfs.len() as f64;
    let avg = (total_len as f64 / n).max(1.0);
    let (k1, b) = (1.5, 0.75);
    let mut scored: Vec<(f64, usize, usize)> = Vec::new();
    for (di, ci, tf, len) in &tfs {
        let mut score = 0.0;
        for (t, f) in tf {
            let d = f64::from(*df.get(t).unwrap_or(&0));
            let idf = (1.0 + (n - d + 0.5) / (d + 0.5)).ln();
            let f = f64::from(*f);
            score += idf * f * (k1 + 1.0) / (f + k1 * (1.0 - b + b * (*len as f64) / avg));
        }
        if score >= MIN_SCORE {
            scored.push((score, *di, *ci));
        }
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let best = scored.first().map_or(0.0, |s| s.0);
    let mut per_file: HashMap<usize, usize> = HashMap::new();
    let mut hits = Vec::new();
    for (score, di, ci) in scored {
        if score < best * MIN_SHARE || hits.len() >= k {
            break;
        }
        let used = per_file.entry(di).or_insert(0);
        if *used >= MAX_PER_FILE {
            continue;
        }
        *used += 1;
        hits.push(Hit { source: store.docs[di].path.clone(), text: store.docs[di].chunks[ci].clone(), score: (score * 100.0).round() / 100.0 });
    }
    hits
}

pub fn add(path: &str) -> Result<AddReport, String> {
    add_in(&store_file(), Path::new(path))
}

pub fn sources() -> Vec<Source> {
    sources_in(&store_file())
}

pub fn remove(path: &str) -> Result<usize, String> {
    remove_in(&store_file(), path)
}

pub fn clear() -> Result<(), String> {
    save(&store_file(), &Store::default())
}

pub fn search(query: &str, k: usize) -> Vec<Hit> {
    search_in(&store_file(), query, k.min(8))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ezcli-rag-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tokenizer_lowercases_and_drops_noise() {
        assert_eq!(tokenize("The Quick-brown FOX, a 7 b2!"), ["quick", "brown", "fox", "7", "b2"]);
        assert_eq!(tokenize("snake_case helloWorld"), ["snake", "case", "helloworld"]);
    }

    #[test]
    fn chunks_stay_small_and_keep_every_word() {
        let para = "word ".repeat(120); // 600 characters
        let text = format!("{para}\n\n{para}\n\n{para}\n\nlast line");
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.chars().count() <= CHUNK_CHARS + 2), "a passage grew past the limit");
        let joined = chunks.join(" ");
        assert_eq!(joined.matches("word").count(), 360);
        assert!(joined.contains("last line"));
        // one enormous line is split on characters instead of becoming one giant passage
        let long = chunk_text(&"x".repeat(CHUNK_CHARS * 3 + 5));
        assert_eq!(long.len(), 4);
        assert!(chunk_text("  \n\n \n").is_empty());
    }

    #[test]
    fn finds_the_passage_that_answers_and_ignores_the_rest() {
        let dir = scratch("find");
        let docs = dir.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("gpu.md"), "The RTX 5070 has 12 GB of VRAM.\n\nLayers that do not fit are kept on the CPU.").unwrap();
        std::fs::write(docs.join("cooking.txt"), "Boil the pasta for nine minutes and salt the water.").unwrap();
        std::fs::write(docs.join("empty.md"), "").unwrap();
        std::fs::write(docs.join("photo.png"), [0u8, 1, 2]).unwrap();
        let index = dir.join("index.json");
        let report = add_in(&index, &docs).unwrap();
        assert_eq!((report.files, report.skipped), (2, 1), "{report:?}"); // empty.md is skipped; photo.png is not a text file
        let hits = search_in(&index, "how much VRAM does the RTX 5070 have", 3);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].source.ends_with("gpu.md") && hits[0].text.contains("12 GB"));
        assert!(search_in(&index, "quantum chromodynamics", 3).is_empty(), "an unrelated question must match nothing");
        assert!(search_in(&index, "the and for", 3).is_empty(), "only stop words must match nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rarer_words_outrank_common_ones_and_one_file_cannot_flood_the_answer() {
        let dir = scratch("rank");
        let index = dir.join("index.json");
        let busy = (0..6).map(|i| format!("llama notes {i}: the llama runs fine.")).collect::<Vec<_>>().join("\n\n");
        let busy = busy.replace("fine.", &format!("fine. {}", "padding ".repeat(60)));
        let f1 = dir.join("a.md");
        std::fs::write(&f1, busy).unwrap();
        let f2 = dir.join("b.md");
        std::fs::write(&f2, "The qwen4exp architecture crashes in llama.cpp.").unwrap();
        add_in(&index, &f1).unwrap();
        add_in(&index, &f2).unwrap();
        let hits = search_in(&index, "qwen4exp llama crash", 5);
        assert!(hits[0].source.ends_with("b.md"), "the rare word must win: {hits:?}");
        assert!(hits.iter().filter(|h| h.source.ends_with("a.md")).count() <= MAX_PER_FILE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adding_again_replaces_and_remove_forgets() {
        let dir = scratch("replace");
        let index = dir.join("index.json");
        let f = dir.join("notes.md");
        std::fs::write(&f, "alpha beta gamma").unwrap();
        add_in(&index, &f).unwrap();
        std::fs::write(&f, "delta epsilon zeta").unwrap();
        add_in(&index, &f).unwrap();
        assert_eq!(sources_in(&index).len(), 1);
        assert!(search_in(&index, "alpha", 3).is_empty(), "the old text must be gone");
        assert_eq!(search_in(&index, "epsilon", 3).len(), 1);
        assert_eq!(remove_in(&index, &dir.to_string_lossy()).unwrap(), 1, "removing a folder removes the files under it");
        assert!(sources_in(&index).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folders_skip_hidden_build_and_binary_files_and_relative_paths_are_refused() {
        let dir = scratch("skip");
        let index = dir.join("index.json");
        let root = dir.join("proj");
        for sub in [".git", "node_modules", "src"] {
            std::fs::create_dir_all(root.join(sub)).unwrap();
        }
        std::fs::write(root.join(".git").join("config.txt"), "secret token").unwrap();
        std::fs::write(root.join("node_modules").join("lib.js"), "module junk").unwrap();
        std::fs::write(root.join("src").join("main.rs"), "fn main() { println!(\"hello\"); }").unwrap();
        std::fs::write(root.join("src").join("blob.txt"), b"abc\0def").unwrap();
        std::fs::write(root.join("data.bin"), "text but wrong extension").unwrap();
        let report = add_in(&index, &root).unwrap();
        assert_eq!(report.files, 1, "{report:?}");
        assert_eq!(sources_in(&index)[0].path, root.join("src").join("main.rs").to_string_lossy());
        assert!(add_in(&index, Path::new("relative/dir")).is_err());
        assert!(add_in(&index, &dir.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_index_file_reads_as_empty() {
        let dir = scratch("broken");
        let index = dir.join("index.json");
        std::fs::write(&index, "{not json").unwrap();
        assert!(sources_in(&index).is_empty());
        assert!(search_in(&index, "anything", 3).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
