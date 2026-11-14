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

// ------------------------------------------------------------------------------------------- making things
// One implementation for everything that asks for a picture or a clip: the Create panel, the tools
// agents are given, and the IMAGE: request of local-model chats.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// ezCLI's own ComfyUI listens here (see `studio.rs`); then ComfyUI's default, then ComfyUI Desktop's.
pub const MANAGED_PORT: u16 = 8317;
pub const PORTS: [u16; 3] = [MANAGED_PORT, 8188, 8000];

pub fn is_comfy(body: &str) -> bool {
    body.contains("comfyui_version")
}

/// The port a ComfyUI is answering on, if any.
pub fn find_port() -> Option<u16> {
    PORTS.into_iter().find(|p| crate::web_context::get(&format!("{}/system_stats", base(*p)), 2, 256 * 1024).is_some_and(|b| is_comfy(&b)))
}

pub fn parse_list(body: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(body).unwrap_or_default()
}

#[derive(Default, Clone, Debug, serde::Serialize)]
pub struct Installed {
    pub checkpoints: Vec<String>,
    pub diffusion: Vec<String>,
    pub encoders: Vec<String>,
    pub vaes: Vec<String>,
}

pub fn installed(port: u16) -> Installed {
    let list = |folder: &str| get(port, &format!("/models/{folder}")).map(|b| parse_list(&b)).unwrap_or_default();
    Installed { checkpoints: list("checkpoints"), diffusion: list("diffusion_models"), encoders: list("text_encoders"), vaes: list("vae") }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Image,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Square,
    Wide,
    Tall,
}

impl Shape {
    pub fn parse(s: &str) -> Shape {
        match s.trim().to_ascii_lowercase().as_str() {
            "square" => Shape::Square,
            "tall" | "portrait" => Shape::Tall,
            _ => Shape::Wide,
        }
    }
}

pub struct ImageSettings {
    pub base: u32,
    pub steps: u32,
    pub cfg: f64,
    pub sampler: &'static str,
    pub scheduler: &'static str,
    /// some models are trained without a negative prompt
    pub negative: bool,
}

/// Settings that suit a checkpoint, read from its file name. Unknown names get Stable Diffusion 1.5's.
pub fn image_settings(ckpt: &str) -> ImageSettings {
    let n = ckpt.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if n.contains("flux") {
        return ImageSettings { base: 1024, steps: if n.contains("schnell") { 4 } else { 20 }, cfg: 1.0, sampler: "euler", scheduler: "simple", negative: false };
    }
    let big = has(&["xl", "pony", "illustrious", "noobai", "sd3", "playground"]);
    if has(&["turbo", "lightning", "hyper", "lcm", "dmd"]) {
        return ImageSettings { base: if big { 1024 } else { 512 }, steps: 6, cfg: 1.5, sampler: "euler_ancestral", scheduler: "sgm_uniform", negative: false };
    }
    if big {
        return ImageSettings { base: 1024, steps: 26, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras", negative: true };
    }
    ImageSettings { base: 512, steps: 25, cfg: 7.0, sampler: "dpmpp_2m", scheduler: "karras", negative: true }
}

/// Width and height for a shape, in the multiples of 64 these models expect.
pub fn image_size(base: u32, shape: Shape) -> (u32, u32) {
    let round = |x: f64| ((x / 64.0).round() as u32) * 64;
    let (long, short) = (round(base as f64 * 1.25), round(base as f64 * 0.75));
    match shape {
        Shape::Square => (base, base),
        Shape::Wide => (long, short),
        Shape::Tall => (short, long),
    }
}

pub fn image_workflow(ckpt: &str, prompt: &str, shape: Shape, seed: u64) -> Value {
    let s = image_settings(ckpt);
    let (width, height) = image_size(s.base, shape);
    json!({
        "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": prompt } },
        "3": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["1", 1], "text": if s.negative { "blurry, low quality, distorted, watermark, text" } else { "" } } },
        "4": { "class_type": "EmptyLatentImage", "inputs": { "width": width, "height": height, "batch_size": 1 } },
        "5": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0], "seed": seed, "steps": s.steps, "cfg": s.cfg, "sampler_name": s.sampler, "scheduler": s.scheduler, "denoise": 1 } },
        "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
        "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "ezCLI" } }
    })
}

