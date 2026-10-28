//! Windows keeps a registration of the WebView2 runtime. When that record is lost (a broken update,
//! another account's install) the app refuses to start even though the runtime files are still on
//! disk. Point the app at those files instead, so it opens without installing anything.

#[cfg(windows)]
pub fn point_at_installed_runtime() {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return;
    }
    let roots = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(|v| std::env::var_os(v)).map(|r| {
        let mut p = std::path::PathBuf::from(r);
        p.push("Microsoft");
        p.push("EdgeWebView");
        p.push("Application");
        p
    });
    for root in roots {
        if let Some(dir) = newest_runtime(&root) {
            std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", dir);
            return;
        }
    }
}

#[cfg(not(windows))]
pub fn point_at_installed_runtime() {}

/// The highest-numbered version folder under `root` that holds `msedgewebview2.exe`.
#[cfg(windows)]
fn newest_runtime(root: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut best: Option<(Vec<u64>, std::path::PathBuf)> = None;
    for e in std::fs::read_dir(root).ok()?.flatten() {
        let p = e.path();
        if !p.join("msedgewebview2.exe").is_file() {
            continue;
        }
        let ver: Vec<u64> = e.file_name().to_string_lossy().split('.').map(|x| x.parse().unwrap_or(0)).collect();
        if best.as_ref().map_or(true, |(b, _)| ver > *b) {
            best = Some((ver, p));
        }
    }
    best.map(|(_, p)| p)
}
