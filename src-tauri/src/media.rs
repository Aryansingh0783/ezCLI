//! Local media for the composer: pasted images and sampled video frames.
//!
//! ezCLI never uploads anything. A pasted image is written to a private
//! folder so the CLI can be given a path; a video is turned into a handful of
//! still frames with the user's own ffmpeg, because none of the supported
//! coding CLIs except Gemini read video directly.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "mpeg", "mpg", "3gp"];
const MAX_PASTE_BYTES: usize = 30 * 1024 * 1024;
const MAX_FRAMES: u32 = 12;
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(60);
/// Attachments older than this are removed at startup.
const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub fn attachments_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".ezcli")
        .join("attachments")
}

/// Where new attachments go. Most CLIs read any local path, so the private
/// `~/.ezcli/attachments` is used. Gemini only reads inside its workspace, so
/// for it the caller passes the session folder and files land in a
/// self-ignoring `.ezcli-attachments` folder there.
fn target_dir(workspace: Option<&str>) -> Result<PathBuf, String> {
    let Some(ws) = workspace.map(str::trim).filter(|w| !w.is_empty()) else {
        let dir = attachments_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    };
    let root = PathBuf::from(ws);
    if !root.is_dir() {
        return Err("The session folder no longer exists.".into());
    }
    let dir = root.join(".ezcli-attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "# ezCLI attachments; safe to delete.\n*\n");
    }
    Ok(dir)
}

/// Copy a picked or dropped file into the workspace attachment folder.
pub fn stage_into_workspace(file: &str, workspace: &str) -> Result<String, String> {
    const MAX_STAGE_BYTES: u64 = 500 * 1024 * 1024;
    let src = PathBuf::from(file);
    let meta = std::fs::metadata(&src).map_err(|_| "That file no longer exists.".to_string())?;
    if !meta.is_file() {
        return Err("Only files can be attached.".into());
    }
    if meta.len() > MAX_STAGE_BYTES {
        return Err("That file is larger than 500 MB.".into());
    }
    // @mentions end at whitespace, so the copy gets a plain, space-free name.
    let name: String = src
        .file_name()
        .ok_or("That file has no name.")?
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' })
        .collect();
    let dest = target_dir(Some(workspace))?.join(format!("{}-{name}", stamp()));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

fn stamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Delete old pasted images and frame folders. Best effort: a file the CLI
/// still has open simply stays until the next launch.
pub fn prune_old_attachments() {
    let Ok(entries) = std::fs::read_dir(attachments_dir()) else { return };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let p = e.path();
            let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        }
    }
}

