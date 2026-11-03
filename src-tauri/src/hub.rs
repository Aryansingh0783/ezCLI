//! A model browser and installer, like the one in LM Studio:
//! - search Hugging Face for GGUF models, list a model's files, download one (resumable, size and SHA-256 checked);
//! - install llama.cpp (the program that runs those files) from its official GitHub release.
//!
//! Only huggingface.co and the llama.cpp release on github.com are contacted, only after the user clicks, and
//! every name that reaches a URL or a path is checked first. Downloads go to `~/.ezcli/models`.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Repo {
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RepoFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub quant: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Progress {
    pub key: String,
    /// `downloading`, `verifying`, `done`, `error` or `cancelled`.
    pub state: &'static str,
    pub bytes: u64,
    pub total: u64,
    pub path: String,
    pub error: String,
    /// A short status line for the screen ("No data yet…"), empty most of the time.
    pub note: String,
}

fn prog(key: &str, state: &'static str) -> Progress {
    Progress { key: key.to_string(), state, bytes: 0, total: 0, path: String::new(), error: String::new(), note: String::new() }
}

/// The last report of every download, so the screen can ask for it instead of depending on events alone.
static STATUS: Mutex<Option<HashMap<String, Progress>>> = Mutex::new(None);

fn remember(p: &Progress) {
    STATUS.lock().unwrap().get_or_insert_with(HashMap::new).insert(p.key.clone(), p.clone());
}

/// The latest state of every download started in this run.
pub fn status() -> Vec<Progress> {
    STATUS.lock().unwrap().as_ref().map(|m| m.values().cloned().collect()).unwrap_or_default()
}

/// Cancel switches of running downloads, by key.
static RUNNING: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

pub fn models_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("models")
}

pub fn llama_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("llama.cpp").join("bin")
}

fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && !s.starts_with(['-', '.']) && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// `owner/name` as Hugging Face writes it.
pub fn valid_repo(id: &str) -> bool {
    let mut p = id.split('/');
    matches!((p.next(), p.next(), p.next()), (Some(a), Some(b), None) if name_ok(a) && name_ok(b))
}

/// A `.gguf` file path inside a repo: plain characters, no `..`, no leading slash or dash.
pub fn valid_file(path: &str) -> bool {
    path.len() <= 300
        && path.to_lowercase().ends_with(".gguf")
        && !path.starts_with(['/', '-'])
        && !path.contains("..")
        && !path.contains("//")
        && path.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
}

fn json(url: &str) -> Result<Value, String> {
    let body = crate::web_context::get(url, 25, 8_000_000).ok_or_else(|| "Could not reach Hugging Face. Check your connection and try again.".to_string())?;
    serde_json::from_str(&body).map_err(|_| "Hugging Face sent an answer that could not be read.".to_string())
}

