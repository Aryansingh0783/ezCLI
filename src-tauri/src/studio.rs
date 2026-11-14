//! ezCLI's own ComfyUI: downloaded once into `~/.ezcli/studio`, started in the background when a
//! picture or clip is asked for, stopped when ezCLI quits. The user never opens ComfyUI.
//!
//! Windows only for now: it uses ComfyUI's official portable build, which carries its own Python and
//! PyTorch, so nothing else has to be installed. On other systems the Create panel works with a
//! ComfyUI the user runs themselves.
//!
//! Only github.com (the ComfyUI release) and huggingface.co (the model files listed below) are
//! contacted, and only after the user presses a button.

use crate::hub::{self, FetchOpts, Progress, Transfer};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const RELEASE: &str = "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/";

pub fn root() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("studio")
}

fn portable(root: &Path) -> PathBuf {
    root.join("ComfyUI_windows_portable")
}

fn python(root: &Path) -> PathBuf {
    portable(root).join("python_embeded").join("python.exe")
}

fn main_py(root: &Path) -> PathBuf {
    portable(root).join("ComfyUI").join("main.py")
}

pub fn models_dir() -> PathBuf {
    portable(&root()).join("ComfyUI").join("models")
}

pub fn installed_in(root: &Path) -> bool {
    python(root).is_file() && main_py(root).is_file()
}

pub fn installed() -> bool {
    installed_in(&root())
}

/// Whether ezCLI can set ComfyUI up by itself on this system.
pub fn supported() -> bool {
    cfg!(windows)
}

/// The portable build for the graphics card. The NVIDIA one also runs on the processor alone.
pub fn asset_for(gpu: Option<&str>) -> &'static str {
    let g = gpu.unwrap_or("").to_lowercase();
    if g.contains("radeon") || g.contains("amd") {
        "ComfyUI_windows_portable_amd.7z"
    } else if g.contains("intel") && g.contains("arc") {
        "ComfyUI_windows_portable_intel.7z"
    } else {
        "ComfyUI_windows_portable_nvidia.7z"
    }
}

/// One model file ezCLI can download for the user.
pub struct ModelFile {
    pub id: &'static str,
    /// `image` or `video`
    pub kind: &'static str,
    pub label: &'static str,
    pub name: &'static str,
    /// folder inside ComfyUI's `models` folder
    pub folder: &'static str,
    pub gib: f32,
    pub url: &'static str,
}

