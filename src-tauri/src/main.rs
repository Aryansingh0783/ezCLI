#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ezcli_lib::webview_runtime::point_at_installed_runtime();
    ezcli_lib::run();
}
