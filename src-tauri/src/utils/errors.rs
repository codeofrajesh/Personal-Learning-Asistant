//! Custom error types for the PLE backend.
//!
//! All fallible IPC commands return `Result<T, AppError>`. `AppError` implements
//! `serde::Serialize` so Tauri can hand a structured error back to the frontend
//! instead of a bare string.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error(
        "the database connection is poisoned (a prior thread panicked while holding the lock)"
    )]
    Poisoned,

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("{0}")]
    Other(String),
}

// Serialize as a plain string so the frontend receives a readable message.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
