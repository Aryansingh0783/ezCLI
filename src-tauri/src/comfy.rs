//! ComfyUI (github.com/comfyanonymous/ComfyUI): the local image and video generator behind the
//! Create panel. ezCLI does not bundle or install it; it talks to one that is already running on
//! this computer, over ComfyUI's own HTTP API. No account and no key are involved, and every
//! address built here is loopback.
//!
//! The front end decides what to ask (see `src/core/comfy.ts`); this file only carries the request,
//! and refuses any path or file name outside the short list the panel needs.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// ComfyUI's default port. ComfyUI Desktop uses 8000.
pub const DEFAULT_PORT: u16 = 8188;

pub fn valid_port(port: u16) -> bool {
    port >= 1024
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// What the panel may read: is it running, which model files it has, the queue, and a job's result.
pub fn readable(path: &str) -> bool {
    let known = path == "/system_stats" || path == "/queue" || path.starts_with("/models/") || path.starts_with("/history/");
    known && !path.contains("..") && path.len() < 200 && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-'))
}

/// A file ComfyUI wrote to its output folder: a bare name with a picture or video ending.
pub fn output_name(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    !name.is_empty()
        && name.len() < 200
        && !name.contains("..")
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
        && matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "webm" | "mp4")
}

/// The folder inside ComfyUI's output folder. Empty, or plain names separated by `/`.
pub fn output_folder(folder: &str) -> bool {
    folder.len() < 200 && !folder.contains("..") && !folder.starts_with('/') && folder.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/'))
}

pub fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

pub fn view_url(port: u16, name: &str, folder: &str) -> String {
    let enc = crate::web_context::percent_encode;
    format!("{}/view?filename={}&subfolder={}&type=output", base(port), enc(name), enc(folder))
}

pub fn get(port: u16, path: &str) -> Option<String> {
    if !valid_port(port) || !readable(path) {
        return None;
    }
    crate::web_context::get(&format!("{}{path}", base(port)), 5, 4 * 1024 * 1024)
}

fn curl() -> Result<Command, String> {
    let mut cmd = Command::new(crate::web_context::curl_path().ok_or("curl was not found on this computer")?);
    cmd.args(["--disable", "--silent", "--proto", "=http"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    Ok(cmd)
}

/// POST a JSON body to `/prompt` or `/interrupt`. The reply is returned whatever its status, because
/// ComfyUI explains a refused job (a missing model file, say) in the body of a 400.
pub fn post(port: u16, path: &str, body: &str) -> Result<String, String> {
    if !valid_port(port) || !matches!(path, "/prompt" | "/interrupt") {
        return Err("not an address ezCLI sends to".into());
    }
    let mut cmd = curl()?;
    cmd.args(["--max-time", "20", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-", &format!("{}{path}", base(port))]);
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("ComfyUI did not answer".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Where finished pictures and videos are kept: the user's Pictures or Videos folder, in `ezCLI`.
pub fn save_dir(name: &str) -> PathBuf {
    let video = mime(name).starts_with("video/");
    let root = if video { dirs::video_dir() } else { dirs::picture_dir() };
    root.or_else(|| dirs::home_dir().map(|h| h.join(".ezcli").join("media"))).unwrap_or_else(std::env::temp_dir).join("ezCLI")
}

/// Copy one finished file out of ComfyUI into [`save_dir`] and return where it went.
pub fn fetch(port: u16, name: &str, folder: &str) -> Result<PathBuf, String> {
    if !valid_port(port) || !output_name(name) || !output_folder(folder) {
        return Err("not a file ComfyUI made".into());
    }
    let dir = save_dir(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(name.replace(' ', "_"));
    let mut cmd = curl()?;
    cmd.args(["--fail", "--max-time", "120", "--max-filesize", "268435456", "-o"]).arg(&dest).arg(view_url(port, name, folder));
    let ok = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?.success();
    if !ok {
        let _ = std::fs::remove_file(&dest);
        return Err("ComfyUI did not hand over the file".into());
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_short_list_of_paths_is_read() {
        for ok in ["/system_stats", "/queue", "/models/checkpoints", "/models/diffusion_models", "/history/0b9c1f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"] {
            assert!(readable(ok), "{ok}");
        }
        for bad in ["/", "/prompt", "/userdata/x", "/models/../userdata", "/history/a?x=1", "/view", "http://example.com/system_stats", "/models/a b"] {
            assert!(!readable(bad), "{bad}");
        }
        assert!(get(22, "/system_stats").is_none(), "a system port is never asked");
        assert!(post(8188, "/free", "{}").is_err(), "only /prompt and /interrupt are sent to");
    }

    #[test]
    fn only_pictures_and_videos_from_the_output_folder_are_fetched() {
        for ok in ["ezCLI_00001_.png", "ezCLI_00002_.webm", "a b.jpg", "x.MP4"] {
            assert!(output_name(ok), "{ok}");
        }
        for bad in ["", "../secret.png", "a/b.png", "a\\b.png", ".png", "model.safetensors", "run.bat", "x.png?y", "x"] {
            assert!(!output_name(bad), "{bad}");
        }
        assert!(output_folder("") && output_folder("ezCLI") && output_folder("video/ezCLI"));
        assert!(!output_folder("../x") && !output_folder("/etc") && !output_folder("a b") && !output_folder("C:\\x"));
        assert!(fetch(8188, "../x.png", "").is_err());
        assert!(fetch(8188, "x.png", "../..").is_err());
    }

    #[test]
    fn addresses_are_loopback_and_names_are_escaped() {
        assert_eq!(view_url(8188, "a b.png", "ezCLI"), "http://127.0.0.1:8188/view?filename=a%20b.png&subfolder=ezCLI&type=output");
        assert_eq!(mime("x.webm"), "video/webm");
        assert_eq!(mime("x.PNG"), "image/png");
        assert!(save_dir("x.png").ends_with("ezCLI"));
    }
}

#[cfg(test)]
mod live {
    /// Against a ComfyUI that is really running: `EZCLI_COMFY_PORT=8188 cargo test --lib comfy::live -- --ignored`
    #[test]
    #[ignore = "needs ComfyUI running on this computer"]
    fn a_running_comfyui_answers_and_lists_its_checkpoints() {
        let port: u16 = std::env::var("EZCLI_COMFY_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(super::DEFAULT_PORT);
        let stats = super::get(port, "/system_stats").expect("ComfyUI did not answer");
        assert!(stats.contains("comfyui_version"), "{stats}");
        let list = super::get(port, "/models/checkpoints").expect("no checkpoint list");
        assert!(list.trim_start().starts_with('['), "{list}");
        let refused = super::post(port, "/prompt", r#"{"prompt":{}}"#).expect("no reply to an empty job");
        assert!(refused.contains("error"), "an empty job is refused with a reason: {refused}");
    }
}
