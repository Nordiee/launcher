use keyring::Entry;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    download_manifest(&app, &manifest, &install_root, None).await
}

#[tauri::command]
async fn repair_game(app: AppHandle, game_id: String, install_root: String) -> Result<serde_json::Value, String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let game_directory = PathBuf::from(&install_root).join(&game_id);
    let receipt = tokio::fs::read(game_directory.join(".nordiee-install.json")).await.map_err(|_| "This game is not installed by Nordiee.".to_string())?;
    let manifest: nordiee_core::GameManifest = serde_json::from_slice(&receipt).map_err(|_| "The local installation record is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    if manifest.game_id != game_id {
        return Err("The local installation record does not match this game.".to_string());
    }
    let mut damaged_files = HashSet::new();
    for file in &manifest.files {
        let path = safe_install_path(&game_directory, &file.path)?;
        if !matches!(hash_file(&path).await, Ok(hash) if hash == file.sha256.to_ascii_lowercase()) {
            damaged_files.insert(file.path.clone());
        }
    }
    if damaged_files.is_empty() {
        return Ok(serde_json::json!({ "gameId": game_id, "repairedFiles": 0 }));
    }
    let repaired_files = damaged_files.len();
    download_manifest(&app, &manifest, &install_root, Some(&damaged_files)).await?;
    Ok(serde_json::json!({ "gameId": game_id, "repairedFiles": repaired_files }))
}

#[tauri::command]
async fn update_game(app: AppHandle, manifest_json: String, install_root: String) -> Result<serde_json::Value, String> {
    let manifest: nordiee_core::GameManifest = serde_json::from_str(&manifest_json)
        .map_err(|_| "The game build manifest is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    let game_directory = PathBuf::from(&install_root).join(&manifest.game_id);
    if !tokio::fs::try_exists(game_directory.join(".nordiee-install.json")).await.map_err(|error| error.to_string())? {
        return Err("This game is not installed by Nordiee.".to_string());
    }
    let mut changed_files = HashSet::new();
    for file in &manifest.files {
        let path = safe_install_path(&game_directory, &file.path)?;
        if !matches!(hash_file(&path).await, Ok(hash) if hash == file.sha256.to_ascii_lowercase()) {
            changed_files.insert(file.path.clone());
        }
    }
    let changed_file_count = changed_files.len();
    download_manifest(&app, &manifest, &install_root, Some(&changed_files)).await?;
    Ok(serde_json::json!({ "gameId": manifest.game_id, "version": manifest.version, "changedFiles": changed_file_count }))
}

async fn download_manifest(app: &AppHandle, manifest: &nordiee_core::GameManifest, install_root: &str, selected_files: Option<&HashSet<String>>) -> Result<serde_json::Value, String> {
    let game_directory = PathBuf::from(install_root).join(&manifest.game_id);
    tokio::fs::create_dir_all(&game_directory).await.map_err(|error| error.to_string())?;
    let total_bytes = manifest.files.iter().filter(|file| selected_files.map_or(true, |selected| selected.contains(&file.path))).map(|file| file.size).sum::<u64>();
    let mut completed_bytes = 0_u64;
    let client = reqwest::Client::new();

    for file in manifest.files.iter().filter(|file| selected_files.map_or(true, |selected| selected.contains(&file.path))) {
        let final_path = safe_install_path(&game_directory, &file.path)?;
        let partial_path = PathBuf::from(format!("{}.part", final_path.display()));
        let parent = final_path.parent().ok_or("The game file path is invalid.")?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?;

        let (mut checksum, mut received_for_file) = checksum_partial_file(&partial_path).await?;
        if received_for_file >= file.size {
            let _ = tokio::fs::remove_file(&partial_path).await;
            checksum = Sha256::new();
            received_for_file = 0;
        }
        let request = if received_for_file > 0 {
            client.get(&file.source_url).header(reqwest::header::RANGE, format!("bytes={received_for_file}-"))
        } else {
            client.get(&file.source_url)
        };
        let mut response = request.send().await.map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?;
        if received_for_file > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            let _ = tokio::fs::remove_file(&partial_path).await;
            checksum = Sha256::new();
            received_for_file = 0;
            response = client.get(&file.source_url).send().await.map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?;
        }
        let mut stream = response.bytes_stream();
        let mut output = if received_for_file > 0 {
            tokio::fs::OpenOptions::new().append(true).open(&partial_path).await.map_err(|error| error.to_string())?
        } else {
            tokio::fs::File::create(&partial_path).await.map_err(|error| error.to_string())?
        };

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

    let install_record = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    tokio::fs::write(game_directory.join(".nordiee-install.json"), install_record)
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit("game-download-complete", serde_json::json!({ "gameId": manifest.game_id, "path": game_directory }));
    Ok(serde_json::json!({ "gameId": manifest.game_id, "path": game_directory, "version": manifest.version }))
}

#[tauri::command]
async fn verify_game(game_id: String, install_root: String) -> Result<serde_json::Value, String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let game_directory = PathBuf::from(install_root).join(&game_id);
    let receipt = tokio::fs::read(game_directory.join(".nordiee-install.json")).await.map_err(|_| "This game is not installed by Nordiee.".to_string())?;
    let manifest: nordiee_core::GameManifest = serde_json::from_slice(&receipt).map_err(|_| "The local installation record is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    if manifest.game_id != game_id {
        return Err("The local installation record does not match this game.".to_string());
    }

    let mut damaged_files = Vec::new();
    for file in &manifest.files {
        let path = safe_install_path(&game_directory, &file.path)?;
        if !matches!(hash_file(&path).await, Ok(hash) if hash == file.sha256.to_ascii_lowercase()) {
            damaged_files.push(file.path.clone());
        }
    }
    Ok(serde_json::json!({
        "gameId": game_id,
        "version": manifest.version,
        "verified": damaged_files.is_empty(),
        "damagedFiles": damaged_files
    }))
}

