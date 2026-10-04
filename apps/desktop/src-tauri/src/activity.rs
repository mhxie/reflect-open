//! Keeps long, user-initiated background work at full speed on macOS.
//!
//! While no Reflect window is visible, App Nap drops the whole process to
//! background priority: every thread throttled, efficiency cores only. An
//! embedding pass that re-embeds the graph after a model switch then runs
//! several times slower. An `NSProcessInfo` activity held for the pass's
//! duration opts out of App Nap and still lets the idle system sleep. A
//! recording also holds off idle sleep: nobody touches the Mac during a call.
//! Other platforms have no App Nap, so there the commands only track tokens.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use tauri::State;

/// The activities the frontend holds, by token.
#[derive(Default)]
pub struct ActivityState {
    next_token: AtomicU64,
    held: Mutex<HashMap<String, platform::Activity>>,
}

impl ActivityState {
    fn held(&self) -> MutexGuard<'_, HashMap<String, platform::Activity>> {
        self.held
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// Begin an activity for `reason` (shown in Activity Monitor's energy
/// diagnostics) and return the token that ends it.
#[tauri::command]
pub fn activity_begin(reason: String, state: State<'_, ActivityState>) -> String {
    let sequence = state.next_token.fetch_add(1, Ordering::Relaxed) + 1;
    let token = format!("activity-{sequence}");
    let activity = platform::begin(&reason, true);
    state.held().insert(token.clone(), activity);
    token
}

/// End the activity `token` names. Unknown or already-ended tokens are
/// no-ops, so cleanup is safe from a `finally` block.
#[tauri::command]
pub fn activity_end(token: String, state: State<'_, ActivityState>) {
    let activity = state.held().remove(&token);
    if let Some(activity) = activity {
        platform::end(activity);
    }
}

/// An activity Rust code holds for as long as the guard lives (the macOS
/// recorder's).
#[cfg(target_os = "macos")]
pub(crate) struct ActivityGuard(Option<platform::Activity>);

#[cfg(target_os = "macos")]
impl ActivityGuard {
    /// Something is being recorded: hold off App Nap and idle sleep.
    pub(crate) fn recording() -> Self {
        Self(Some(platform::begin("Recording audio", false)))
    }

    /// A recording is being transcribed: hold off App Nap only.
    pub(crate) fn transcribing() -> Self {
        Self(Some(platform::begin("Transcribing a recording", true)))
    }
}

#[cfg(target_os = "macos")]
impl Drop for ActivityGuard {
    fn drop(&mut self) {
        if let Some(activity) = self.0.take() {
            platform::end(activity);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// The object `beginActivityWithOptions:reason:` returns; ending the
    /// activity hands it back.
    pub struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: the activity object is an opaque token that only ever travels
    // back to `endActivity:`, which NSProcessInfo documents as thread-safe.
    unsafe impl Send for Activity {}

    pub fn begin(reason: &str, idle_sleep: bool) -> Activity {
        let options = if idle_sleep {
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
        } else {
            NSActivityOptions::UserInitiated
        };
        let reason = NSString::from_str(reason);
        Activity(NSProcessInfo::processInfo().beginActivityWithOptions_reason(options, &reason))
    }

    pub fn end(activity: Activity) {
        // SAFETY: `activity` holds exactly the object `begin` received.
        unsafe { NSProcessInfo::processInfo().endActivity(&activity.0) };
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub struct Activity;

    pub fn begin(_reason: &str, _idle_sleep: bool) -> Activity {
        Activity
    }

    pub fn end(_activity: Activity) {}
}

#[cfg(test)]
mod tests {
    use super::{platform, ActivityState};

    #[test]
    fn a_token_ends_its_activity_once() {
        let state = ActivityState::default();
        state
            .held()
            .insert("activity-1".to_string(), platform::begin("test", true));
        let first = state.held().remove("activity-1");
        assert!(first.is_some());
        if let Some(activity) = first {
            platform::end(activity);
        }
        assert!(state.held().remove("activity-1").is_none());
    }
}