pub fn parse_search(v: &Value) -> Vec<Repo> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?.to_string();
                    (valid_repo(&id) && !m.get("private").and_then(Value::as_bool).unwrap_or(false)).then(|| Repo {
                        id,
                        downloads: m.get("downloads").and_then(Value::as_u64).unwrap_or(0),
                        likes: m.get("likes").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_files(v: &Value) -> Vec<RepoFile> {
    let mut out: Vec<RepoFile> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    if f.get("type")?.as_str()? != "file" {
                        return None;
                    }
                    let path = f.get("path")?.as_str()?.to_string();
                    let lower = path.to_lowercase();
                    // multi-part models need every part and vision projectors are extras: not offered
                    if !valid_file(&path) || lower.contains("mmproj") || lower.contains("-of-0") {
                        return None;
                    }
                    let size = f.get("lfs").and_then(|l| l.get("size")).and_then(Value::as_u64).or_else(|| f.get("size").and_then(Value::as_u64))?;
                    let sha256 = f.get("lfs").and_then(|l| l.get("oid")).and_then(Value::as_str).unwrap_or("").to_string();
                    Some(RepoFile { quant: crate::local_models::quant_of(&path), path, size, sha256 })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|f| f.size);
    out
}

pub fn search(query: &str) -> Result<Vec<Repo>, String> {
    let q: String = query.trim().chars().take(100).collect();
    let url = format!(
        "https://huggingface.co/api/models?search={}&filter=gguf&sort=downloads&direction=-1&limit=25",
        crate::web_context::percent_encode(&q)
    );
    Ok(parse_search(&json(&url)?))
}

pub fn files(repo: &str) -> Result<Vec<RepoFile>, String> {
    if !valid_repo(repo) {
        return Err("That is not a valid model name.".into());
    }
    Ok(parse_files(&json(&format!("https://huggingface.co/api/models/{repo}/tree/main?recursive=true"))?))
}

fn emit(app: &AppHandle, p: Progress) {
    remember(&p);
    let _ = app.emit("model-download", p);
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// How a transfer behaves. Real downloads use `standard`; tests shorten the waits and talk to a local server.
pub struct FetchOpts {
    proto: &'static str,
    stall_note_secs: u64,
    give_up_secs: u64,
    extra: Vec<&'static str>,
}

impl FetchOpts {
    pub fn standard() -> Self {
        FetchOpts { proto: "=https", stall_note_secs: 30, give_up_secs: 120, extra: Vec::new() }
    }
}

/// One file to fetch.
pub struct Transfer<'a> {
    pub key: &'a str,
    pub url: &'a str,
    pub dest: &'a Path,
    /// The size it must have (0 when unknown).
    pub total: u64,
    /// The SHA-256 it must have (empty when unknown).
    pub sha: &'a str,
}

fn spawn_curl(url: &str, part: &Path, opts: &FetchOpts) -> Result<Child, String> {
    let curl = crate::web_context::curl_path().ok_or("curl was not found on this PC.")?;
    let mut cmd = Command::new(curl);
    cmd.args(["--disable", "--silent", "--show-error", "--location", "--fail", "--max-redirs", "5", "--proto", opts.proto, "--connect-timeout", "20", "--retry", "5", "--retry-delay", "3", "--speed-limit", "1024", "--speed-time", "60", "-C", "-"])
        .args(&opts.extra)
        .arg("-o")
        .arg(part)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map_err(|e| format!("Could not start the download: {e}"))
}

/// Run one download, reporting progress to `sink`, then check size and SHA-256. Returns the final path.
pub fn fetch(sink: &dyn Fn(Progress), t: &Transfer, cancel: &AtomicBool, opts: &FetchOpts) -> Result<PathBuf, String> {
    if let Some(dir) = t.dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the folder {}: {e}", dir.display()))?;
    }
    let part = PathBuf::from(format!("{}.part", t.dest.display()));
    let mut child = spawn_curl(t.url, &part, opts)?;
    // curl's own words about what went wrong, kept for the error message
    let errors = Arc::new(Mutex::new(String::new()));
    let mut reader = child.stderr.take().map(|mut e| {
        let sink = errors.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = e.read_to_string(&mut text);
            *sink.lock().unwrap() = text;
        })
    });
    let said = |reader: &mut Option<std::thread::JoinHandle<()>>| -> String {
        if let Some(r) = reader.take() {
            let _ = r.join();
        }
        let text = errors.lock().unwrap().trim().to_string();
        text.chars().take(300).collect()
    };
    let mut last_size: Option<u64> = None;
    let mut last_move = Instant::now();
    let mut sent: Option<(u64, String)> = None;
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            said(&mut reader);
            return Err("cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(format!("The download could not be watched: {e}")),
        }
        let bytes = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if last_size != Some(bytes) {
            last_size = Some(bytes);
            last_move = Instant::now();
        }
        let idle = last_move.elapsed().as_secs();
        if idle >= opts.give_up_secs {
            let _ = child.kill();
            let _ = child.wait();
            let why = said(&mut reader);
            return Err(format!(
                "No data arrived from Hugging Face for {} seconds, so the download was stopped{}. Check your internet connection, proxy, VPN or antivirus, then try again.",
                opts.give_up_secs,
                if why.is_empty() { String::new() } else { format!(" ({why})") }
            ));
        }
        let note = if idle >= opts.stall_note_secs { format!("No new data for {idle} s: still trying…") } else { String::new() };
        // tell the screen on the first look and whenever the size or the note changes
        if sent.as_ref() != Some(&(bytes, note.clone())) {
            sent = Some((bytes, note.clone()));
            sink(Progress { bytes, total: t.total, note, ..prog(t.key, "downloading") });
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    let why = said(&mut reader);
    if !status.success() {
        let hint = if why.contains("401") || why.contains("403") { " This model may need you to accept its license on huggingface.co first." } else { "" };
        let detail = if why.is_empty() { format!(" (curl exit code {})", status.code().map_or("?".to_string(), |c| c.to_string())) } else { format!(": {}", why.chars().take(240).collect::<String>()) };
        return Err(format!("The download failed{detail}{hint}"));
    }
    let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&part);
        return Err("The download finished but the file is empty. Try again.".into());
    }
    if t.total > 0 && size != t.total {
        let _ = std::fs::remove_file(&part);
        return Err(format!("The file is {size} bytes but should be {}. It was deleted; try again.", t.total));
    }
    if !t.sha.is_empty() {
        sink(Progress { bytes: size, total: t.total, ..prog(t.key, "verifying") });
        let got = sha256_of(&part)?;
        if !got.eq_ignore_ascii_case(t.sha) {
            let _ = std::fs::remove_file(&part);
            return Err("The downloaded file does not match Hugging Face's checksum, so it was deleted. Try again.".into());
        }
    }
    std::fs::rename(&part, t.dest).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(t.dest.to_path_buf())
}

/// What to do when the target file is already on disk: `Some(Ok(path))` it is the file we want, `Some(Err)` something
/// else is in the way, `None` nothing there, so download it.
pub fn already_there(dest: &Path, size: u64) -> Option<Result<String, String>> {
    let meta = std::fs::metadata(dest).ok().filter(|m| m.is_file())?;
    Some(if size == 0 || meta.len() == size {
        Ok(dest.to_string_lossy().into_owned())
    } else {
        Err(format!("A different file named {} is already in that folder. Move it away or choose another folder.", dest.display()))
    })
}

