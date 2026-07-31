//! Planning / Scheduling / Intelligence engine (v9).
//!
//! This module is deliberately **pure**: no `Connection`, no clock, no I/O, no Tauri. The
//! database layer (`db::plan`) reads a snapshot, releases the mutex, and hands plain Rust
//! structs to [`solver`]. That separation is the whole reason the scheduling math is safe on
//! the 4 GB target:
//!
//!   * The app holds ONE `Mutex<Connection>`. Any long computation performed while holding it
//!     stalls playback IPC (`save_progress` / `log_session`) and shows up as video stutter.
//!     A pure solver cannot hold the lock because it never sees the connection.
//!   * `now` is injected as "minutes since midnight" rather than read from the clock, so every
//!     scenario (woke up late, mid-block, past hard stop) is a plain unit test.
//!
//! Time model: LOCAL WALL-CLOCK minutes-since-midnight. A student who plans "6:00 AM" means
//! 6 AM wherever they are; there is no timezone conversion anywhere in this module. See the
//! schema notes on `plan_blocks` for why UTC would be wrong here.

pub mod solver;

/// Minutes in a day. Used to clamp wall-clock arithmetic so a bad input can't produce a
/// block scheduled "tomorrow" inside today's plan.
pub const MINUTES_PER_DAY: i32 = 24 * 60;

/// Default hard stop ('HH:MM') when neither the day nor the global setting specifies one.
/// 22:00 is a deliberate choice: late enough not to fight a motivated student, early enough
/// that the solver doesn't cheerfully schedule study at 3 AM.
pub const DEFAULT_HARD_STOP: &str = "22:00";

/// Default wake time ('HH:MM') — the start of the usable window when unset.
pub const DEFAULT_WAKE: &str = "06:00";

/// Parse a local `'HH:MM'` (or `'HH:MM:SS'`) wall-clock string into minutes since midnight.
///
/// Returns `None` for anything malformed or out of range, so callers can fall back to a
/// default rather than silently scheduling at minute 0 (midnight) — a wrong-but-plausible
/// time is far more damaging in a planner than an obvious absence.
pub fn parse_hhmm(s: &str) -> Option<i32> {
    let s = s.trim();
    let mut parts = s.split(':');
    let h: i32 = parts.next()?.trim().parse().ok()?;
    let m: i32 = parts.next()?.trim().parse().ok()?;
    // A trailing seconds component is tolerated but ignored (we never plan to the second).
    if !(0..24).contains(&h) || !(0..60).contains(&m) {
        return None;
    }
    Some(h * 60 + m)
}

/// Format minutes-since-midnight back into a local `'HH:MM'` string.
///
/// Clamps into `[0, 23:59]`: a block pushed past midnight is pinned to the end of the day
/// rather than wrapping to an early-morning slot the student never asked for.
pub fn fmt_hhmm(mins: i32) -> String {
    let m = mins.clamp(0, MINUTES_PER_DAY - 1);
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// Human-friendly duration for explanation strings ("1h 20m", "45m").
pub fn fmt_duration(mins: i32) -> String {
    let m = mins.max(0);
    if m < 60 {
        return format!("{m}m");
    }
    let (h, rem) = (m / 60, m % 60);
    if rem == 0 {
        format!("{h}h")
    } else {
        format!("{h}h {rem}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_wall_clock() {
        assert_eq!(parse_hhmm("06:00"), Some(360));
        assert_eq!(parse_hhmm("6:00"), Some(360));
        assert_eq!(parse_hhmm("23:59"), Some(1439));
        assert_eq!(parse_hhmm("00:00"), Some(0));
        // Tolerates a seconds component (the DB sometimes carries 'HH:MM:SS').
        assert_eq!(parse_hhmm("07:30:00"), Some(450));
        assert_eq!(fmt_hhmm(360), "06:00");
        assert_eq!(fmt_hhmm(1439), "23:59");
        // Round-trip.
        assert_eq!(parse_hhmm(&fmt_hhmm(915)), Some(915));
    }

    #[test]
    fn rejects_malformed_times_rather_than_defaulting_to_midnight() {
        // Silently returning 0 here would schedule study at midnight — worse than an error.
        for bad in ["", "abc", "24:00", "12:60", "-1:00", "12", "::"] {
            assert_eq!(parse_hhmm(bad), None, "{bad:?} must not parse");
        }
    }

    #[test]
    fn clamps_out_of_range_minutes_instead_of_wrapping() {
        // A block pushed past midnight pins to 23:59; it must NOT wrap to 00:xx.
        assert_eq!(fmt_hhmm(MINUTES_PER_DAY + 30), "23:59");
        assert_eq!(fmt_hhmm(-30), "00:00");
    }

    #[test]
    fn formats_durations() {
        assert_eq!(fmt_duration(45), "45m");
        assert_eq!(fmt_duration(60), "1h");
        assert_eq!(fmt_duration(80), "1h 20m");
        assert_eq!(fmt_duration(0), "0m");
    }
}
