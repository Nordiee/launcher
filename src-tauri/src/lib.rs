use keyring::Entry;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[tauri::command]
fn launcher_version() -> &'static str {
    nordiee_core::LAUNCHER_CORE_VERSION
}

#[tauri::command]
fn default_install_root() -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let launcher_directory = executable.parent().ok_or("Nordiee installation directory is unavailable.")?;
    Ok(launcher_directory.join("NordieeApps").to_string_lossy().into_owned())
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

#[tauri::command]
async fn install_game(app: AppHandle, manifest_json: String, install_root: String) -> Result<serde_json::Value, String> {
    let manifest: nordiee_core::GameManifest = serde_json::from_str(&manifest_json)
        .map_err(|_| "The game build manifest is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;

    let game_directory = PathBuf::from(install_root).join(&manifest.game_id);
    tokio::fs::create_dir_all(&game_directory).await.map_err(|error| error.to_string())?;
    let total_bytes = manifest.files.iter().map(|file| file.size).sum::<u64>();
    let mut completed_bytes = 0_u64;
    let client = reqwest::Client::new();

    for file in &manifest.files {
        let final_path = safe_install_path(&game_directory, &file.path)?;
        let partial_path = PathBuf::from(format!("{}.part", final_path.display()));
        let parent = final_path.parent().ok_or("The game file path is invalid.")?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?;

        let response = client.get(&file.source_url).send().await.map_err(|error| error.to_string())?
            .error_for_status().map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut output = tokio::fs::File::create(&partial_path).await.map_err(|error| error.to_string())?;
        let mut checksum = Sha256::new();
        let mut received_for_file = 0_u64;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            output.write_all(&chunk).await.map_err(|error| error.to_string())?;
            checksum.update(&chunk);
            received_for_file += chunk.len() as u64;
            let _ = app.emit("game-download-progress", serde_json::json!({
                "gameId": manifest.game_id,
                "filePath": file.path,
                "downloadedBytes": completed_bytes + received_for_file,
                "totalBytes": total_bytes
            }));
        }
        output.flush().await.map_err(|error| error.to_string())?;

        if received_for_file != file.size || format!("{:x}", checksum.finalize()) != file.sha256.to_ascii_lowercase() {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err(format!("Verification failed for {}.", file.path));
        }
        tokio::fs::rename(&partial_path, &final_path).await.map_err(|error| error.to_string())?;
        completed_bytes += received_for_file;
    }

    let _ = app.emit("game-download-complete", serde_json::json!({ "gameId": manifest.game_id, "path": game_directory }));
    Ok(serde_json::json!({ "gameId": manifest.game_id, "path": game_directory, "version": manifest.version }))
}

fn safe_install_path(game_directory: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let destination = game_directory.join(relative_path);
    if !destination.starts_with(game_directory) {
        return Err("The game file path is invalid.".to_string());
    }
    Ok(destination)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![launcher_version, default_install_root, save_account_secret, load_account_secret, remove_account_secret, install_game])
        .run(tauri::generate_context!())
        .expect("error while running Nordiee Launcher");
}