/// Wan 2.2 (text to video, the 5B model): the three files it needs.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoModel {
    pub unet: String,
    pub clip: String,
    pub vae: String,
}

fn pick(list: &[String], all: &[&str]) -> Option<String> {
    list.iter().find(|n| { let l = n.to_lowercase(); all.iter().all(|w| l.contains(w)) }).cloned()
}

pub fn video_model(inst: &Installed) -> Option<VideoModel> {
    Some(VideoModel { unet: pick(&inst.diffusion, &["wan2.2", "ti2v", "5b"])?, clip: pick(&inst.encoders, &["umt5", "xxl"])?, vae: pick(&inst.vaes, &["wan2.2", "vae"])? })
}

pub const VIDEO_FPS: u32 = 24;

/// Frame counts Wan accepts are 4n+1.
pub fn video_frames(seconds: u32) -> u32 {
    (seconds.clamp(1, 5) * VIDEO_FPS / 4) * 4 + 1
}

pub fn video_size(shape: Shape) -> (u32, u32) {
    match shape {
        Shape::Wide => (1280, 704),
        Shape::Tall => (704, 1280),
        Shape::Square => (960, 960),
    }
}

pub fn video_workflow(m: &VideoModel, prompt: &str, shape: Shape, seconds: u32, seed: u64) -> Value {
    let (width, height) = video_size(shape);
    json!({
        "1": { "class_type": "UNETLoader", "inputs": { "unet_name": m.unet, "weight_dtype": "default" } },
        "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": m.clip, "type": "wan" } },
        "3": { "class_type": "VAELoader", "inputs": { "vae_name": m.vae } },
        "4": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["1", 0], "shift": 8 } },
        "5": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": prompt } },
        "6": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["2", 0], "text": "blurry, low quality, static, distorted, watermark, subtitles" } },
        "7": { "class_type": "Wan22ImageToVideoLatent", "inputs": { "vae": ["3", 0], "width": width, "height": height, "length": video_frames(seconds), "batch_size": 1 } },
        "8": { "class_type": "KSampler", "inputs": { "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0], "seed": seed, "steps": 20, "cfg": 5, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1 } },
        "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["3", 0] } },
        "10": { "class_type": "SaveWEBM", "inputs": { "images": ["9", 0], "filename_prefix": "ezCLI", "codec": "vp9", "fps": VIDEO_FPS, "crf": 24 } }
    })
}

/// ComfyUI's reply to a queued job: its id, or why it was refused, in words.
pub fn parse_queued(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "ComfyUI sent a reply ezCLI could not read.".to_string())?;
    if v.get("error").is_none() {
        if let Some(id) = v.get("prompt_id").and_then(Value::as_str) {
            return Ok(id.to_string());
        }
    }
    let mut reasons = Vec::new();
    if let Some(nodes) = v.get("node_errors").and_then(Value::as_object) {
        for node in nodes.values() {
            for e in node.get("errors").and_then(Value::as_array).into_iter().flatten() {
                let parts: Vec<&str> = ["message", "details"].iter().filter_map(|k| e.get(*k).and_then(Value::as_str)).filter(|s| !s.is_empty()).collect();
                if !parts.is_empty() {
                    reasons.push(format!("{}: {}", node.get("class_type").and_then(Value::as_str).unwrap_or("A step"), parts.join(": ")));
                }
            }
        }
    }
    let kind = v.pointer("/error/type").and_then(Value::as_str).unwrap_or("");
    if kind == "missing_node_type" {
        return Err("This ComfyUI is too old for this job. Update ComfyUI and try again.".into());
    }
    let head = v.pointer("/error/message").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("ComfyUI refused the job");
    reasons.truncate(3);
    Err(if reasons.is_empty() { format!("{head}.") } else { format!("{head}. {}", reasons.join(" ")) })
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Waiting,
    /// file name and folder inside ComfyUI's output folder
    Done(String, String),
    Failed(String),
}