pub const MODELS: &[ModelFile] = &[
    ModelFile {
        id: "sdxl",
        kind: "image",
        label: "Stable Diffusion XL",
        name: "sd_xl_base_1.0.safetensors",
        folder: "checkpoints",
        gib: 6.9,
        url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
    },
    ModelFile {
        id: "wan-model",
        kind: "video",
        label: "Wan 2.2 video model",
        name: "wan2.2_ti2v_5B_fp16.safetensors",
        folder: "diffusion_models",
        gib: 10.0,
        url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
    },
    ModelFile {
        id: "wan-text",
        kind: "video",
        label: "Wan text encoder",
        name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        folder: "text_encoders",
        gib: 6.7,
        url: "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    },
    ModelFile {
        id: "wan-vae",
        kind: "video",
        label: "Wan 2.2 decoder",
        name: "wan2.2_vae.safetensors",
        folder: "vae",
        gib: 1.4,
        url: "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors",
    },
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub name: String,
    pub gib: f32,
    /// the file is in ezCLI's ComfyUI
    pub present: bool,
}

pub fn models_in(models: &Path) -> Vec<ModelState> {
    MODELS
        .iter()
        .map(|m| ModelState { id: m.id.into(), kind: m.kind.into(), label: m.label.into(), name: m.name.into(), gib: m.gib, present: models.join(m.folder).join(m.name).is_file() })
        .collect()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// ezCLI can set ComfyUI up itself on this system
    pub supported: bool,
    pub installed: bool,
    /// a ComfyUI is answering (ezCLI's own or one the user started)
    pub running: bool,
    pub port: u16,
    /// the answering ComfyUI is the one ezCLI installed
    pub managed: bool,
    pub models: Vec<ModelState>,
    pub folder: String,
}

pub fn status() -> Status {
    let port = crate::comfy::find_port();
    Status {
        supported: supported(),
        installed: installed(),
        running: port.is_some(),
        port: port.unwrap_or(0),
        managed: port == Some(crate::comfy::MANAGED_PORT),
        models: models_in(&models_dir()),
        folder: root().to_string_lossy().into_owned(),
    }
}

fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Unpack a `.7z`. Windows 11's own `tar` reads them; 7-Zip is used when it is installed and `tar` cannot.
fn unpack_7z(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut tools: Vec<(PathBuf, Vec<String>)> = Vec::new();
    if let Some(sys) = std::env::var_os("SystemRoot") {
        tools.push((PathBuf::from(sys).join("System32").join("tar.exe"), vec!["-xf".into(), archive.to_string_lossy().into_owned(), "-C".into(), into.to_string_lossy().into_owned()]));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(var) {
            tools.push((PathBuf::from(pf).join("7-Zip").join("7z.exe"), vec!["x".into(), "-y".into(), format!("-o{}", into.display()), archive.to_string_lossy().into_owned()]));
        }
    }
    let mut last = String::from("no tool that reads .7z files was found");
    for (exe, args) in tools {
        if !exe.is_file() {
            continue;
        }
        let mut cmd = Command::new(&exe);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        hidden(&mut cmd);
        match cmd.output() {
            Ok(o) if o.status.success() => return Ok(()),
            Ok(o) => last = String::from_utf8_lossy(&o.stderr).trim().chars().take(200).collect(),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("The download could not be unpacked ({last}). Install 7-Zip from 7-zip.org, or update Windows 11, then press Set up again; the download is kept."))
}

/// Download and unpack ComfyUI. Progress arrives as `model-download` events under the key `studio`.
pub fn install(app: AppHandle) -> Result<String, String> {
    if !supported() {
        return Err("ezCLI can set this up by itself on Windows only for now. On this system, install ComfyUI yourself and open it; the Create panel will find it.".into());
    }
    let gpu = crate::system_profile::detect().gpu_name;
    hub::start(
        app,
        "studio".into(),
        Box::new(move |app, key, cancel| {
            let root = root();
            if installed_in(&root) {
                return Ok(root.to_string_lossy().into_owned());
            }
            let asset = asset_for(gpu.as_deref());
            let archive = root.join(asset);
            // an archive left by an earlier try that failed to unpack is used as it is
            if !archive.is_file() {
                let url = format!("{RELEASE}{asset}");
                let t = Transfer { key, url: &url, dest: &archive, total: 0, sha: "" };
                hub::fetch(&|p| hub::emit(app, p), &t, cancel, &FetchOpts::standard())?;
            }
            hub::emit(app, Progress { note: "Unpacking. This takes a few minutes.".into(), ..hub::prog(key, "verifying") });
            let _ = std::fs::remove_dir_all(portable(&root));
            unpack_7z(&archive, &root)?;
            if !installed_in(&root) {
                return Err("The download did not contain ComfyUI where it was expected. Press Set up to try again.".into());
            }
            let _ = std::fs::remove_file(&archive);
            Ok(root.to_string_lossy().into_owned())
        }),
    )?;
    Ok("studio".into())
}

/// Download one of the listed model files into ezCLI's ComfyUI. Key: `studio-model:<id>`.
pub fn download_model(app: AppHandle, id: &str) -> Result<String, String> {
    let m = MODELS.iter().find(|m| m.id == id).ok_or("That is not a model ezCLI offers.")?;
    if !installed() {
        return Err("Set up pictures and video first.".into());
    }
    let dest = models_dir().join(m.folder).join(m.name);
    let key = format!("studio-model:{}", m.id);
    hub::start(
        app,
        key.clone(),
        Box::new(move |app, key, cancel| {
            if dest.is_file() {
                return Ok(dest.to_string_lossy().into_owned());
            }
            let t = Transfer { key, url: m.url, dest: &dest, total: 0, sha: "" };
            hub::fetch(&|p| hub::emit(app, p), &t, cancel, &FetchOpts::standard()).map(|p| p.to_string_lossy().into_owned())
        }),
    )?;
    Ok(key)
}

static CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Held while starting, so two requests arriving together start one ComfyUI, not two.
static STARTING: Mutex<()> = Mutex::new(());

fn log_path() -> PathBuf {
    root().join("comfyui.log")
}

fn log_tail() -> String {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join(" | ").chars().take(400).collect()
}

/// The command that starts ezCLI's ComfyUI: loopback only, no browser window, on ezCLI's own port.
pub fn launch_args() -> Vec<String> {
    ["-s", "ComfyUI\\main.py", "--windows-standalone-build", "--disable-auto-launch", "--listen", "127.0.0.1", "--port"].iter().map(|s| s.to_string()).chain([crate::comfy::MANAGED_PORT.to_string()]).collect()
}

/// Make sure a ComfyUI is answering and return its port. Starts ezCLI's own when none is; the first
/// start loads PyTorch and can take a minute or two.
pub fn ensure_running() -> Result<u16, String> {
    if let Some(p) = crate::comfy::find_port() {
        return Ok(p);
    }
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = crate::comfy::find_port() {
        return Ok(p);
    }
    let root = root();
    if !installed_in(&root) {
        return Err(crate::comfy::NOT_SET_UP.into());
    }
    let log = std::fs::File::create(log_path()).map_err(|e| format!("Could not write ComfyUI's log: {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(python(&root));
    cmd.args(launch_args()).current_dir(portable(&root)).stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err));
    hidden(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("ComfyUI could not be started: {e}"))?;
    *CHILD.lock().unwrap() = Some(child);
    let started = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        if crate::comfy::get(crate::comfy::MANAGED_PORT, "/system_stats").is_some_and(|b| crate::comfy::is_comfy(&b)) {
            return Ok(crate::comfy::MANAGED_PORT);
        }
        let exited = CHILD.lock().unwrap().as_mut().and_then(|c| c.try_wait().ok().flatten()).is_some();
        if exited {
            *CHILD.lock().unwrap() = None;
            return Err(format!("ComfyUI started and then stopped. Its last words: {}. Updating the graphics driver is the usual fix.", log_tail()));
        }
        if started.elapsed() > Duration::from_secs(300) {
            stop();
            return Err(format!("ComfyUI did not finish starting in five minutes. Its last words: {}", log_tail()));
        }
    }
}

/// Stop the ComfyUI ezCLI started. Called when ezCLI quits, and safe to call when none is running.
pub fn stop() {
    if let Some(mut c) = CHILD.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_follows_the_graphics_card() {
        assert_eq!(asset_for(Some("NVIDIA GeForce RTX 5070")), "ComfyUI_windows_portable_nvidia.7z");
        assert_eq!(asset_for(Some("AMD Radeon RX 7800 XT")), "ComfyUI_windows_portable_amd.7z");
        assert_eq!(asset_for(Some("Intel(R) Arc(TM) A770")), "ComfyUI_windows_portable_intel.7z");
        assert_eq!(asset_for(Some("Intel(R) UHD Graphics 630")), "ComfyUI_windows_portable_nvidia.7z", "no usable GPU: the NVIDIA build also runs on the processor");
        assert_eq!(asset_for(None), "ComfyUI_windows_portable_nvidia.7z");
    }

    #[test]
    fn installed_means_both_python_and_comfyui_are_there() {
        let d = std::env::temp_dir().join(format!("ezcli-studio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(!installed_in(&d));
        std::fs::create_dir_all(python(&d).parent().unwrap()).unwrap();
        std::fs::write(python(&d), "x").unwrap();
        assert!(!installed_in(&d), "python alone is not an install");
        std::fs::create_dir_all(main_py(&d).parent().unwrap()).unwrap();
        std::fs::write(main_py(&d), "x").unwrap();
        assert!(installed_in(&d));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn every_offered_model_is_a_plain_file_from_hugging_face_in_a_folder_comfyui_reads() {
        for m in MODELS {
            assert!(m.url.starts_with("https://huggingface.co/") && m.url.ends_with(m.name), "{}", m.id);
            assert!(crate::comfy::output_folder(m.folder) && !m.name.contains(['/', '\\']), "{}", m.id);
            assert!(matches!(m.kind, "image" | "video"));
        }
        // the video files are the ones the video job looks for
        let inst = crate::comfy::Installed {
            checkpoints: vec![],
            diffusion: vec![MODELS[1].name.into()],
            encoders: vec![MODELS[2].name.into()],
            vaes: vec![MODELS[3].name.into()],
        };
        assert!(crate::comfy::video_model(&inst).is_some());
    }

    #[test]
    fn models_are_reported_present_only_when_the_file_is_there() {
        let d = std::env::temp_dir().join(format!("ezcli-studio-models-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(models_in(&d).iter().all(|m| !m.present));
        std::fs::create_dir_all(d.join("checkpoints")).unwrap();
        std::fs::write(d.join("checkpoints").join("sd_xl_base_1.0.safetensors"), "x").unwrap();
        let got = models_in(&d);
        assert!(got.iter().find(|m| m.id == "sdxl").unwrap().present);
        assert_eq!(got.iter().filter(|m| m.present).count(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn comfyui_is_started_on_loopback_on_ezclis_port_without_a_browser() {
        let a = launch_args();
        assert!(a.contains(&"--disable-auto-launch".to_string()));
        let at = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].clone());
        assert_eq!(at("--listen").as_deref(), Some("127.0.0.1"));
        assert_eq!(at("--port").as_deref(), Some("8317"));
    }

    #[test]
    fn without_an_install_nothing_is_started() {
        // this machine has no ComfyUI answering and none installed by ezCLI
        if crate::comfy::find_port().is_none() && !installed() {
            assert_eq!(ensure_running().unwrap_err(), crate::comfy::NOT_SET_UP);
        }
        stop(); // safe with nothing running
    }
}
