//! Framework-independent launcher domain layer.
//!
//! Downloading, manifest validation, patching and game process management
//! will live here, independently from Tauri commands.

pub const LAUNCHER_CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

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
}