/// ComfyUI's history entry for a job. Nothing there yet means it is still queued or running.
pub fn parse_history(body: &str, id: &str) -> Outcome {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let Some(job) = v.get(id) else { return Outcome::Waiting };
    if let Some(outs) = job.get("outputs").and_then(Value::as_object) {
        for out in outs.values() {
            for f in out.get("images").and_then(Value::as_array).into_iter().flatten() {
                let kind = f.get("type").and_then(Value::as_str).unwrap_or("output");
                if let (Some(name), "output") = (f.get("filename").and_then(Value::as_str), kind) {
                    return Outcome::Done(name.to_string(), f.get("subfolder").and_then(Value::as_str).unwrap_or("").to_string());
                }
            }
        }
    }
    let status = job.get("status").cloned().unwrap_or(Value::Null);
    if status.get("status_str").and_then(Value::as_str) == Some("error") || status.get("completed").and_then(Value::as_bool) == Some(true) {
        let mut why = String::new();
        for m in status.get("messages").and_then(Value::as_array).into_iter().flatten() {
            if m.get(0).and_then(Value::as_str) == Some("execution_error") {
                why = m.pointer("/1/exception_message").and_then(Value::as_str).unwrap_or("").trim().to_string();
            }
        }
        let low = why.to_lowercase();
        if low.contains("out of memory") || low.contains("allocation") {
            why = "The graphics card ran out of memory. Close other programs that use it (a loaded chat model counts), or pick a smaller shape or a shorter clip.".into();
        }
        return Outcome::Failed(if why.is_empty() { "ComfyUI stopped without making a file.".into() } else { why });
    }
    Outcome::Waiting
}

pub struct Request {
    pub kind: Kind,
    pub prompt: String,
    pub shape: Shape,
    pub seconds: u32,
    /// a checkpoint to use for a picture; the first installed one when empty or not installed
    pub checkpoint: String,
    /// the terminal session that asked (an agent's tool call), so the result can be shown in its chat; empty otherwise
    pub owner: String,
}

pub const NOT_SET_UP: &str = "Pictures and video are not set up on this computer yet. Ask the user to open Create in ezCLI's sidebar and press \"Set up\"; it is a one-time download.";
pub const NO_IMAGE_MODEL: &str = "There is no image model yet. Ask the user to open Create in ezCLI's sidebar and download one.";
pub const NO_VIDEO_MODEL: &str = "The video model is not downloaded yet. Ask the user to open Create in ezCLI's sidebar, choose Video and download it.";

fn seed() -> u64 {
    let mut b = [0u8; 4];
    let _ = getrandom::getrandom(&mut b);
    u32::from_le_bytes(b) as u64
}

/// The job to queue for a request, given what this ComfyUI has installed.
pub fn plan(req: &Request, inst: &Installed) -> Result<Value, String> {
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err("Describe what to make.".into());
    }
    if prompt.len() > 4000 {
        return Err("That description is too long. Keep it under 4000 characters.".into());
    }
    match req.kind {
        Kind::Image => {
            let ckpt = inst.checkpoints.iter().find(|c| **c == req.checkpoint).or_else(|| inst.checkpoints.first()).ok_or(NO_IMAGE_MODEL)?;
            Ok(image_workflow(ckpt, prompt, req.shape, seed()))
        }
        Kind::Video => {
            let model = video_model(inst).ok_or(NO_VIDEO_MODEL)?;
            Ok(video_workflow(&model, prompt, req.shape, req.seconds, seed()))
        }
    }
}