type Job = Box<dyn FnOnce(&AppHandle, &str, &AtomicBool) -> Result<String, String> + Send + 'static>;

/// Run `job` on its own thread. Whatever happens (success, failure, cancel, even a panic) the screen is told how
/// it ended, so a download can never be left looking busy.
fn start(app: AppHandle, key: String, job: Job) -> Result<(), String> {
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut g = RUNNING.lock().unwrap();
        let map = g.get_or_insert_with(HashMap::new);
        if map.contains_key(&key) {
            return Err("That download is already running.".into());
        }
        map.insert(key.clone(), flag.clone());
    }
    // a fresh record, so an old finished one can never be mistaken for this run
    remember(&prog(&key, "downloading"));
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&app, &key, &flag))).unwrap_or_else(|_| Err("The download stopped unexpectedly.".into()));
        if let Some(m) = RUNNING.lock().unwrap().as_mut() {
            m.remove(&key);
        }
        let p = match result {
            Ok(path) => Progress { path, ..prog(&key, "done") },
            Err(e) if e == "cancelled" => prog(&key, "cancelled"),
            Err(e) => Progress { error: e, ..prog(&key, "error") },
        };
        emit(&app, p);
    });
    Ok(())
}

pub fn cancel(key: &str) {
    if let Some(f) = RUNNING.lock().unwrap().as_ref().and_then(|m| m.get(key)) {
        f.store(true, Ordering::Relaxed);
    }
}

/// A folder the user chose to save models in: absolute, plain, and not a file.
pub fn valid_dir(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= 1024
        && !d.chars().any(|c| c.is_control() || c == '"')
        && Path::new(d).is_absolute()
        && !d.split(['/', '\\']).any(|part| part == "..")
        && !Path::new(d).is_file()
}

/// Where a model file will be saved: `<folder>/<owner>__<repo>/<file>`, in the chosen folder or the default one.
pub fn destination(dir: Option<&str>, repo: &str, file: &str) -> Result<PathBuf, String> {
    let root = match dir.map(str::trim).filter(|d| !d.is_empty()) {
        None => models_dir(),
        Some(d) if valid_dir(d) => PathBuf::from(d),
        Some(_) => return Err("That is not a usable folder. Pick an existing folder or a full path such as D:\\Models.".into()),
    };
    Ok(root.join(repo.replace('/', "__")).join(file.rsplit('/').next().unwrap_or(file)))
}

/// Download one model file in the background. Progress arrives as `model-download` events and through `status`.
pub fn download_model(app: AppHandle, repo: String, file: String, size: u64, sha: String, dir: Option<String>) -> Result<String, String> {
    if !valid_repo(&repo) || !valid_file(&file) {
        return Err("That model file name is not valid.".into());
    }
    let dest = destination(dir.as_deref(), &repo, &file)?;
    let key = format!("{repo}/{file}");
    let url = format!("https://huggingface.co/{repo}/resolve/main/{file}");
    start(
        app,
        key.clone(),
        Box::new(move |app, key, cancel| {
            // already there: report it as done instead of downloading it again (and never leave the screen waiting)
            if let Some(found) = already_there(&dest, size) {
                return found;
            }
            let t = Transfer { key, url: &url, dest: &dest, total: size, sha: &sha };
            fetch(&|p| emit(app, p), &t, cancel, &FetchOpts::standard()).map(|p| p.to_string_lossy().into_owned())
        }),
    )?;
    Ok(key)
}

// ---------------------------------------------------------------------------------------------- llama.cpp

#[derive(Serialize)]
pub struct LlamaStatus {
    pub installed: bool,
    pub path: String,
    pub plan: String,
}

pub fn llama_exe_name() -> &'static str {
    if cfg!(windows) { "llama-cli.exe" } else { "llama-cli" }
}

pub fn llama_status() -> LlamaStatus {
    let found = crate::agents::resolve_command("llama-cli");
    LlamaStatus { installed: found.is_some(), path: found.unwrap_or_default(), plan: plan_text() }
}

/// What the installer will fetch on this machine, for the button's note.
fn plan_text() -> String {
    match build_wanted() {
        Some(w) => format!("the {} build from the official llama.cpp release on GitHub", w.replace('-', " ")),
        None => "no build for this system".into(),
    }
}

/// The release asset kind for this machine, e.g. `win-vulkan-x64`. Vulkan runs on NVIDIA, AMD and Intel GPUs
/// without extra runtime files, so it is the GPU choice.
pub fn build_wanted() -> Option<String> {
    let gpu = if cfg!(windows) {
        crate::system_profile::detect().gpu_name.is_some()
    } else {
        Path::new("/dev/dri").exists() || Path::new("/proc/driver/nvidia").exists()
    };
    let arch = std::env::consts::ARCH;
    Some(match (std::env::consts::OS, arch) {
        ("windows", "x86_64") => if gpu { "win-vulkan-x64" } else { "win-cpu-x64" },
        ("windows", "aarch64") => "win-cpu-arm64",
        ("linux", "x86_64") => if gpu { "ubuntu-vulkan-x64" } else { "ubuntu-x64" },
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        _ => return None,
    }
    .to_string())
}

