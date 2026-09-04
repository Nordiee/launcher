//! Framework-independent launcher domain layer.
//!
//! Downloading, manifest validation, patching and game process management
//! will live here, independently from Tauri commands.

use serde::{Deserialize, Serialize};
use url::Url;

pub const LAUNCHER_CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Describes the exact files that belong to a distributable game build.
/// The launcher validates this before touching the local installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameManifest {
    pub game_id: String,
    pub version: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(rename = "sourceUrl")]
    pub source_url: String,
}

impl GameManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.game_id.trim().is_empty() {
            return Err("manifest game id cannot be empty");
        }
        if self.version.trim().is_empty() {
            return Err("manifest version cannot be empty");
        }
        if self.files.is_empty() {
            return Err("manifest must include at least one file");
        }
        for file in &self.files {
            validate_manifest_file(file)?;
        }
        Ok(())
    }
}

fn validate_manifest_file(file: &ManifestFile) -> Result<(), &'static str> {
    let normalized_path = file.path.replace('\\', "/");
    if normalized_path.is_empty()
        || normalized_path.starts_with('/')
        || normalized_path.starts_with("//")
        || normalized_path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || normalized_path.as_bytes().get(1) == Some(&b':')
    {
        return Err("manifest file path must be a safe relative path");
    }
    if file.size == 0 {
        return Err("manifest file size must be greater than zero");
    }
    if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("manifest file hash must be a SHA-256 hex digest");
    }
    let source_url = Url::parse(&file.source_url).map_err(|_| "manifest file source URL is invalid")?;
    if source_url.scheme() != "https" || source_url.host_str().is_none() || source_url.fragment().is_some() {
        return Err("manifest file source URL must be an HTTPS URL");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameId(String);

impl GameId {
    pub fn parse(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err("game id cannot be empty");
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallState {
    NotInstalled,
    Queued,
    Downloading,
    Paused,
    Verifying,
    Installed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadTask {
    pub game_id: GameId,
    pub state: InstallState,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

impl DownloadTask {
    pub fn queue(game_id: GameId, total_bytes: u64) -> Result<Self, &'static str> {
        if total_bytes == 0 {
            return Err("download size must be greater than zero");
        }
        Ok(Self { game_id, state: InstallState::Queued, downloaded_bytes: 0, total_bytes })
    }

    pub fn start(&mut self) -> Result<(), &'static str> {
        match self.state {
            InstallState::Queued | InstallState::Paused => {
                self.state = InstallState::Downloading;
                Ok(())
            }
            _ => Err("download cannot be started from its current state"),
        }
    }

    pub fn pause(&mut self) -> Result<(), &'static str> {
        if self.state != InstallState::Downloading {
            return Err("only active downloads can be paused");
        }
        self.state = InstallState::Paused;
        Ok(())
    }

    pub fn record_progress(&mut self, received_bytes: u64) -> Result<(), &'static str> {
        if self.state != InstallState::Downloading {
            return Err("only active downloads can record progress");
        }
        self.downloaded_bytes = self.downloaded_bytes.saturating_add(received_bytes).min(self.total_bytes);
        if self.downloaded_bytes == self.total_bytes {
            self.state = InstallState::Verifying;
        }
        Ok(())
    }

    pub fn mark_verified(&mut self) -> Result<(), &'static str> {
        if self.state != InstallState::Verifying {
            return Err("only completed downloads can be verified");
        }
        self.state = InstallState::Installed;
        Ok(())
    }
}

/// In-memory queue policy for the first download engine iteration.
/// Persisting task state and transferring bytes are deliberately separate concerns.
#[derive(Debug, Default)]
pub struct DownloadQueue {
    tasks: Vec<DownloadTask>,
}

