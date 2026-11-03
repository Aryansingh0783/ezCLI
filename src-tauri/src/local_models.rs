//! Finds model files (GGUF) already on this PC, whoever downloaded them, so they can be run with a plain
//! llama.cpp build: no LM Studio and no Ollama needed.
//!
//! The scan only reads directory listings and file sizes. It never opens, runs or uploads a file.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Found {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub quant: String,
    /// Where it was found, for the list ("LM Studio", "Hugging Face cache", "Downloads", …).
    pub source: String,
}

/// Folders the user added; remembered for the model menu, which has no way to pass them.
static EXTRA: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn set_extra(folders: &[String]) {
    *EXTRA.lock().unwrap() = folders.iter().filter(|f| !f.trim().is_empty()).cloned().collect();
}

const MIN_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FOUND: usize = 500;
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "windows", "program files", "program files (x86)", "$recycle.bin", "system volume information",
    "appdata\\local\\temp", "proc", "sys", "dev", "__pycache__", ".cargo", ".rustup", ".npm", ".venv", "venv", "site-packages", "library",
];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// The places model files usually live, whichever app put them there.
pub fn default_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = home() {
        for p in [
            ".lmstudio/models", ".cache/lm-studio/models", ".cache/huggingface/hub", ".cache/llama.cpp", "AppData/Local/llama.cpp", "jan/models",
            ".local/share/nomic.ai/GPT4All", "AppData/Local/nomic.ai/GPT4All", "models", "Models", "llama.cpp/models", "koboldcpp", "text-generation-webui/models",
            ".ezcli/models", "Downloads", "Documents", "Desktop",
        ] {
            v.push(h.join(p));
        }
    }
    if cfg!(windows) {
        for d in 'C'..='Z' {
            for sub in ["models", "Models", "AI", "LLM", "llm"] {
                v.push(PathBuf::from(format!("{d}:\\{sub}")));
            }
        }
    } else {
        for p in ["/models", "/opt/models", "/mnt", "/media", "/srv/models", "/usr/share/ollama"] {
            v.push(PathBuf::from(p));
        }
    }
    v
}

/// Every fixed drive (Windows) or the home folder and mounts (elsewhere), for a deeper search.
fn deep_roots() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(windows) {
        for d in 'C'..='Z' {
            let p = PathBuf::from(format!("{d}:\\"));
            if p.exists() {
                v.push(p);
            }
        }
    } else {
        if let Some(h) = home() {
            v.push(h);
        }
        for p in ["/mnt", "/media", "/opt", "/srv"] {
            v.push(PathBuf::from(p));
        }
    }
    v
}

fn source_of(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/").to_lowercase();
    for (needle, label) in [
        (".lmstudio", "LM Studio"),
        ("lm-studio", "LM Studio"),
        ("huggingface", "Hugging Face cache"),
        ("gpt4all", "GPT4All"),
        ("/jan/", "Jan"),
        ("koboldcpp", "KoboldCpp"),
        (".ezcli/models", "Downloaded in ezCLI"),
        ("llama.cpp", "llama.cpp"),
        ("/downloads/", "Downloads"),
        ("/documents/", "Documents"),
        ("/desktop/", "Desktop"),
    ] {
        if s.contains(needle) {
            return label.to_string();
        }
    }
    "Other".to_string()
}

/// `Q4_K_M`, `IQ3_XXS`, `Q8_0`, `F16`, `BF16`… read from the file name; empty when none is there.
pub fn quant_of(name: &str) -> String {
    let up = name.to_uppercase().replace(['-', '.'], "_");
    let toks: Vec<&str> = up.split('_').collect();
    for (i, t) in toks.iter().enumerate() {
        let is_q = (t.starts_with('Q') || t.starts_with("IQ")) && t.chars().nth(if t.starts_with("IQ") { 2 } else { 1 }).is_some_and(|c| c.is_ascii_digit());
        if is_q {
            let mut q = t.to_string();
            for next in toks.iter().skip(i + 1).take(2) {
                if matches!(*next, "K" | "M" | "S" | "L" | "XL" | "XS" | "XXS" | "0" | "1" | "NL") {
                    q.push('_');
                    q.push_str(next);
                } else {
                    break;
                }
            }
            return q;
        }
        if matches!(*t, "F16" | "BF16" | "F32" | "FP16") {
            return t.to_string();
        }
    }
    String::new()
}

/// A model llama.cpp can start from: not a vision projector, and for a model split into parts only the first.
pub fn usable(name: &str) -> bool {
    let l = name.to_lowercase();
    if !l.ends_with(".gguf") || l.contains("mmproj") {
        return false;
    }
    if let Some(i) = l.rfind("-of-") {
        // name-00002-of-00005.gguf: only part 1 starts the model
        let head = &l[..i];
        let part: String = head.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
        if !part.is_empty() && part.trim_start_matches('0') != "1" {
            return false;
        }
    }
    true
}

