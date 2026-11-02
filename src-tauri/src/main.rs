#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer gives a blank or very slow window on many Arch, NVIDIA and Wayland
    // setups. Turn it off unless the user has chosen otherwise.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    ezcli_lib::webview_runtime::point_at_installed_runtime();
    ezcli_lib::run();
}