impl DownloadQueue {
    pub fn queue(&mut self, game_id: GameId, total_bytes: u64) -> Result<(), &'static str> {
        if self.tasks.iter().any(|task| task.game_id == game_id) {
            return Err("a download for this game is already tracked");
        }
        self.tasks.push(DownloadTask::queue(game_id, total_bytes)?);
        Ok(())
    }

    pub fn tasks(&self) -> &[DownloadTask] {
        &self.tasks
    }

    pub fn start_next(&mut self) -> Result<Option<&DownloadTask>, &'static str> {
        if self.tasks.iter().any(|task| task.state == InstallState::Downloading) {
            return Err("an active download is already running");
        }
        let Some(next) = self.tasks.iter_mut().find(|task| task.state == InstallState::Queued) else {
            return Ok(None);
        };
        next.start()?;
        Ok(Some(next))
    }

    pub fn pause(&mut self, game_id: &str) -> Result<(), &'static str> {
        self.find_mut(game_id)?.pause()
    }

    pub fn resume(&mut self, game_id: &str) -> Result<(), &'static str> {
        if self.tasks.iter().any(|task| task.state == InstallState::Downloading) {
            return Err("an active download is already running");
        }
        self.find_mut(game_id)?.start()
    }

    pub fn prioritize(&mut self, game_id: &str) -> Result<(), &'static str> {
        let index = self.find_index(game_id)?;
        if self.tasks[index].state != InstallState::Queued {
            return Err("only queued downloads can be prioritized");
        }
        let task = self.tasks.remove(index);
        let first_queued = self.tasks.iter().position(|candidate| candidate.state == InstallState::Queued).unwrap_or(self.tasks.len());
        self.tasks.insert(first_queued, task);
        Ok(())
    }

    pub fn cancel(&mut self, game_id: &str) -> Result<DownloadTask, &'static str> {
        let index = self.find_index(game_id)?;
        if self.tasks[index].state == InstallState::Installed {
            return Err("installed games cannot be cancelled");
        }
        Ok(self.tasks.remove(index))
    }

    fn find_index(&self, game_id: &str) -> Result<usize, &'static str> {
        self.tasks.iter().position(|task| task.game_id.as_str() == game_id).ok_or("download was not found")
    }

    fn find_mut(&mut self, game_id: &str) -> Result<&mut DownloadTask, &'static str> {
        let index = self.find_index(game_id)?;
        Ok(&mut self.tasks[index])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_game_id() {
        assert!(GameId::parse("  ").is_err());
    }

    #[test]
    fn download_can_pause_resume_and_finish() {
        let mut task = DownloadTask::queue(GameId::parse("ashen-crown").unwrap(), 100).unwrap();
        task.start().unwrap();
        task.record_progress(40).unwrap();
        task.pause().unwrap();
        task.start().unwrap();
        task.record_progress(60).unwrap();
        assert_eq!(task.state, InstallState::Verifying);
        task.mark_verified().unwrap();
        assert_eq!(task.state, InstallState::Installed);
    }

    #[test]
    fn accepts_a_safe_game_manifest() {
        let manifest = GameManifest {
            game_id: "nordiee-demo".into(),
            version: "0.1.0".into(),
            files: vec![ManifestFile {
                path: "Game/Content/pak01.pak".into(),
                size: 42,
                sha256: "a".repeat(64),
                source_url: "https://downloads.nordiee.com/games/nordiee-demo/0.1.0/pak01.pak".into(),
            }],
        };
        assert!(manifest.validate().is_ok());
    }

    #[test]
    fn rejects_manifest_paths_that_escape_the_installation() {
        let manifest = GameManifest {
            game_id: "nordiee-demo".into(),
            version: "0.1.0".into(),
            files: vec![ManifestFile {
                path: "../Windows/System32/file.dll".into(),
                size: 42,
                sha256: "a".repeat(64),
                source_url: "https://downloads.nordiee.com/games/nordiee-demo/0.1.0/file.dll".into(),
            }],
        };
        assert_eq!(manifest.validate(), Err("manifest file path must be a safe relative path"));
    }

    #[test]
    fn rejects_non_sha256_hashes() {
        let manifest = GameManifest {
            game_id: "nordiee-demo".into(),
            version: "0.1.0".into(),
            files: vec![ManifestFile { path: "Game.exe".into(), size: 42, sha256: "not-a-hash".into(), source_url: "https://downloads.nordiee.com/games/nordiee-demo/0.1.0/Game.exe".into() }],
        };
        assert_eq!(manifest.validate(), Err("manifest file hash must be a SHA-256 hex digest"));
    }

    #[test]
    fn rejects_non_https_download_urls() {
        let manifest = GameManifest {
            game_id: "nordiee-demo".into(),
            version: "0.1.0".into(),
            files: vec![ManifestFile {
                path: "Game.exe".into(),
                size: 42,
                sha256: "a".repeat(64),
                source_url: "http://downloads.nordiee.com/games/nordiee-demo/0.1.0/Game.exe".into(),
            }],
        };
        assert_eq!(manifest.validate(), Err("manifest file source URL must be an HTTPS URL"));
    }

    #[test]
    fn queue_pauses_resumes_and_prioritizes_downloads() {
        let mut queue = DownloadQueue::default();
        queue.queue(GameId::parse("first").unwrap(), 100).unwrap();
        queue.queue(GameId::parse("second").unwrap(), 100).unwrap();
        queue.prioritize("second").unwrap();
        assert_eq!(queue.tasks()[0].game_id.as_str(), "second");

        queue.start_next().unwrap();
        assert_eq!(queue.tasks()[0].state, InstallState::Downloading);
        queue.pause("second").unwrap();
        assert_eq!(queue.tasks()[0].state, InstallState::Paused);
        queue.resume("second").unwrap();
        assert_eq!(queue.tasks()[0].state, InstallState::Downloading);
        assert_eq!(queue.resume("first"), Err("an active download is already running"));
    }

    #[test]
    fn queue_rejects_duplicate_game_downloads() {
        let mut queue = DownloadQueue::default();
        queue.queue(GameId::parse("first").unwrap(), 100).unwrap();
        assert_eq!(queue.queue(GameId::parse("first").unwrap(), 100), Err("a download for this game is already tracked"));
    }
}
