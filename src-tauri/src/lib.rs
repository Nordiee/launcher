use keyring::Entry;

#[tauri::command]
fn launcher_version() -> &'static str {
    nordiee_core::LAUNCHER_CORE_VERSION
}

const ACCOUNT_SECRET_SERVICE: &str = "com.nordiee.launcher.account";

fn account_entry(email: &str) -> Result<Entry, String> {
    Entry::new(ACCOUNT_SECRET_SERVICE, email).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_account_secret(email: String, secret: String) -> Result<(), String> {
    account_entry(&email)?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_account_secret(email: String) -> Result<Option<String>, String> {
    Ok(account_entry(&email)?.get_password().ok())
}

#[tauri::command]
fn remove_account_secret(email: String) -> Result<(), String> {
    let entry = account_entry(&email)?;
    if entry.get_password().is_ok() {
        entry.delete_credential().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![launcher_version, save_account_secret, load_account_secret, remove_account_secret])
        .run(tauri::generate_context!())
        .expect("error while running Nordiee Launcher");
}
