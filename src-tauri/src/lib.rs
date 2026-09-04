#[tauri::command]
fn launcher_version() -> &'static str {
    nordiee_core::LAUNCHER_CORE_VERSION
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![launcher_version])
        .run(tauri::generate_context!())
        .expect("error while running Nordiee Launcher");
}
