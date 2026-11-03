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
use std::time::Duration;
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

#[derive(Serialize, Clone)]
struct Progress {
    key: String,
    state: &'static str,
    bytes: u64,
    total: u64,
    path: String,
    error: String,
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

fn spawn_curl(url: &str, part: &Path) -> Result<Child, String> {
    let curl = crate::web_context::curl_path().ok_or("curl was not found on this PC.")?;
    let mut cmd = Command::new(curl);
    cmd.args(["--disable", "--silent", "--show-error", "--location", "--fail", "--max-redirs", "5", "--proto", "=https", "--connect-timeout", "20", "--retry", "3", "-C", "-", "-o"])
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

/// Run one download to `dest`, reporting progress, then check size and SHA-256. Returns the final path.
fn fetch(app: &AppHandle, key: &str, url: &str, dest: &Path, total: u64, sha: &str, cancel: &AtomicBool) -> Result<PathBuf, String> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut child = spawn_curl(url, &part)?;
    let mut last = 0;
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        let bytes = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if bytes != last {
            last = bytes;
            emit(app, Progress { key: key.into(), state: "downloading", bytes, total, path: String::new(), error: String::new() });
        }
        std::thread::sleep(Duration::from_millis(400));
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        let hint = if err.contains("401") || err.contains("403") { " This model may need you to accept its license on huggingface.co first." } else { "" };
        return Err(format!("The download failed: {}{hint}", err.trim().chars().take(200).collect::<String>()));
    }
    let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if total > 0 && size != total {
        let _ = std::fs::remove_file(&part);
        return Err(format!("The file is {size} bytes but should be {total}. It was deleted; try again."));
    }
    if !sha.is_empty() {
        emit(app, Progress { key: key.into(), state: "verifying", bytes: size, total, path: String::new(), error: String::new() });
        let got = sha256_of(&part)?;
        if !got.eq_ignore_ascii_case(sha) {
            let _ = std::fs::remove_file(&part);
            return Err("The downloaded file does not match Hugging Face's checksum, so it was deleted. Try again.".into());
        }
    }
    std::fs::rename(&part, dest).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(dest.to_path_buf())
}

fn start(app: AppHandle, key: String, job: impl FnOnce(&AppHandle, &str, &AtomicBool) -> Result<String, String> + Send + 'static) -> Result<(), String> {
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut g = RUNNING.lock().unwrap();
        let map = g.get_or_insert_with(HashMap::new);
        if map.contains_key(&key) {
            return Err("That download is already running.".into());
        }
        map.insert(key.clone(), flag.clone());
    }
    std::thread::spawn(move || {
        let result = job(&app, &key, &flag);
        if let Some(m) = RUNNING.lock().unwrap().as_mut() {
            m.remove(&key);
        }
        let p = match result {
            Ok(path) => Progress { key, state: "done", bytes: 0, total: 0, path, error: String::new() },
            Err(e) if e == "cancelled" => Progress { key, state: "cancelled", bytes: 0, total: 0, path: String::new(), error: String::new() },
            Err(e) => Progress { key, state: "error", bytes: 0, total: 0, path: String::new(), error: e },
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

/// Download one model file in the background. Progress arrives as `model-download` events.
pub fn download_model(app: AppHandle, repo: String, file: String, size: u64, sha: String) -> Result<String, String> {
    if !valid_repo(&repo) || !valid_file(&file) {
        return Err("That model file name is not valid.".into());
    }
    let key = format!("{repo}/{file}");
    let base = file.rsplit('/').next().unwrap_or(&file).to_string();
    let dest = models_dir().join(repo.replace('/', "__")).join(base);
    let url = format!("https://huggingface.co/{repo}/resolve/main/{file}");
    if dest.is_file() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    start(app, key.clone(), move |app, key, cancel| fetch(app, key, &url, &dest, size, &sha, cancel).map(|p| p.to_string_lossy().into_owned()))?;
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

/// Download llama.cpp's latest official release for this machine into `~/.ezcli/llama.cpp/bin`.
pub fn install_llama(app: AppHandle) -> Result<String, String> {
    let wanted = build_wanted().ok_or("There is no ready-made llama.cpp build for this system. Build it from github.com/ggml-org/llama.cpp.")?;
    start(app, "llama.cpp".into(), move |app, key, cancel| {
        emit(app, Progress { key: key.into(), state: "downloading", bytes: 0, total: 0, path: String::new(), error: String::new() });
        let rel = crate::web_context::get("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", 25, 4_000_000)
            .and_then(|b| serde_json::from_str::<Value>(&b).ok())
            .ok_or("Could not read the llama.cpp release list from GitHub. Check your connection and try again.")?;
        let assets: Vec<&Value> = rel.get("assets").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        let names: Vec<String> = assets.iter().filter_map(|a| a.get("name").and_then(Value::as_str).map(str::to_string)).collect();
        let name = pick_asset(&names, &wanted).ok_or_else(|| format!("This release has no \"{wanted}\" build. Available: {}", names.iter().take(12).cloned().collect::<Vec<_>>().join(", ")))?.clone();
        let asset = assets.iter().find(|a| a.get("name").and_then(Value::as_str) == Some(&name)).ok_or("asset vanished")?;
        let url = asset.get("browser_download_url").and_then(Value::as_str).ok_or("The release has no download link.")?.to_string();
        if !url.starts_with("https://github.com/ggml-org/llama.cpp/releases/download/") {
            return Err("The download link is not from the official llama.cpp release, so it was refused.".into());
        }
        let total = asset.get("size").and_then(Value::as_u64).unwrap_or(0);
        let sha = asset.get("digest").and_then(Value::as_str).and_then(|d| d.strip_prefix("sha256:")).unwrap_or("").to_string();
        let root = llama_dir().parent().map(Path::to_path_buf).unwrap_or_default();
        let archive = root.join(&name);
        // llama.cpp's own checksum is only available when GitHub publishes the file's digest
        let got = fetch(app, key, &url, &archive, total, &sha, cancel)?;
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
    })?;
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

    #[test]
    fn a_download_is_hashed_in_chunks() {
        let p = std::env::temp_dir().join(format!("ezcli-hash-{}", std::process::id()));
        std::fs::write(&p, b"abc").unwrap();
        let h = sha256_of(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