/// The only image types a paste may produce. The extension comes from this
/// table, never from the webview, so a paste can't write an arbitrary file type.
fn image_ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// Write a pasted image (base64 from the clipboard) and return its path.
pub fn save_pasted_image(data_b64: &str, mime: &str, workspace: Option<&str>) -> Result<String, String> {
    use base64::Engine;
    let ext = image_ext_for_mime(mime).ok_or_else(|| format!("Unsupported pasted image type: {mime}"))?;
    // base64 is 4/3 the size of its payload; reject before decoding.
    if data_b64.len() > MAX_PASTE_BYTES / 3 * 4 + 4 {
        return Err("Pasted image is larger than 30 MB.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|_| "Pasted image data is not valid.".to_string())?;
    if bytes.is_empty() {
        return Err("Pasted image is empty.".into());
    }
    let path = target_dir(workspace)?.join(format!("paste-{}.{ext}", stamp()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize, Debug)]
pub struct Frame {
    pub path: String,
    /// Seconds from the start of the video.
    pub at: f64,
}

#[derive(Serialize, Debug)]
pub struct VideoFrames {
    pub duration: f64,
    pub frames: Vec<Frame>,
}

pub fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.iter().any(|v| v.eq_ignore_ascii_case(e)))
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn tool(name: &str) -> Option<String> {
    crate::agents::resolve_command_on_path(name, &crate::agents::effective_path())
}

/// Run ffmpeg/ffprobe hidden, with a hard timeout, returning stdout.
fn run_tool(program: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not run {program}: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no output pipe")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > FFMPEG_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("ffmpeg took too long on this video.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let out = reader.join().unwrap_or_default();
    if !status.success() {
        return Err("ffmpeg could not read this video.".into());
    }
    Ok(out)
}

/// Evenly spaced sample times, each in the middle of its slice, so a short
/// clip never asks for a frame at or past its last timestamp.
pub fn sample_times(duration: f64, count: u32) -> Vec<f64> {
    let n = count.clamp(1, MAX_FRAMES);
    if !(duration.is_finite() && duration > 0.0) {
        return vec![0.0];
    }
    (0..n).map(|i| duration * (i as f64 + 0.5) / n as f64).collect()
}

/// Sample still frames from a local video with the user's installed ffmpeg.
pub fn extract_video_frames(video: &str, count: u32, workspace: Option<&str>) -> Result<VideoFrames, String> {
    let src = PathBuf::from(video);
    if !src.is_file() {
        return Err("That video file no longer exists.".into());
    }
    if !is_video(&src) {
        return Err("That file is not a supported video type.".into());
    }
    let ffmpeg = tool("ffmpeg").ok_or("FFMPEG_MISSING")?;
    let ffprobe = tool("ffprobe").ok_or("FFMPEG_MISSING")?;
    let src_s = src.to_string_lossy().into_owned();

    let duration: f64 = run_tool(
        &ffprobe,
        &&strings(&["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", src_s.as_str()]),
    )?
    .trim()
    .parse()
    .unwrap_or(0.0);

    let dir = target_dir(workspace)?.join(format!("video-{}", stamp()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut frames = Vec::new();
    for (i, at) in sample_times(duration, count).into_iter().enumerate() {
        let out = dir.join(format!("frame-{:02}.jpg", i + 1));
        let out_s = out.to_string_lossy().into_owned();
        let at_s = format!("{at:.3}");
        let args = strings(&[
            "-hide_banner", "-loglevel", "error", "-y",
            "-ss", at_s.as_str(),
            "-i", src_s.as_str(),
            "-frames:v", "1",
            // Cap the long edge so frames stay cheap for the model to read.
            "-vf", "scale='min(1280,iw)':-2",
            "-q:v", "4",
            out_s.as_str(),
        ]);
        run_tool(&ffmpeg, &args)?;
        if out.is_file() {
            frames.push(Frame { path: out_s, at });
        }
    }
    if frames.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("ffmpeg produced no frames for this video.".into());
    }
    Ok(VideoFrames { duration, frames })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_times_are_inside_the_clip() {
        let t = sample_times(10.0, 4);
        assert_eq!(t, vec![1.25, 3.75, 6.25, 8.75]);
        assert!(sample_times(10.0, 99).len() as u32 == MAX_FRAMES);
        assert_eq!(sample_times(f64::NAN, 4), vec![0.0]);
        assert_eq!(sample_times(0.0, 0), vec![0.0]);
    }

    #[test]
    fn pasted_images_only_get_safelisted_extensions() {
        assert_eq!(image_ext_for_mime("image/png"), Some("png"));
        assert_eq!(image_ext_for_mime("IMAGE/JPEG"), Some("jpg"));
        assert_eq!(image_ext_for_mime("text/html"), None);
        assert_eq!(image_ext_for_mime("image/svg+xml"), None);
        assert!(save_pasted_image("aGVsbG8=", "application/x-msdownload", None).is_err());
        assert!(save_pasted_image("not base64!!", "image/png", None).is_err());
    }

    #[test]
    fn video_detection_uses_the_extension_list() {
        assert!(is_video(Path::new(r"C:\clips\Demo.MP4")));
        assert!(is_video(Path::new("a.webm")));
        assert!(!is_video(Path::new("a.png")));
        assert!(!is_video(Path::new("mp4")));
    }

    /// Opt-in: makes a 2-second test clip with the installed ffmpeg and
    /// samples it. `scripts\test-rust.ps1 --ignored --nocapture real_ffmpeg`
    #[test]
    #[ignore = "runs the installed ffmpeg"]
    fn real_ffmpeg_samples_frames_from_a_clip() {
        let ffmpeg = tool("ffmpeg").expect("ffmpeg on PATH");
        let dir = std::env::temp_dir().join(format!("ezcli media test {}", stamp()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        run_tool(
            &ffmpeg,
            &strings(&["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", clip.to_string_lossy().as_ref()]),
        )
        .unwrap();
        let got = extract_video_frames(&clip.to_string_lossy(), 3, Some(&dir.to_string_lossy())).unwrap();
        eprintln!("{got:?}");
        assert!((got.duration - 2.0).abs() < 0.2);
        assert_eq!(got.frames.len(), 3);
        for f in &got.frames {
            assert!(Path::new(&f.path).is_file());
            let _ = std::fs::remove_file(&f.path);
        }
        assert!(dir.join(".ezcli-attachments").join(".gitignore").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_staging_copies_into_a_self_ignoring_folder() {
        let ws = std::env::temp_dir().join(format!("ezcli stage test {}", stamp()));
        std::fs::create_dir_all(&ws).unwrap();
        let src = ws.join("shot one.png");
        std::fs::write(&src, b"png").unwrap();
        let staged = stage_into_workspace(&src.to_string_lossy(), &ws.to_string_lossy()).unwrap();
        assert!(staged.ends_with("-shot-one.png"), "{staged}");
        assert_eq!(std::fs::read(&staged).unwrap(), b"png");
        let ignore = std::fs::read_to_string(ws.join(".ezcli-attachments").join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "*"));
        assert!(stage_into_workspace(&ws.join("missing.png").to_string_lossy(), &ws.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }
}
