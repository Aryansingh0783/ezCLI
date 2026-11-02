#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Pick the WebKitGTK settings that suit this GPU and compositor (see linux_env.rs).
    #[cfg(target_os = "linux")]
    ezcli_lib::linux_env::apply();
    ezcli_lib::webview_runtime::point_at_installed_runtime();
    ezcli_lib::run();
}
