//! The asset protocol and the desktop-only file commands (on-device reads,
//! PDF pages, image thumbnails, unsaved-text recovery, wiki trust reports),
//! plus the graph helpers the shell's other modules share. The file commands
//! shared with the Swift iOS shell live in `reflect_core::fs`.

pub mod asset_protocol;
pub mod device;
mod image_thumbnail;
pub mod pdf_render;
pub mod recovery;
pub mod trust_report;

use std::ops::Deref;
use std::sync::Arc;

use reflect_core::Core;
use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{Manager, Runtime};

pub use reflect_graph_io::*;

/// The open graph session, which the shared core owns. A command takes it as
/// an argument where it once took `State<GraphState>`, and other code asks
/// for it with [`GraphRef::of`]; either way it reads as a `GraphState`.
pub(crate) struct GraphRef {
    core: Arc<Core>,
}

impl GraphRef {
    /// The graph session of the core `manager` holds.
    pub(crate) fn of<R: Runtime>(manager: &impl Manager<R>) -> Self {
        Self {
            core: Arc::clone(manager.state::<Arc<Core>>().inner()),
        }
    }
}

impl Deref for GraphRef {
    type Target = GraphState;

    fn deref(&self) -> &GraphState {
        &self.core.graph
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for GraphRef {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        Ok(Self::of(&command.message.webview()))
    }
}
pub(crate) use reflect_graph_io::io::modified_ms;

/// Give a mock app the shared core, as `run` does for the real one: the
/// command tests then reach the graph session through [`GraphRef`].
#[cfg(test)]
pub(crate) fn manage_core<R: Runtime>(app: &tauri::App<R>) {
    let host = Arc::new(crate::host::TauriHost::new(app.handle().clone()));
    let core = Core::new(reflect_core::CoreConfig::default(), host).expect("core");
    app.manage(Arc::new(core));
}

#[cfg(test)]
mod graph_ref_tests {
    use serde_json::{Value, json};
    use tauri::WebviewWindow;
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;

    /// A webview whose invokes go to the desktop commands, as `run` routes
    /// every command the core has no row for.
    fn webview() -> WebviewWindow<MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                super::recovery::note_recovery_read,
                super::device::note_read_for_device,
            ])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        super::manage_core(&app);
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview")
    }

    fn invoke(
        webview: &WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<InvokeResponseBody, Value> {
        tauri::test::get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("url"),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    }

    /// A desktop command takes the graph session as an argument Tauri
    /// resolves when the invoke arrives, from the core the app manages. With
    /// no graph open it answers the session's own typed error rather than
    /// failing to resolve.
    #[test]
    fn an_invoked_desktop_command_reads_the_graph_session_from_the_core() {
        let webview = webview();
        for (command, args) in [
            (
                "note_recovery_read",
                json!({ "path": "secure/a.md", "generation": 1 }),
            ),
            (
                "note_read_for_device",
                json!({ "path": "notes/a.md", "generation": 1 }),
            ),
        ] {
            // Generation 1 names a session this core never opened.
            let error = invoke(&webview, command, args).expect_err("no graph is open");
            assert_eq!(error["kind"], "io", "{command}: {error}");
            let message = error["message"].as_str().unwrap_or_default();
            assert!(message.contains("the graph changed"), "{command}: {error}");
        }
    }
}
