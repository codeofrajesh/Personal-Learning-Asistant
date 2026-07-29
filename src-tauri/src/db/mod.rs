//! Database module: connection lifecycle, schema, and queries.

pub mod connection;
pub mod queries;
pub mod schema;

pub use connection::Db;
