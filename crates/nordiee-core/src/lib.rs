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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_game_id() {
        assert!(GameId::parse("  ").is_err());
    }
}