#[tauri::command]
async fn installed_game_version(game_id: String, install_root: String) -> Result<Option<String>, String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let receipt_path = PathBuf::from(install_root).join(&game_id).join(".nordiee-install.json");
    let receipt = match tokio::fs::read(receipt_path).await {
        Ok(receipt) => receipt,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let manifest: nordiee_core::GameManifest = serde_json::from_slice(&receipt).map_err(|_| "The local installation record is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    if manifest.game_id != game_id {
        return Err("The local installation record does not match this game.".to_string());
    }
    Ok(Some(manifest.version))
}

#[tauri::command]
async fn uninstall_game(game_id: String, install_root: String) -> Result<(), String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let game_directory = PathBuf::from(&install_root).join(&game_id);
    if !game_directory.starts_with(Path::new(&install_root)) {
        return Err("The game installation path is invalid.".to_string());
    }
    match tokio::fs::remove_dir_all(&game_directory).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn launch_game(game_id: String, install_root: String) -> Result<(), String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let game_directory = PathBuf::from(&install_root).join(&game_id);
    let receipt = tokio::fs::read(game_directory.join(".nordiee-install.json")).await.map_err(|_| "This game is not installed by Nordiee.".to_string())?;
    let manifest: nordiee_core::GameManifest = serde_json::from_slice(&receipt).map_err(|_| "The local installation record is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    if manifest.game_id != game_id {
        return Err("The local installation record does not match this game.".to_string());
    }
    let executable = safe_install_path(&game_directory, &manifest.launch_executable)?;
    if !tokio::fs::try_exists(&executable).await.map_err(|error| error.to_string())? {
        return Err("The game's launch file is missing. Run Verify files or Repair files.".to_string());
    }
    std::process::Command::new(executable).current_dir(game_directory).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

async fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|_| "A game file is missing.".to_string())?;
    let mut checksum = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let bytes_read = file.read(&mut buffer).await.map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }
        checksum.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", checksum.finalize()))
}

async fn checksum_partial_file(path: &Path) -> Result<(Sha256, u64), String> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Sha256::new(), 0)),
        Err(error) => return Err(error.to_string()),
    };
    let mut checksum = Sha256::new();
    let mut received_bytes = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let bytes_read = file.read(&mut buffer).await.map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }
        checksum.update(&buffer[..bytes_read]);
        received_bytes += bytes_read as u64;
    }
    Ok((checksum, received_bytes))
}

fn safe_install_path(game_directory: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let destination = game_directory.join(relative_path);
    if !destination.starts_with(game_directory) {
        return Err("The game file path is invalid.".to_string());
    }
    Ok(destination)
}

fn safe_game_id(game_id: &str) -> bool {
    !game_id.is_empty() && game_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![launcher_version, default_install_root, save_account_secret, load_account_secret, remove_account_secret, install_game, repair_game, update_game, verify_game, installed_game_version, uninstall_game, launch_game])
        .run(tauri::generate_context!())
        .expect("error while running Nordiee Launcher");
}