/// Make one picture or clip and return where it was saved. Blocks until it is done: seconds for a
/// picture, many minutes for a clip. Starts ezCLI's own ComfyUI when that is installed and not running.
pub fn generate(req: &Request, cancel: &std::sync::atomic::AtomicBool) -> Result<PathBuf, String> {
    let port = match find_port() {
        Some(p) => p,
        None => crate::studio::ensure_running()?,
    };
    let job = plan(req, &installed(port))?;
    let body = json!({ "prompt": job, "client_id": "ezcli" }).to_string();
    let id = parse_queued(&post(port, "/prompt", &body)?)?;
    let limit = Duration::from_secs(if req.kind == Kind::Video { 60 * 60 } else { 15 * 60 });
    let started = Instant::now();
    let mut silent = 0;
    loop {
        std::thread::sleep(Duration::from_millis(1500));
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = post(port, "/interrupt", "{}");
            return Err("Stopped.".into());
        }
        let Some(body) = get(port, &format!("/history/{id}")) else {
            silent += 1;
            if silent > 20 {
                return Err("ComfyUI stopped answering.".into());
            }
            continue;
        };
        silent = 0;
        match parse_history(&body, &id) {
            Outcome::Done(name, folder) => return fetch(port, &name, &folder),
            Outcome::Failed(why) => return Err(why),
            Outcome::Waiting if started.elapsed() > limit => return Err("ComfyUI is still working after a long time; giving up waiting.".into()),
            Outcome::Waiting => {}
        }
    }
}

/// A request that runs in the background, so a caller can wait a little, come back and ask again.
#[derive(Clone, Debug, PartialEq)]
pub enum JobState {
    Working { seconds: u64 },
    Done { path: String },
    Failed { why: String },
}

struct Job {
    started: Instant,
    result: Option<Result<String, String>>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn job_id() -> String {
    let mut b = [0u8; 6];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Start a request with `run` doing the work. `done` is told the saved path when it succeeds.
pub fn start_job_with(run: impl FnOnce(&std::sync::atomic::AtomicBool) -> Result<PathBuf, String> + Send + 'static, done: impl FnOnce(&str) + Send + 'static) -> String {
    let id = job_id();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    jobs().lock().unwrap().insert(id.clone(), Job { started: Instant::now(), result: None, cancel: cancel.clone() });
    let key = id.clone();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&cancel))).unwrap_or_else(|_| Err("Making it stopped unexpectedly.".into())).map(|p| p.to_string_lossy().into_owned());
        if let Ok(path) = &result {
            done(path);
        }
        if let Some(j) = jobs().lock().unwrap().get_mut(&key) {
            j.result = Some(result);
        }
    });
    id
}

type MadeFn = Box<dyn Fn(&str, &str, &str) + Send + Sync>;
static ON_MADE: OnceLock<MadeFn> = OnceLock::new();

/// Who to tell when a picture or clip is finished (the app shows it). Given the saved path, the description and the session that asked.
pub fn on_made(f: MadeFn) {
    let _ = ON_MADE.set(f);
}

pub fn start_job(req: Request) -> String {
    let prompt = req.prompt.clone();
    let owner = req.owner.clone();
    start_job_with(
        move |cancel| generate(&req, cancel),
        move |path| {
            if let Some(f) = ON_MADE.get() {
                f(path, &prompt, &owner);
            }
        },
    )
}

/// A file ezCLI saved: inside one of its two save folders, with a picture or video ending.
pub fn saved_file(path: &str) -> bool {
    let p = std::path::Path::new(path);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    output_name(name) && p.parent().is_some_and(|d| d == save_dir("x.png") || d == save_dir("x.webm")) && p.is_file()
}

pub fn job_state(id: &str) -> Option<JobState> {
    let g = jobs().lock().unwrap();
    let j = g.get(id)?;
    Some(match &j.result {
        None => JobState::Working { seconds: j.started.elapsed().as_secs() },
        Some(Ok(path)) => JobState::Done { path: path.clone() },
        Some(Err(why)) => JobState::Failed { why: why.clone() },
    })
}

