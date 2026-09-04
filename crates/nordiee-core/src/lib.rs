//! Framework-independent launcher domain layer.
//!
//! Downloading, manifest validation, patching and game process management
//! will live here, independently from Tauri commands.

use serde::{Deserialize, Serialize};

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
            }],
        };
        assert_eq!(manifest.validate(), Err("manifest file path must be a safe relative path"));
    }

    #[test]
    fn rejects_non_sha256_hashes() {
        let manifest = GameManifest {
            game_id: "nordiee-demo".into(),
            version: "0.1.0".into(),
            files: vec![ManifestFile { path: "Game.exe".into(), size: 42, sha256: "not-a-hash".into() }],
        };
        assert_eq!(manifest.validate(), Err("manifest file hash must be a SHA-256 hex digest"));
    }
}
