use keyring::Entry;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
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

#[tauri::command]
fn install_location_free_space(install_root: String) -> Result<u64, String> {
    let directory = PathBuf::from(install_root);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs2::available_space(directory).map_err(|error| error.to_string())
}

const STARTUP_VALUE_NAME: &str = "Nordiee Launcher";

#[tauri::command]
fn launch_at_startup_enabled() -> Result<bool, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = current_user.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_READ).map_err(|error| error.to_string())?;
    Ok(run_key.get_value::<String, _>(STARTUP_VALUE_NAME).is_ok())
}

#[tauri::command]
fn set_launch_at_startup(enabled: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = current_user.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run").map_err(|error| error.to_string())?;
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        run_key.set_value(STARTUP_VALUE_NAME, &format!("\\\"{}\\\"", executable.display())).map_err(|error| error.to_string())?;
    } else if let Err(error) = run_key.delete_value(STARTUP_VALUE_NAME) {
        if error.kind() != std::io::ErrorKind::NotFound { return Err(error.to_string()); }
    }
    Ok(())
}

const ACCOUNT_SECRET_SERVICE: &str = "com.nordiee.launcher.account";

struct RunningGames(Arc<Mutex<HashSet<String>>>);
struct DownloadControls {
    paused: AtomicBool,
    cancelled: AtomicBool,
    resumed: tokio::sync::Notify,
    transfer_lock: tokio::sync::Mutex<()>,
}

impl DownloadControls {
    fn new() -> Self { Self { paused: AtomicBool::new(false), cancelled: AtomicBool::new(false), resumed: tokio::sync::Notify::new(), transfer_lock: tokio::sync::Mutex::new(()) } }

