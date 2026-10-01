//! The menu bar item: recording is started and stopped from wherever the
//! user is, usually a call in another app, so the control lives in the menu
//! bar rather than in a Reflect window. A click starts or stops recording; a
//! right-click opens the menu. It shows a ring while idle and a red dot with
//! the elapsed time while recording. Optional, behind a setting.

use std::sync::OnceLock;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

const TRAY_ID: &str = "recorder";
pub const MENU_TOGGLE: &str = "recorder.toggle";
pub const MENU_FOLDER: &str = "recorder.folder";
pub const MENU_SHOW: &str = "recorder.show";

/// 18 pt at 2x.
const ICON_SIZE: u32 = 36;

/// What the menu bar item shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Display {
    /// Seconds recorded so far, while recording.
    pub recording_seconds: Option<u64>,
    /// A watchdog warning is outstanding for this recording.
    pub warning: bool,
    /// Recordings being transcribed.
    pub transcribing: usize,
}

pub struct MenuBar {
    tray: TrayIcon,
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    folder: MenuItem<Wry>,
    shown: Option<Display>,
}

impl MenuBar {
    /// Add the item. A left click runs `on_click`; menu choices arrive through
    /// the app-wide menu listener (see `recorder::MENU_LISTENER`), never one
    /// per build. The click handler is keyed by the item, so a rebuild
    /// replaces it rather than adding another.
    pub fn build(
        app: &AppHandle,
        shortcut: Option<&str>,
        on_click: fn(&AppHandle),
    ) -> tauri::Result<Self> {
        let status =
            MenuItem::with_id(app, "recorder.status", "Not recording", false, None::<&str>)?;
        let toggle = MenuItem::with_id(app, MENU_TOGGLE, "Start Recording", true, shortcut)?;
        let folder = MenuItem::with_id(
            app,
            MENU_FOLDER,
            "Open Recordings Folder",
            false,
            None::<&str>,
        )?;
        let show = MenuItem::with_id(app, MENU_SHOW, "Show Reflect", true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[
                &status,
                &toggle,
                &PredefinedMenuItem::separator(app)?,
                &folder,
                &show,
            ],
        )?;
        let tray = TrayIconBuilder::with_id(TRAY_ID)
            .icon(idle_icon())
            .icon_as_template(true)
            .tooltip("Reflect: click to record, right-click for more")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(move |tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    on_click(tray.app_handle());
                }
            })
            .build(app)?;
        Ok(Self {
            tray,
            status,
            toggle,
            folder,
            shown: None,
        })
    }

    pub fn set_folder_available(&self, available: bool) {
        let _ = self.folder.set_enabled(available);
    }

    /// Bring the item up to date; repeated identical displays cost nothing.
    pub fn show(&mut self, display: Display) {
        if self.shown.as_ref() == Some(&display) {
            return;
        }
        let was_recording = self
            .shown
            .as_ref()
            .map(|shown| shown.recording_seconds.is_some());
        let recording = display.recording_seconds.is_some();
        if was_recording != Some(recording) {
            let (icon, template) = if recording {
                (recording_icon(), false)
            } else {
                (idle_icon(), true)
            };
            let _ = self.tray.set_icon(Some(icon));
            let _ = self.tray.set_icon_as_template(template);
            let _ = self.toggle.set_text(if recording {
                "Stop Recording"
            } else {
                "Start Recording"
            });
        }
        let title = display.recording_seconds.map(|seconds| {
            let clock = clock(seconds);
            if display.warning {
                format!("! {clock}")
            } else {
                clock
            }
        });
        let _ = self.tray.set_title(title.as_deref());
        let status = match (display.recording_seconds, display.transcribing) {
            (Some(seconds), _) => format!("Recording {}", clock(seconds)),
            (None, 0) => "Not recording".to_string(),
            (None, count) => format!(
                "Transcribing {count} recording{}",
                if count == 1 { "" } else { "s" }
            ),
        };
        let _ = self.status.set_text(status);
        self.shown = Some(display);
    }

    pub fn remove(self, app: &AppHandle) {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
}

fn clock(seconds: u64) -> String {
    format!(
        "{}:{:02}:{:02}",
        seconds / 3_600,
        seconds / 60 % 60,
        seconds % 60
    )
}

/// A template ring with a center dot: "record", tinted by the menu bar.
fn idle_icon() -> Image<'static> {
    static PIXELS: OnceLock<Vec<u8>> = OnceLock::new();
    let pixels = PIXELS.get_or_init(|| {
        draw(
            |distance| {
                let ring = coverage(distance, 15.0) - coverage(distance, 11.5);
                ring.max(coverage(distance, 6.0))
            },
            [0, 0, 0],
        )
    });
    Image::new(pixels, ICON_SIZE, ICON_SIZE)
}

/// A solid red dot while recording.
fn recording_icon() -> Image<'static> {
    static PIXELS: OnceLock<Vec<u8>> = OnceLock::new();
    let pixels = PIXELS.get_or_init(|| draw(|distance| coverage(distance, 13.0), [235, 64, 52]));
    Image::new(pixels, ICON_SIZE, ICON_SIZE)
}

/// Anti-aliased coverage of a disc of `radius` at `distance` from its center.
fn coverage(distance: f32, radius: f32) -> f32 {
    (radius - distance + 0.5).clamp(0.0, 1.0)
}

/// Rasterize a radially symmetric shape: `alpha` maps the distance from the
/// icon's center to coverage.
fn draw(alpha: impl Fn(f32) -> f32, color: [u8; 3]) -> Vec<u8> {
    let center = ICON_SIZE as f32 / 2.0;
    let mut pixels = Vec::with_capacity((ICON_SIZE * ICON_SIZE * 4) as usize);
    for row in 0..ICON_SIZE {
        for column in 0..ICON_SIZE {
            let horizontal = column as f32 + 0.5 - center;
            let vertical = row as f32 + 0.5 - center;
            let distance = (horizontal * horizontal + vertical * vertical).sqrt();
            pixels.extend_from_slice(&color);
            pixels.push((alpha(distance) * 255.0).round() as u8);
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_elapsed_clock() {
        assert_eq!(clock(0), "0:00:00");
        assert_eq!(clock(3_725), "1:02:05");
    }

    #[test]
    fn icons_have_a_shape() {
        let ring = idle_icon();
        assert_eq!(ring.rgba().len(), (ICON_SIZE * ICON_SIZE * 4) as usize);
        let center = ((ICON_SIZE / 2 * ICON_SIZE + ICON_SIZE / 2) * 4 + 3) as usize;
        let gap = ((ICON_SIZE / 2 * ICON_SIZE + ICON_SIZE / 2 + 9) * 4 + 3) as usize;
        assert_eq!(ring.rgba()[center], 255);
        assert_eq!(ring.rgba()[gap], 0);
        assert_eq!(ring.rgba()[3], 0);
    }
}