/// Wait up to `secs` for a job to finish, then say where it stands.
pub fn wait_job(id: &str, secs: u64) -> Option<JobState> {
    let until = Instant::now() + Duration::from_secs(secs);
    loop {
        match job_state(id)? {
            JobState::Working { .. } if Instant::now() < until => std::thread::sleep(Duration::from_millis(250)),
            state => return Some(state),
        }
    }
}

pub fn cancel_job(id: &str) {
    if let Some(j) = jobs().lock().unwrap().get(id) {
        j.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
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
mod making_tests {
    use super::*;

    fn wan() -> Installed {
        Installed { checkpoints: vec![], diffusion: vec!["wan2.2_ti2v_5B_fp16.safetensors".into()], encoders: vec!["umt5_xxl_fp8_e4m3fn_scaled.safetensors".into()], vaes: vec!["ae.safetensors".into(), "wan2.2_vae.safetensors".into()] }
    }

    /// Every link in a job points at a step that exists, the way ComfyUI checks it.
    fn links_resolve(job: &Value) {
        let steps = job.as_object().unwrap();
        for step in steps.values() {
            for v in step["inputs"].as_object().unwrap().values() {
                if let Some(link) = v.as_array() {
                    assert!(steps.contains_key(link[0].as_str().unwrap()), "{link:?}");
                }
            }
        }
    }

    #[test]
    fn picture_settings_come_from_the_checkpoint_name() {
        assert_eq!(image_settings("v1-5-pruned-emaonly.safetensors").base, 512);
        assert_eq!(image_settings("sd_xl_base_1.0.safetensors").base, 1024);
        let flux = image_settings("flux1-schnell-fp8.safetensors");
        assert_eq!((flux.steps, flux.negative), (4, false));
        assert_eq!(image_settings("dreamshaperXL_lightning.safetensors").steps, 6);
        assert_eq!(image_size(1024, Shape::Wide), (1280, 768));
        assert_eq!(image_size(512, Shape::Tall), (384, 640));
        assert_eq!(image_size(1024, Shape::Square), (1024, 1024));
    }

    #[test]
    fn a_picture_job_uses_the_asked_checkpoint_or_the_first_and_its_links_resolve() {
        let inst = Installed { checkpoints: vec!["a.safetensors".into(), "sd_xl_base_1.0.safetensors".into()], ..Default::default() };
        let req = |ckpt: &str| Request { kind: Kind::Image, prompt: " a red bicycle ".into(), shape: Shape::Wide, seconds: 3, checkpoint: ckpt.into(), owner: String::new() };
        let job = plan(&req("sd_xl_base_1.0.safetensors"), &inst).unwrap();
        links_resolve(&job);
        assert_eq!(job["1"]["inputs"]["ckpt_name"], "sd_xl_base_1.0.safetensors");
        assert_eq!(job["2"]["inputs"]["text"], "a red bicycle");
        assert_eq!((job["4"]["inputs"]["width"].as_u64(), job["4"]["inputs"]["height"].as_u64()), (Some(1280), Some(768)));
        assert_eq!(job["7"]["class_type"], "SaveImage");
        assert_eq!(plan(&req("gone.safetensors"), &inst).unwrap()["1"]["inputs"]["ckpt_name"], "a.safetensors");
        assert_eq!(plan(&req(""), &Installed::default()).unwrap_err(), NO_IMAGE_MODEL);
        assert!(plan(&Request { prompt: "  ".into(), ..req("") }, &inst).is_err());
    }

    #[test]
    fn a_video_job_needs_all_three_files() {
        assert_eq!(video_model(&wan()).unwrap().vae, "wan2.2_vae.safetensors");
        let mut part = wan();
        part.vaes = vec!["ae.safetensors".into()];
        assert!(video_model(&part).is_none());
        let req = Request { kind: Kind::Video, prompt: "waves at dusk".into(), shape: Shape::Wide, seconds: 3, checkpoint: String::new(), owner: String::new() };
        assert_eq!(plan(&req, &part).unwrap_err(), NO_VIDEO_MODEL);
        let job = plan(&req, &wan()).unwrap();
        links_resolve(&job);
        assert_eq!(job["7"]["inputs"]["length"], 73);
        assert_eq!(job["10"]["class_type"], "SaveWEBM");
        assert_eq!((video_frames(5), video_frames(99), video_frames(0)), (121, 121, 25));
    }

    #[test]
    fn comfyui_replies_are_read() {
        assert_eq!(parse_queued(r#"{"prompt_id":"abc","number":1,"node_errors":{}}"#).unwrap(), "abc");
        let refused = r#"{"error":{"type":"prompt_outputs_failed_validation","message":"Prompt outputs failed validation"},"node_errors":{"1":{"class_type":"CheckpointLoaderSimple","errors":[{"type":"value_not_in_list","message":"Value not in list","details":"ckpt_name: 'x' not in []"}]}}}"#;
        let why = parse_queued(refused).unwrap_err();
        assert!(why.contains("Prompt outputs failed validation") && why.contains("ckpt_name: 'x' not in []"), "{why}");
        assert!(parse_queued(r#"{"error":{"type":"missing_node_type","message":"x"},"node_errors":{}}"#).unwrap_err().contains("Update ComfyUI"));
        assert!(parse_queued("<html>").is_err());

        assert_eq!(parse_history("{}", "a"), Outcome::Waiting);
        let done = r#"{"a":{"outputs":{"7":{"images":[{"filename":"tmp.png","subfolder":"","type":"temp"},{"filename":"ezCLI_00001_.png","subfolder":"","type":"output"}]}},"status":{"status_str":"success","completed":true,"messages":[]}}}"#;
        assert_eq!(parse_history(done, "a"), Outcome::Done("ezCLI_00001_.png".into(), String::new()));
        let oom = r#"{"a":{"outputs":{},"status":{"status_str":"error","completed":false,"messages":[["execution_error",{"exception_message":"CUDA out of memory. Tried to allocate 2 GiB"}]]}}}"#;
        assert!(matches!(parse_history(oom, "a"), Outcome::Failed(w) if w.contains("ran out of memory")));
    }

    #[test]
    fn a_background_job_reports_working_then_its_result_and_can_be_waited_on() {
        let seen = std::sync::Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        let id = start_job_with(
            |_| {
                std::thread::sleep(Duration::from_millis(400));
                Ok(PathBuf::from("/tmp/x.png"))
            },
            move |p| *s2.lock().unwrap() = p.to_string(),
        );
        assert!(matches!(job_state(&id), Some(JobState::Working { .. })));
        assert!(matches!(wait_job(&id, 0), Some(JobState::Working { .. })), "a zero wait returns at once");
        assert_eq!(wait_job(&id, 5), Some(JobState::Done { path: "/tmp/x.png".into() }));
        assert_eq!(seen.lock().unwrap().as_str(), "/tmp/x.png");
        let bad = start_job_with(|_| Err("no".into()), |_| panic!("not told about a failure"));
        assert_eq!(wait_job(&bad, 5), Some(JobState::Failed { why: "no".into() }));
        assert!(job_state("nope").is_none());
    }
}

#[cfg(test)]
mod live {
    /// Against a ComfyUI that is really running: `EZCLI_COMFY_PORT=8188 cargo test --lib comfy::live -- --ignored`
    #[test]
    #[ignore = "needs ComfyUI running on this computer"]
    fn a_running_comfyui_answers_and_lists_its_checkpoints() {
        let port: u16 = std::env::var("EZCLI_COMFY_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(super::PORTS[1]);
        let stats = super::get(port, "/system_stats").expect("ComfyUI did not answer");
        assert!(stats.contains("comfyui_version"), "{stats}");
        let list = super::get(port, "/models/checkpoints").expect("no checkpoint list");
        assert!(list.trim_start().starts_with('['), "{list}");
        let refused = super::post(port, "/prompt", r#"{"prompt":{}}"#).expect("no reply to an empty job");
        assert!(refused.contains("error"), "an empty job is refused with a reason: {refused}");
    }
}