    async fn acquire_transfer(&self) -> tokio::sync::MutexGuard<'_, ()> {
        let guard = self.transfer_lock.lock().await;
        self.cancelled.store(false, Ordering::Release);
        guard
    }

    async fn wait_for_transfer_permission(&self) -> bool {
        loop {
            if self.cancelled.load(Ordering::Acquire) { return false; }
            if !self.paused.load(Ordering::Acquire) { return true; }
            let notified = self.resumed.notified();
            if self.cancelled.load(Ordering::Acquire) { return false; }
            if !self.paused.load(Ordering::Acquire) { return true; }
            notified.await;
        }
    }
}

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
async fn install_game(app: AppHandle, controls: State<'_, DownloadControls>, manifest_json: String, install_root: String, download_limit_mbps: Option<u64>) -> Result<serde_json::Value, String> {
    let manifest: nordiee_core::GameManifest = serde_json::from_str(&manifest_json)
        .map_err(|_| "The game build manifest is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    let _transfer_guard = controls.acquire_transfer().await;
    download_manifest(&app, &controls, &manifest, &install_root, None, None, download_limit_mbps).await
}

#[tauri::command]
async fn repair_game(app: AppHandle, controls: State<'_, DownloadControls>, game_id: String, install_root: String, download_limit_mbps: Option<u64>) -> Result<serde_json::Value, String> {
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
    let _transfer_guard = controls.acquire_transfer().await;
    download_manifest(&app, &controls, &manifest, &install_root, Some(&damaged_files), None, download_limit_mbps).await?;
    Ok(serde_json::json!({ "gameId": game_id, "repairedFiles": repaired_files }))
}

#[tauri::command]
async fn update_game(app: AppHandle, controls: State<'_, DownloadControls>, manifest_json: String, install_root: String, download_limit_mbps: Option<u64>) -> Result<serde_json::Value, String> {
    let manifest: nordiee_core::GameManifest = serde_json::from_str(&manifest_json)
        .map_err(|_| "The game build manifest is invalid.".to_string())?;
    manifest.validate().map_err(|error| error.to_string())?;
    let game_directory = PathBuf::from(&install_root).join(&manifest.game_id);
    let previous_receipt = tokio::fs::read(game_directory.join(".nordiee-install.json")).await.map_err(|_| "This game is not installed by Nordiee.".to_string())?;
    let previous_manifest: nordiee_core::GameManifest = serde_json::from_slice(&previous_receipt).map_err(|_| "The local installation record is invalid.".to_string())?;
    previous_manifest.validate().map_err(|error| error.to_string())?;
    if previous_manifest.game_id != manifest.game_id { return Err("The local installation record does not match this game.".to_string()); }
    let mut changed_files = HashSet::new();
    for file in &manifest.files {
        let path = safe_install_path(&game_directory, &file.path)?;
        if !matches!(hash_file(&path).await, Ok(hash) if hash == file.sha256.to_ascii_lowercase()) {
            changed_files.insert(file.path.clone());
        }
    }
    let changed_file_count = changed_files.len();
    let next_paths: HashSet<&str> = manifest.files.iter().map(|file| file.path.as_str()).collect();
    let stale_files: HashSet<String> = previous_manifest.files.iter().filter(|file| !next_paths.contains(file.path.as_str())).map(|file| file.path.clone()).collect();
    let _transfer_guard = controls.acquire_transfer().await;
    download_manifest(&app, &controls, &manifest, &install_root, Some(&changed_files), Some(&stale_files), download_limit_mbps).await?;
    Ok(serde_json::json!({ "gameId": manifest.game_id, "version": manifest.version, "changedFiles": changed_file_count }))
}

async fn download_manifest(app: &AppHandle, controls: &DownloadControls, manifest: &nordiee_core::GameManifest, install_root: &str, selected_files: Option<&HashSet<String>>, stale_files: Option<&HashSet<String>>, download_limit_mbps: Option<u64>) -> Result<serde_json::Value, String> {
    let game_directory = PathBuf::from(install_root).join(&manifest.game_id);
    tokio::fs::create_dir_all(&game_directory).await.map_err(|error| error.to_string())?;
    let selected_manifest_files: Vec<_> = manifest.files.iter().filter(|file| selected_files.map_or(true, |selected| selected.contains(&file.path))).collect();
    let total_bytes = selected_manifest_files.iter().map(|file| file.size).sum::<u64>();
    let mut required_bytes = 0_u64;
    for file in &selected_manifest_files {
        let final_path = safe_install_path(&game_directory, &file.path)?;
        let partial_path = PathBuf::from(format!("{}.part", final_path.display()));
        let partial_size = tokio::fs::metadata(partial_path).await.map(|metadata| metadata.len()).unwrap_or(0).min(file.size);
        required_bytes += file.size - partial_size;
    }
    let available_bytes = fs2::available_space(&game_directory).map_err(|error| format!("Could not check free disk space: {error}"))?;
    if available_bytes < required_bytes {
        return Err(format!("Not enough free disk space. Nordiee needs {} more MB for this transfer.", (required_bytes - available_bytes).div_ceil(1_000_000)));
    }
    let mut completed_bytes = 0_u64;
    let client = reqwest::Client::new();
    let mut rate_limiter = DownloadRateLimiter::new(download_limit_mbps);

    for file in selected_manifest_files {
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
            if !controls.wait_for_transfer_permission().await {
                return Err("Download cancelled. The partial files were kept so it can resume later.".to_string());
            }
            let chunk = chunk.map_err(|error| error.to_string())?;
            output.write_all(&chunk).await.map_err(|error| error.to_string())?;
            checksum.update(&chunk);
            received_for_file += chunk.len() as u64;
            rate_limiter.after_chunk(chunk.len() as u64).await;
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

    for stale_file in stale_files.into_iter().flatten() {
        let stale_path = safe_install_path(&game_directory, stale_file)?;
        match tokio::fs::remove_file(&stale_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not remove obsolete game file {}: {error}", stale_file)),
        }
    }

    let install_record = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    tokio::fs::write(game_directory.join(".nordiee-install.json"), install_record)
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit("game-download-complete", serde_json::json!({ "gameId": manifest.game_id, "path": game_directory }));
    Ok(serde_json::json!({ "gameId": manifest.game_id, "path": game_directory, "version": manifest.version }))
}

#[tauri::command]
fn pause_downloads(app: AppHandle, controls: State<'_, DownloadControls>) {
    controls.paused.store(true, Ordering::Release);
    let _ = app.emit("download-transfer-state", serde_json::json!({ "paused": true }));
}

#[tauri::command]
fn resume_downloads(app: AppHandle, controls: State<'_, DownloadControls>) {
    controls.paused.store(false, Ordering::Release);
    controls.resumed.notify_waiters();
    let _ = app.emit("download-transfer-state", serde_json::json!({ "paused": false }));
}

#[tauri::command]
fn cancel_downloads(app: AppHandle, controls: State<'_, DownloadControls>) {
    controls.cancelled.store(true, Ordering::Release);
    controls.paused.store(false, Ordering::Release);
    controls.resumed.notify_waiters();
    let _ = app.emit("download-transfer-state", serde_json::json!({ "cancelled": true }));
}

struct DownloadRateLimiter {
    bytes_per_second: Option<u64>,
    started_at: Instant,
    transferred_bytes: u64,
}

impl DownloadRateLimiter {
    fn new(limit_mbps: Option<u64>) -> Self {
        Self { bytes_per_second: limit_mbps.filter(|limit| *limit > 0).map(|limit| limit * 1_000_000), started_at: Instant::now(), transferred_bytes: 0 }
    }

    async fn after_chunk(&mut self, bytes: u64) {
        let Some(bytes_per_second) = self.bytes_per_second else { return; };
        self.transferred_bytes += bytes;
        let expected = Duration::from_secs_f64(self.transferred_bytes as f64 / bytes_per_second as f64);
        if let Some(wait) = expected.checked_sub(self.started_at.elapsed()) {
            tokio::time::sleep(wait).await;
        }
    }
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
async fn installed_game_size(game_id: String, install_root: String) -> Result<Option<u64>, String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let game_directory = PathBuf::from(install_root).join(game_id);
    if !tokio::fs::try_exists(&game_directory).await.map_err(|error| error.to_string())? {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || directory_size(&game_directory)).await.map_err(|error| error.to_string())?.map(Some)
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
async fn open_game_folder(game_id: String, install_root: String) -> Result<(), String> {
    if !safe_game_id(&game_id) {
        return Err("The game identifier is invalid.".to_string());
    }
    let game_directory = PathBuf::from(&install_root).join(&game_id);
    if !game_directory.starts_with(Path::new(&install_root)) || !tokio::fs::try_exists(&game_directory).await.map_err(|error| error.to_string())? {
        return Err("This game is not installed by Nordiee.".to_string());
    }
    std::process::Command::new("explorer.exe").arg(game_directory).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn launch_game(app: AppHandle, running_games: State<'_, RunningGames>, game_id: String, install_root: String, launch_arguments: Vec<String>) -> Result<(), String> {
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
    if running_games.0.lock().map_err(|_| "The game process tracker is unavailable.")?.contains(&game_id) {
        return Err("This game is already running.".to_string());
    }
    if launch_arguments.len() > 64 || launch_arguments.iter().any(|argument| argument.len() > 256) {
        return Err("The launch options are too long.".to_string());
    }
    let mut process = std::process::Command::new(executable).args(launch_arguments).current_dir(game_directory).spawn().map_err(|error| error.to_string())?;
    running_games.0.lock().map_err(|_| "The game process tracker is unavailable.")?.insert(game_id.clone());
    let tracked_games = running_games.0.clone();
    let completed_game_id = game_id.clone();
    let completed_app = app.clone();
    std::thread::spawn(move || {
        let _ = process.wait();
        if let Ok(mut games) = tracked_games.lock() {
            games.remove(&completed_game_id);
        }
        let _ = completed_app.emit("game-running-state", serde_json::json!({ "gameId": completed_game_id, "running": false }));
    });
    let _ = app.emit("game-running-state", serde_json::json!({ "gameId": game_id, "running": true }));
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

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

#[tauri::command]
async fn diagnostics_check_endpoint(target: String) -> Result<bool, String> {
    let (url, accepts_not_found) = match target.as_str() {
        "api" => ("https://api.nordiee.com/health", false),
        // The bucket root intentionally has no public listing. A 404 confirms the R2 edge is reachable.
        "downloads" => ("https://downloads.nordiee.com/", true),
        _ => return Err("Unknown diagnostic target.".to_string()),
    };
    let response = reqwest::Client::new().head(url).send().await.map_err(|error| error.to_string())?;
    Ok(response.status().is_success() || (accepts_not_found && response.status() == reqwest::StatusCode::NOT_FOUND))
}

#[tauri::command]
async fn diagnostics_check_install_root(install_root: String) -> Result<bool, String> {
    let directory = PathBuf::from(install_root);
    tokio::fs::create_dir_all(&directory).await.map_err(|error| error.to_string())?;
    let probe = directory.join(".nordiee-write-probe");
    tokio::fs::write(&probe, b"nordiee").await.map_err(|error| error.to_string())?;
    tokio::fs::remove_file(probe).await.map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn run() {
    tauri::Builder::default()
        .manage(RunningGames(Arc::new(Mutex::new(HashSet::new()))))
        .manage(DownloadControls::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![launcher_version, default_install_root, install_location_free_space, launch_at_startup_enabled, set_launch_at_startup, save_account_secret, load_account_secret, remove_account_secret, install_game, repair_game, update_game, pause_downloads, resume_downloads, cancel_downloads, verify_game, installed_game_version, installed_game_size, uninstall_game, open_game_folder, launch_game, diagnostics_check_endpoint, diagnostics_check_install_root])
        .run(tauri::generate_context!())
        .expect("error while running Nordiee Launcher");
}