/// A path that can be handed to a program as one argument without being read as an option.
pub fn safe_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 1024 && !p.starts_with('-') && !p.chars().any(|c| c.is_control() || c == '"') && Path::new(p).is_absolute()
}

fn skip_dir(name: &str) -> bool {
    let l = name.to_lowercase();
    SKIP_DIRS.iter().any(|s| *s == l)
}

fn walk(dir: &Path, depth: u32, started: &Instant, budget: Duration, seen_dirs: &mut HashSet<PathBuf>, out: &mut Vec<Found>) {
    if depth == 0 || out.len() >= MAX_FOUND || started.elapsed() > budget {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= MAX_FOUND || started.elapsed() > budget {
            return;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            // hidden folders are skipped, except the ones model apps use
            if skip_dir(&name) || (name.starts_with('.') && !matches!(name.as_str(), ".lmstudio" | ".cache" | ".local" | ".config")) {
                continue;
            }
            if seen_dirs.insert(path.clone()) {
                walk(&path, depth - 1, started, budget, seen_dirs, out);
            }
        } else if usable(&name) {
            // symlinks (Hugging Face cache snapshots) point at the real blob: read through them
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            if meta.len() < MIN_BYTES {
                continue;
            }
            let p = path.to_string_lossy().to_string();
            if safe_path(&p) {
                out.push(Found { name: name.trim_end_matches(".gguf").trim_end_matches(".GGUF").to_string(), quant: quant_of(&name), source: source_of(&path), path: p, bytes: meta.len() });
            }
        }
    }
}

/// Look for model files. `deep` also searches whole drives (slower, capped at about 40 seconds).
pub fn scan(deep: bool) -> Vec<Found> {
    let started = Instant::now();
    let budget = Duration::from_secs(if deep { 40 } else { 12 });
    let mut roots = default_roots();
    roots.extend(EXTRA.lock().unwrap().iter().map(PathBuf::from));
    if deep {
        roots.extend(deep_roots());
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in roots {
        // a disconnected network drive can make even "does this folder exist" slow: stop looking when time is up
        if started.elapsed() > budget {
            break;
        }
        if r.is_dir() && seen.insert(r.clone()) {
            walk(&r, if deep { 9 } else { 7 }, &started, budget, &mut seen, &mut out);
        }
    }
    // the same file can be reached by two routes (a shortcut, a nested root): keep one
    let mut keys = HashSet::new();
    out.retain(|f| keys.insert(std::fs::canonicalize(&f.path).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| f.path.clone())));
    out.sort_by_cached_key(|f| f.name.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantisation_is_read_from_the_file_name() {
        assert_eq!(quant_of("Qwen3-8B-Q4_K_M.gguf"), "Q4_K_M");
        assert_eq!(quant_of("llama-3.1-8b-instruct.Q8_0.gguf"), "Q8_0");
        assert_eq!(quant_of("model-IQ3_XXS.gguf"), "IQ3_XXS");
        assert_eq!(quant_of("gemma-2b-f16.gguf"), "F16");
        assert_eq!(quant_of("gemma-3-12b-it-UD-Q8_K_XL.gguf"), "Q8_K_XL");
        assert_eq!(quant_of("plain.gguf"), "");
    }

    #[test]
    fn only_startable_models_are_listed() {
        assert!(usable("a-Q4_K_M.gguf"));
        assert!(usable("big-00001-of-00004.gguf"));
        assert!(!usable("big-00002-of-00004.gguf"));
        assert!(!usable("mmproj-model-f16.gguf"));
        assert!(!usable("notes.txt"));
    }

    #[test]
    fn launch_paths_cannot_become_options_or_break_quoting() {
        assert!(safe_path(if cfg!(windows) { "C:\\models\\a.gguf" } else { "/home/u/models/a b.gguf" }));
        assert!(!safe_path("--help"));
        assert!(!safe_path("relative/a.gguf"));
        assert!(!safe_path("/x/\"a\".gguf"));
        assert!(!safe_path("/x/a\n.gguf"));
    }

    #[test]
    fn a_scan_finds_big_gguf_files_and_ignores_small_or_split_parts() {
        let dir = std::env::temp_dir().join(format!("ezcli-scan-{}", std::process::id()));
        let sub = dir.join("deep").join("er");
        std::fs::create_dir_all(&sub).unwrap();
        let big = |p: &Path| {
            let f = std::fs::File::create(p).unwrap();
            f.set_len(MIN_BYTES + 1).unwrap();
        };
        big(&sub.join("good-Q4_K_M.gguf"));
        big(&sub.join("part-00002-of-00003.gguf"));
        std::fs::write(sub.join("tiny.gguf"), b"x").unwrap();
        let mut out = Vec::new();
        walk(&dir, 6, &Instant::now(), Duration::from_secs(5), &mut HashSet::new(), &mut out);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "good-Q4_K_M");
        assert_eq!(out[0].quant, "Q4_K_M");
    }
}