/// The asset for `wanted` among a release's file names: `llama-b1234-bin-<wanted>.zip` or `.tar.gz`.
pub fn pick_asset<'a>(names: &'a [String], wanted: &str) -> Option<&'a String> {
    let needle = format!("bin-{wanted}");
    names
        .iter()
        .filter(|n| {
            let l = n.to_lowercase();
            l.starts_with("llama-") && l.contains(&needle) && (l.ends_with(".zip") || l.ends_with(".tar.gz"))
        })
        // `bin-win-cpu-x64` must not match `bin-win-cpu-x64-something`: prefer the exact ending
        .min_by_key(|n| {
            let l = n.to_lowercase();
            let stem = l.trim_end_matches(".zip").trim_end_matches(".tar.gz");
            usize::from(!stem.ends_with(&needle))
        })
}

fn find_file(dir: &Path, name: &str, depth: u32) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_file() && e.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(p);
        }
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name, depth - 1) {
                return Some(f);
            }
        }
    }
    None
}

fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let is_zip = archive.to_string_lossy().to_lowercase().ends_with(".zip");
    let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
    let a = archive.to_string_lossy().to_string();
    let d = into.to_string_lossy().to_string();
    if is_zip {
        if !cfg!(windows) {
            candidates.push(("unzip".into(), vec!["-q".into(), "-o".into(), a.clone(), "-d".into(), d.clone()]));
        }
        // Windows 10+ and macOS ship a tar that reads zip files
        candidates.push(("tar".into(), vec!["-xf".into(), a, "-C".into(), d]));
    } else {
        candidates.push(("tar".into(), vec!["-xzf".into(), a, "-C".into(), d]));
    }
    let mut last = String::from("no tool to unpack the download was found");
    for (prog, args) in candidates {
        let exe = if cfg!(windows) && prog == "tar" {
            std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32").join("tar.exe").to_string_lossy().into_owned()).unwrap_or(prog.clone())
        } else {
            crate::agents::resolve_command(&prog).unwrap_or(prog.clone())
        };
        let mut cmd = Command::new(exe);
        cmd.args(&args).stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        match cmd.output() {
            Ok(o) if o.status.success() => return Ok(()),
            Ok(o) => last = String::from_utf8_lossy(&o.stderr).trim().chars().take(200).collect(),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Could not unpack the download: {last}"))
}

const RELEASE_PREFIX: &str = "https://github.com/ggml-org/llama.cpp/releases/download/";

/// One downloadable file of a release.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

fn assets_of(rel: &Value) -> Vec<Asset> {
    rel.get("assets")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let url = x.get("browser_download_url")?.as_str()?.to_string();
                    url.starts_with(RELEASE_PREFIX).then(|| Asset {
                        name: x.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                        size: x.get("size").and_then(Value::as_u64).unwrap_or(0),
                        sha256: x.get("digest").and_then(Value::as_str).and_then(|d| d.strip_prefix("sha256:")).unwrap_or("").to_string(),
                        url,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The build for `wanted` among one release's files.
pub fn build_in(rel: &Value, wanted: &str) -> Option<Asset> {
    let assets = assets_of(rel);
    let names: Vec<String> = assets.iter().map(|a| a.name.clone()).collect();
    let name = pick_asset(&names, wanted)?;
    assets.into_iter().find(|a| &a.name == name)
}

/// llama.cpp's newest "stable" release holds no binaries, only `nightly-tag.txt`: the name of the release that
/// does. This returns that file's address when the release has it.
pub fn nightly_pointer(rel: &Value) -> Option<String> {
    assets_of(rel).into_iter().find(|a| a.name == "nightly-tag.txt").map(|a| a.url)
}

/// A release tag as llama.cpp writes it (`b6123`): plain characters only, so it is safe in a URL.
pub fn valid_tag(t: &str) -> bool {
    !t.is_empty() && t.len() <= 40 && !t.starts_with(['-', '.']) && t.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn github(url: &str) -> Result<Value, String> {
    let body = crate::web_context::get(url, 25, 6_000_000).ok_or("Could not read the llama.cpp release list from GitHub. Check your connection and try again.")?;
    serde_json::from_str(&body).map_err(|_| "GitHub sent an answer that could not be read.".to_string())
}

/// Find the download for `wanted`. The latest release may carry it; if it only points at a nightly release, follow
/// the pointer; as a last resort take the newest of the recent releases that has it.
fn locate_build(wanted: &str) -> Result<Asset, String> {
    const API: &str = "https://api.github.com/repos/ggml-org/llama.cpp/releases";
    let latest = github(&format!("{API}/latest"))?;
    if let Some(a) = build_in(&latest, wanted) {
        return Ok(a);
    }
    if let Some(ptr) = nightly_pointer(&latest) {
        let tag = crate::web_context::get(&ptr, 20, 1_000).unwrap_or_default().trim().to_string();
        if valid_tag(&tag) {
            if let Some(a) = github(&format!("{API}/tags/{tag}")).ok().and_then(|r| build_in(&r, wanted)) {
                return Ok(a);
            }
        }
    }
    let recent = github(&format!("{API}?per_page=15"))?;
    if let Some(a) = recent.as_array().and_then(|rs| rs.iter().find_map(|r| build_in(r, wanted))) {
        return Ok(a);
    }
    Err(format!("None of the recent llama.cpp releases has a \"{wanted}\" build. You can install llama.cpp yourself from github.com/ggml-org/llama.cpp/releases and restart ezCLI."))
}

/// Download llama.cpp's official release for this machine into `~/.ezcli/llama.cpp/bin`.
pub fn install_llama(app: AppHandle) -> Result<String, String> {
    let wanted = build_wanted().ok_or("There is no ready-made llama.cpp build for this system. Build it from github.com/ggml-org/llama.cpp.")?;
    start(app, "llama.cpp".into(), Box::new(move |app, key, cancel| {
        emit(app, prog(key, "downloading"));
        let asset = locate_build(&wanted)?;
        let root = llama_dir().parent().map(Path::to_path_buf).unwrap_or_default();
        let archive = root.join(&asset.name);
        // GitHub publishes each file's SHA-256 digest; when it does, the download is checked against it
        let t = Transfer { key, url: &asset.url, dest: &archive, total: asset.size, sha: &asset.sha256 };
        let got = fetch(&|p| emit(app, p), &t, cancel, &FetchOpts::standard())?;
        let tmp = root.join("unpack");
        let _ = std::fs::remove_dir_all(&tmp);
        extract(&got, &tmp)?;
        let exe = find_file(&tmp, llama_exe_name(), 4).ok_or("The download did not contain llama-cli.")?;
        let bin_src = exe.parent().ok_or("bad layout")?.to_path_buf();
        let bin = llama_dir();
        let _ = std::fs::remove_dir_all(&bin);
        std::fs::rename(&bin_src, &bin).map_err(|e| format!("Could not install llama.cpp: {e}"))?;
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_file(&archive);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(rd) = std::fs::read_dir(&bin) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.starts_with("llama-") && !n.contains('.') {
                        let _ = std::fs::set_permissions(e.path(), std::fs::Permissions::from_mode(0o755));
                    }
                }
            }
        }
        Ok(bin.join(llama_exe_name()).to_string_lossy().into_owned())
    }))?;
    Ok("llama.cpp".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repo_and_file_names_are_checked() {
        assert!(valid_repo("Qwen/Qwen3-8B-GGUF"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("../x"));
        assert!(!valid_repo("-x/y"));
        assert!(!valid_repo("a b/c"));
        assert!(valid_file("Qwen3-8B-Q4_K_M.gguf"));
        assert!(valid_file("sub/dir/model.Q8_0.gguf"));
        assert!(!valid_file("../model.gguf"));
        assert!(!valid_file("/etc/x.gguf"));
        assert!(!valid_file("model.bin"));
        assert!(!valid_file("a b.gguf"));
        assert!(!valid_file("a?x=1.gguf"));
    }

    #[test]
    fn search_results_are_read_and_private_ones_dropped() {
        let v = json!([{"id":"Qwen/Qwen3-8B-GGUF","downloads":7,"likes":3},{"id":"x/y","private":true},{"id":"bad id/x"}]);
        let r = parse_search(&v);
        assert_eq!(r, vec![Repo { id: "Qwen/Qwen3-8B-GGUF".into(), downloads: 7, likes: 3 }]);
    }

    #[test]
    fn file_lists_keep_whole_models_with_their_checksum() {
        let v = json!([
            {"type":"file","path":"README.md","size":5},
            {"type":"file","path":"m-Q8_0.gguf","size":900,"lfs":{"oid":"bb","size":900}},
            {"type":"file","path":"m-Q4_K_M.gguf","size":500,"lfs":{"oid":"aa","size":500}},
            {"type":"file","path":"mmproj-m-F16.gguf","size":50,"lfs":{"oid":"cc","size":50}},
            {"type":"file","path":"big-00001-of-00003.gguf","size":50,"lfs":{"oid":"dd","size":50}},
            {"type":"directory","path":"sub"}
        ]);
        let f = parse_files(&v);
        assert_eq!(f.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["m-Q4_K_M.gguf", "m-Q8_0.gguf"]);
        assert_eq!(f[0].sha256, "aa");
        assert_eq!(f[0].quant, "Q4_K_M");
    }

    #[test]
    fn the_right_llama_cpp_build_is_chosen() {
        let names: Vec<String> = [
            "cudart-llama-bin-win-cuda-12.4-x64.zip",
            "llama-b6000-bin-win-cuda-12.4-x64.zip",
            "llama-b6000-bin-win-vulkan-x64.zip",
            "llama-b6000-bin-win-cpu-x64.zip",
            "llama-b6000-bin-ubuntu-x64.tar.gz",
            "llama-b6000-bin-ubuntu-vulkan-x64.tar.gz",
            "llama-b6000-bin-macos-arm64.tar.gz",
            "llama-b6000-xcframework.zip",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(pick_asset(&names, "win-vulkan-x64").unwrap(), "llama-b6000-bin-win-vulkan-x64.zip");
        assert_eq!(pick_asset(&names, "win-cpu-x64").unwrap(), "llama-b6000-bin-win-cpu-x64.zip");
        assert_eq!(pick_asset(&names, "ubuntu-x64").unwrap(), "llama-b6000-bin-ubuntu-x64.tar.gz");
        assert_eq!(pick_asset(&names, "ubuntu-vulkan-x64").unwrap(), "llama-b6000-bin-ubuntu-vulkan-x64.tar.gz");
        assert_eq!(pick_asset(&names, "macos-arm64").unwrap(), "llama-b6000-bin-macos-arm64.tar.gz");
        assert!(pick_asset(&names, "win-cpu-arm64").is_none());
    }

    fn release(assets: &[(&str, u64)]) -> Value {
        json!({"assets": assets.iter().map(|(n, size)| json!({
            "name": n, "size": size, "digest": format!("sha256:{}", "ab".repeat(32)),
            "browser_download_url": format!("https://github.com/ggml-org/llama.cpp/releases/download/b9000/{n}")
        })).collect::<Vec<_>>()})
    }

    #[test]
    fn a_stable_release_with_only_a_pointer_file_is_followed_to_the_nightly_build() {
        // what GitHub's "latest" release looks like for llama.cpp today: one file, nightly-tag.txt
        let stable = release(&[("nightly-tag.txt", 6)]);
        assert!(build_in(&stable, "win-vulkan-x64").is_none());
        assert_eq!(nightly_pointer(&stable).unwrap(), "https://github.com/ggml-org/llama.cpp/releases/download/b9000/nightly-tag.txt");
        // ...and the nightly release it names holds the builds
        let nightly = release(&[
            ("llama-b9123-bin-win-vulkan-x64.zip", 40_000_000),
            ("llama-b9123-bin-win-vulkan-arm64.zip", 41_000_000),
            ("llama-b9123-bin-win-cpu-x64.zip", 30_000_000),
            ("cudart-llama-bin-win-cuda-12.4-x64.zip", 9_000_000),
            ("llama-b9123-bin-ubuntu-vulkan-x64.tar.gz", 50_000_000),
        ]);
        let a = build_in(&nightly, "win-vulkan-x64").unwrap();
        assert_eq!(a.name, "llama-b9123-bin-win-vulkan-x64.zip");
        assert_eq!(a.size, 40_000_000);
        assert_eq!(a.sha256, "ab".repeat(32));
        assert_eq!(build_in(&nightly, "ubuntu-vulkan-x64").unwrap().name, "llama-b9123-bin-ubuntu-vulkan-x64.tar.gz");
    }

    #[test]
    fn files_from_anywhere_but_the_official_release_are_ignored() {
        let rel = json!({"assets": [{"name": "llama-b1-bin-win-cpu-x64.zip", "size": 1, "browser_download_url": "https://evil.example/llama-b1-bin-win-cpu-x64.zip"}]});
        assert!(build_in(&rel, "win-cpu-x64").is_none());
    }

    #[test]
    fn release_tags_are_checked_before_they_reach_a_url() {
        assert!(valid_tag("b9123"));
        assert!(valid_tag("v0.1.2"));
        assert!(!valid_tag("../x"));
        assert!(!valid_tag("b1/../../etc"));
        assert!(!valid_tag(""));
        assert!(!valid_tag("-rf"));
        assert!(!valid_tag("a b"));
    }

    #[test]
    fn a_download_is_hashed_in_chunks() {
        let p = std::env::temp_dir().join(format!("ezcli-hash-{}", std::process::id()));
        std::fs::write(&p, b"abc").unwrap();
        let h = sha256_of(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    // ---------------------------------------------------------------- the downloader, against a real local server

    use std::io::Write as _;
    use std::net::{TcpListener, TcpStream};

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Normal,
        Slow,
        Stall,
        Missing,
    }

    struct Server {
        port: u16,
        stop: Arc<AtomicBool>,
        /// The byte each request asked to start from (0 for a plain request).
        asked: Arc<Mutex<Vec<usize>>>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    impl Server {
        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/model.gguf", self.port)
        }
    }

    fn range_start(request: &str) -> usize {
        request
            .lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_string))
            .and_then(|r| r.split('-').next().and_then(|n| n.trim().parse().ok()))
            .unwrap_or(0)
    }

    fn handle(mut c: TcpStream, body: &[u8], mode: Mode, stop: &AtomicBool, asked: &Mutex<Vec<usize>>) {
        let mut buf = [0u8; 4096];
        let n = c.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]).to_string();
        let from = range_start(&request);
        asked.lock().unwrap().push(from);
        match mode {
            Mode::Missing => {
                let _ = c.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
            Mode::Stall => {
                let _ = c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n");
                let _ = c.write_all(&body[..body.len().min(100)]);
                let _ = c.flush();
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            Mode::Normal | Mode::Slow => {
                if from >= body.len() && from > 0 {
                    let _ = c.write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }
                let rest = &body[from..];
                let head = if from > 0 {
                    format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n", rest.len(), from, body.len() - 1, body.len())
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", rest.len())
                };
                let _ = c.write_all(head.as_bytes());
                if mode == Mode::Slow {
                    for chunk in rest.chunks(10_000) {
                        if stop.load(Ordering::Relaxed) || c.write_all(chunk).is_err() {
                            return;
                        }
                        let _ = c.flush();
                        std::thread::sleep(Duration::from_millis(70));
                    }
                } else {
                    let _ = c.write_all(rest);
                }
            }
        }
    }

    fn serve(body: Vec<u8>, mode: Mode) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let asked = Arc::new(Mutex::new(Vec::new()));
        let flag = stop.clone();
        let log = asked.clone();
        let body = Arc::new(body);
        std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((c, _)) => {
                        let (b, f, l) = (body.clone(), flag.clone(), log.clone());
                        c.set_nonblocking(false).ok();
                        std::thread::spawn(move || handle(c, &b, mode, &f, &l));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(15)),
                }
            }
        });
        Server { port, stop, asked }
    }

    fn local_opts() -> FetchOpts {
        FetchOpts { proto: "=http", stall_note_secs: 1, give_up_secs: 3, extra: vec!["--noproxy", "*"] }
    }

    fn bytes_of(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i * 31 + i / 7) % 251) as u8).collect()
    }

    fn sha_hex(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ezcli-hub-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run(url: &str, dest: &Path, total: u64, sha: &str, cancel: &AtomicBool) -> (Result<PathBuf, String>, Vec<Progress>) {
        let events = Mutex::new(Vec::new());
        let t = Transfer { key: "k", url, dest, total, sha };
        let r = fetch(&|p| events.lock().unwrap().push(p), &t, cancel, &local_opts());
        (r, events.into_inner().unwrap())
    }

    #[test]
    fn a_download_is_saved_checked_and_leaves_no_partial_file() {
        let body = bytes_of(3_000_000);
        let srv = serve(body.clone(), Mode::Normal);
        let dir = scratch("ok");
        let dest = dir.join("sub").join("m.gguf");
        let (r, _) = run(&srv.url(), &dest, body.len() as u64, &sha_hex(&body), &AtomicBool::new(false));
        assert_eq!(r.unwrap(), dest);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!dir.join("sub").join("m.gguf.part").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_wrong_checksum_deletes_the_file_and_says_so() {
        let body = bytes_of(200_000);
        let srv = serve(body.clone(), Mode::Normal);
        let dir = scratch("sha");
        let dest = dir.join("m.gguf");
        let (r, _) = run(&srv.url(), &dest, body.len() as u64, &"0".repeat(64), &AtomicBool::new(false));
        assert!(r.unwrap_err().contains("checksum"));
        assert!(!dest.exists() && !dir.join("m.gguf.part").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_of_the_wrong_size_is_refused() {
        let body = bytes_of(100_000);
        let srv = serve(body.clone(), Mode::Normal);
        let dir = scratch("size");
        let dest = dir.join("m.gguf");
        let (r, _) = run(&srv.url(), &dest, 999, "", &AtomicBool::new(false));
        assert!(r.unwrap_err().contains("should be 999"));
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_file_reports_the_server_answer() {
        let srv = serve(Vec::new(), Mode::Missing);
        let dir = scratch("404");
        let (r, _) = run(&srv.url(), &dir.join("m.gguf"), 10, "", &AtomicBool::new(false));
        let e = r.unwrap_err();
        assert!(e.starts_with("The download failed") && e.contains("404"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_download_that_stops_receiving_data_says_so_and_gives_up() {
        let srv = serve(bytes_of(1000), Mode::Stall);
        let dir = scratch("stall");
        let started = Instant::now();
        let (r, events) = run(&srv.url(), &dir.join("m.gguf"), 1_000_000, "", &AtomicBool::new(false));
        let e = r.unwrap_err();
        assert!(e.contains("No data arrived"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(15), "gave up too late");
        assert!(events.iter().any(|p| p.note.contains("No new data")), "no stall note was sent");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn progress_is_reported_while_bytes_arrive_and_cancel_keeps_the_partial_file() {
        let body = bytes_of(400_000);
        let srv = serve(body.clone(), Mode::Slow);
        let dir = scratch("cancel");
        let dest = dir.join("m.gguf");
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1400));
            c2.store(true, Ordering::Relaxed);
        });
        let (r, events) = run(&srv.url(), &dest, body.len() as u64, "", &cancel);
        assert_eq!(r.unwrap_err(), "cancelled");
        let sizes: Vec<u64> = events.iter().map(|p| p.bytes).collect();
        assert!(sizes.windows(2).all(|w| w[0] <= w[1]), "progress went backwards: {sizes:?}");
        assert!(sizes.iter().filter(|b| **b > 0).count() >= 2, "progress did not move: {sizes:?}");
        assert!(events.iter().all(|p| p.state == "downloading" && p.total == body.len() as u64));
        assert!(dir.join("m.gguf.part").is_file(), "the partial file must stay so the download can resume");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_interrupted_download_resumes_from_the_partial_file() {
        let body = bytes_of(2_000_000);
        let srv = serve(body.clone(), Mode::Normal);
        let dir = scratch("resume");
        let dest = dir.join("m.gguf");
        std::fs::write(dir.join("m.gguf.part"), &body[..800_000]).unwrap();
        let (r, _) = run(&srv.url(), &dest, body.len() as u64, &sha_hex(&body), &AtomicBool::new(false));
        assert_eq!(r.unwrap(), dest);
        assert_eq!(std::fs::read(&dest).unwrap(), body, "the resumed file differs from the original");
        // and it really did ask only for the missing part, not the whole file again
        assert_eq!(*srv.asked.lock().unwrap(), vec![800_000], "the download did not resume from byte 800000");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_is_already_there_counts_as_done_and_a_different_one_is_not_overwritten() {
        let dir = scratch("there");
        let f = dir.join("m.gguf");
        assert!(already_there(&f, 5).is_none());
        std::fs::write(&f, b"12345").unwrap();
        assert_eq!(already_there(&f, 5).unwrap().unwrap(), f.to_string_lossy());
        assert_eq!(already_there(&f, 0).unwrap().unwrap(), f.to_string_lossy());
        assert!(already_there(&f, 6).unwrap().unwrap_err().contains("different file"));
        assert!(already_there(&dir, 5).is_none(), "a folder is not a model file");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_save_folder_is_checked_and_files_go_in_a_folder_per_model() {
        let base = std::env::temp_dir();
        let b = base.to_string_lossy().to_string();
        assert!(valid_dir(&b));
        assert!(!valid_dir(""));
        assert!(!valid_dir("relative/path"));
        assert!(!valid_dir(&format!("{b}/../x")));
        assert!(!valid_dir(&format!("{b}\\..\\x")));
        assert!(!valid_dir(&format!("{b}/\"x")));
        assert!(!valid_dir(&format!("{b}/x\ny")));
        let d = destination(Some(&b), "Qwen/Qwen3-8B-GGUF", "sub/Qwen3-8B-Q4_K_M.gguf").unwrap();
        assert_eq!(d, base.join("Qwen__Qwen3-8B-GGUF").join("Qwen3-8B-Q4_K_M.gguf"));
        assert_eq!(destination(None, "a/b", "m.gguf").unwrap(), models_dir().join("a__b").join("m.gguf"));
        assert_eq!(destination(Some("  "), "a/b", "m.gguf").unwrap(), models_dir().join("a__b").join("m.gguf"));
        assert!(destination(Some("relative"), "a/b", "m.gguf").is_err());
    }

    #[test]
    fn a_new_download_replaces_the_old_record_so_a_finished_one_is_never_mistaken_for_it() {
        remember(&Progress { path: "/x".into(), ..prog("status-test", "done") });
        assert_eq!(status().iter().find(|p| p.key == "status-test").unwrap().state, "done");
        remember(&prog("status-test", "downloading"));
        let now: Vec<_> = status().into_iter().filter(|p| p.key == "status-test").collect();
        assert_eq!(now.len(), 1);
        assert_eq!(now[0].state, "downloading");
        assert!(now[0].path.is_empty());
    }

    // ---------------------------------------------------------------- unpacking llama.cpp

    #[test]
    fn llama_cli_is_found_in_a_flat_archive_and_in_one_with_a_top_folder() {
        let dir = scratch("layout");
        // Windows zips are flat; Linux/macOS tarballs have one top folder (llama-<tag>/)
        std::fs::create_dir_all(dir.join("flat")).unwrap();
        std::fs::write(dir.join("flat").join(llama_exe_name()), b"x").unwrap();
        std::fs::create_dir_all(dir.join("nested").join("llama-b9000")).unwrap();
        std::fs::write(dir.join("nested").join("llama-b9000").join(llama_exe_name()), b"x").unwrap();
        assert_eq!(find_file(&dir.join("flat"), llama_exe_name(), 4).unwrap().parent().unwrap(), dir.join("flat"));
        assert_eq!(find_file(&dir.join("nested"), llama_exe_name(), 4).unwrap().parent().unwrap(), dir.join("nested").join("llama-b9000"));
        assert!(find_file(&dir.join("flat"), "nothing-here", 4).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_tar_gz_with_a_top_folder_is_unpacked_with_its_programs_beside_each_other() {
        let dir = scratch("untar");
        let src = dir.join("src").join("llama-b9000");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("llama-cli"), b"#!/bin/sh\n").unwrap();
        std::fs::write(src.join("libggml.so"), b"lib").unwrap();
        let archive = dir.join("llama-b9000-bin-ubuntu-x64.tar.gz");
        let made = Command::new("tar").args(["-czf"]).arg(&archive).arg("-C").arg(dir.join("src")).arg("llama-b9000").status().unwrap();
        assert!(made.success());
        let out = dir.join("unpack");
        extract(&archive, &out).unwrap();
        let exe = find_file(&out, "llama-cli", 4).expect("llama-cli was not found after unpacking");
        assert!(exe.parent().unwrap().join("libggml.so").is_file(), "the libraries must sit beside llama-cli");
        // a broken archive is an error with a reason, not a crash
        std::fs::write(&archive, b"not an archive").unwrap();
        assert!(extract(&archive, &dir.join("bad")).unwrap_err().starts_with("Could not unpack the download"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
