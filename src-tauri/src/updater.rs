//! Update check and install from GitHub Releases.
//!
//! The check reads the public "latest release" API. An update is installed
//! only when the release also publishes `<installer>.sha256` and the
//! downloaded file matches it; otherwise the UI offers the release page.
//! Requests go through the system curl with the user's curl config disabled,
//! the same way the Ollama Cloud catalog is fetched.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const LATEST_URL: &str = "https://api.github.com/repos/Aryansingh0783/ezCLI/releases/latest";
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub page_url: String,
    pub notes: String,
    /// Installer for this platform, when the release has one.
    pub installer_url: Option<String>,
    pub installer_name: Option<String>,
    pub installer_size: u64,
    /// Present only when the release publishes a checksum for the installer.
    pub checksum_url: Option<String>,
}

fn curl() -> Result<String, String> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot is unavailable.")?;
        let path = PathBuf::from(root).join("System32").join("curl.exe");
        if path.is_file() {
            return Ok(path.to_string_lossy().into_owned());
        }
        Err("Windows system curl.exe is unavailable.".into())
    }
    #[cfg(not(windows))]
    {
        for p in ["/usr/bin/curl", "/bin/curl", "/usr/local/bin/curl"] {
            if std::path::Path::new(p).is_file() {
                return Ok(p.into());
            }
        }
        Err("curl is required to check for updates.".into())
    }
}

fn run_curl(args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(curl()?);
    cmd.args(["--disable", "--fail", "--silent", "--show-error", "--location"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("download failed: {}", err.lines().next().unwrap_or("curl error").trim()));
    }
    Ok(out.stdout)
}

/// "v1.4.0" or "1.4.0" -> [1, 4, 0]. Pre-release suffixes are ignored.
fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .take(3)
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse_version(latest), parse_version(current));
    a.resize(3, 0);
    b.resize(3, 0);
    a > b
}

fn installer_suffix() -> &'static [&'static str] {
    if cfg!(windows) {
        &[".msi"]
    } else if cfg!(target_os = "macos") {
        &[".dmg"]
    } else {
        &[".appimage", ".deb"]
    }
}

fn pick(release: Release, current: &str) -> UpdateInfo {
    let installer = installer_suffix()
        .iter()
        .find_map(|sfx| release.assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(sfx)));
    let checksum_url = installer.and_then(|i| {
        let want = format!("{}.sha256", i.name);
        release.assets.iter().find(|a| a.name == want).map(|a| a.browser_download_url.clone())
    });
    let notes: String = release.body.unwrap_or_default().chars().take(4000).collect();
    UpdateInfo {
        current: current.into(),
        available: is_newer(&release.tag_name, current),
        latest: release.tag_name.trim_start_matches('v').into(),
        page_url: release.html_url,
        notes,
        installer_url: installer.map(|i| i.browser_download_url.clone()),
        installer_name: installer.map(|i| i.name.clone()),
        installer_size: installer.map_or(0, |i| i.size),
        checksum_url,
    }
}

pub fn check() -> Result<UpdateInfo, String> {
    let body = run_curl(&[
        "--max-time",
        "20",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: ezCLI-updater",
        LATEST_URL,
    ])?;
    let release: Release = serde_json::from_slice(&body).map_err(|_| "GitHub returned an unexpected reply.".to_string())?;
    Ok(pick(release, env!("CARGO_PKG_VERSION")))
}

/// Only GitHub release downloads are accepted, so the webview cannot turn
/// this command into a general downloader.
fn trusted(url: &str) -> bool {
    url.starts_with("https://github.com/Aryansingh0783/ezCLI/releases/download/")
}

/// Download the installer and its checksum, verify, and return the local path.
pub fn download(installer_url: &str, checksum_url: &str, name: &str) -> Result<String, String> {
    if !trusted(installer_url) || !trusted(checksum_url) {
        return Err("Refusing to download from outside this app's GitHub releases.".into());
    }
    let safe_name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect();
    if safe_name.is_empty() {
        return Err("The installer has no usable file name.".into());
    }
    let expected = String::from_utf8_lossy(&run_curl(&["--max-time", "30", checksum_url])?)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The release checksum is not a SHA-256 hash.".into());
    }
    let dir = std::env::temp_dir().join("ezcli-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&safe_name);
    let path_s = path.to_string_lossy().into_owned();
    run_curl(&["--max-time", "900", "--max-filesize", &MAX_INSTALLER_BYTES.to_string(), "-o", &path_s, installer_url])?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        let _ = std::fs::remove_file(&path);
        return Err("The download did not match the published checksum, so it was deleted.".into());
    }
    Ok(path_s)
}

/// Start the verified installer. The caller quits the app right after, so
/// the installer can replace the running files.
pub fn install(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    let in_update_dir = p.parent() == Some(std::env::temp_dir().join("ezcli-update").as_path());
    if !in_update_dir || !p.is_file() {
        return Err("Only a downloaded update can be installed.".into());
    }
    #[cfg(windows)]
    {
        Command::new("msiexec").args(["/i", path, "/passive"]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(is_newer("2.0.0", "1.4.0"));
        assert!(!is_newer("v1.4.0", "1.4.0"));
        assert!(!is_newer("1.3.9", "1.4.0"));
    }

    #[test]
    fn release_picks_platform_installer_and_its_checksum() {
        let r: Release = serde_json::from_str(
            r#"{"tag_name":"v9.0.0","html_url":"https://github.com/x","body":"notes","assets":[
            {"name":"ezCLI_9.0.0_x64_en-US.msi","browser_download_url":"https://github.com/Aryansingh0783/ezCLI/releases/download/v9.0.0/ezCLI_9.0.0_x64_en-US.msi","size":5},
            {"name":"ezCLI_9.0.0_x64_en-US.msi.sha256","browser_download_url":"https://github.com/Aryansingh0783/ezCLI/releases/download/v9.0.0/ezCLI_9.0.0_x64_en-US.msi.sha256","size":1},
            {"name":"ezCLI_9.0.0_aarch64.dmg","browser_download_url":"https://github.com/Aryansingh0783/ezCLI/releases/download/v9.0.0/ezCLI_9.0.0_aarch64.dmg","size":5}]}"#,
        )
        .unwrap();
        let info = pick(r, "1.0.0");
        assert!(info.available);
        assert_eq!(info.latest, "9.0.0");
        if cfg!(windows) {
            assert!(info.installer_name.as_deref().unwrap().ends_with(".msi"));
            assert!(info.checksum_url.as_deref().unwrap().ends_with(".msi.sha256"));
        }
    }

    #[test]
    fn downloads_are_limited_to_this_repo() {
        assert!(trusted("https://github.com/Aryansingh0783/ezCLI/releases/download/v1/x.msi"));
        assert!(!trusted("https://evil.example/ezCLI.msi"));
        assert!(!trusted("https://github.com/someone/else/releases/download/v1/x.msi"));
        assert!(download("https://evil.example/a.msi", "https://evil.example/a.sha256", "a.msi").is_err());
        assert!(install("C:\\Windows\\notepad.exe").is_err());
    }

    #[test]
    #[ignore = "reads the live GitHub release API"]
    fn real_latest_release_is_readable() {
        let info = check().expect("GitHub reachable");
        eprintln!("{info:?}");
        assert!(!info.latest.is_empty());
    }
}
