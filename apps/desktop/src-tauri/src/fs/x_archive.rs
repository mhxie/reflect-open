use super::x_archive_store as archive;
use super::GraphState;
use crate::error::{AppError, AppResult};
use reflect_graph_paths::LocalOnlyFolders;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

async fn blocking<T: Send + 'static>(
    root: PathBuf,
    action: impl FnOnce(PathBuf) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(move || action(root))
        .await
        .map_err(|error| AppError::io(error.to_string()))?
}

fn download_media<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: PathBuf,
    local_only: Option<Arc<LocalOnlyFolders>>,
    generation: u64,
    urls: Vec<String>,
) {
    for url in urls {
        let app = app.clone();
        let root = root.clone();
        let local_only = local_only.clone();
        tauri::async_runtime::spawn(async move {
            match super::x_download::download(root, local_only, url).await {
                Ok(receipt) => {
                    if super::root_for_generation(&app.state::<GraphState>(), generation).is_ok() {
                        let _ = app.emit("index:changed", json!([{ "path": format!("assets/x/{}", receipt.name), "kind": "upsert" }]));
                    }
                }

                Err(error) => tracing::warn!(?error, "X media download failed"),
            }
        });
    }
}

#[tauri::command]
pub async fn x_archive_write<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    value: Value,
) -> AppResult<()> {
    let (root, local_only) = super::graph_for(&app.state::<GraphState>(), Some(generation))?;
    let saved = value;
    let folders = local_only.clone();
    let saved = blocking(root.clone(), move |root| {
        let view = archive::post_view(&saved)?;
        let id = &view.data.id;
        archive::atomic_json(
            &root,
            &format!("assets/x/post-{id}.json"),
            &saved,
            folders.as_deref(),
        )?;
        Ok(saved)
    })
    .await?;
    download_media(
        app,
        root,
        local_only,
        generation,
        archive::media_urls(&saved)?,
    );
    Ok(())
}

#[tauri::command]
pub async fn x_archive_resolve<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    post_id: String,
) -> AppResult<Option<Value>> {
    let (root, local_only) = super::graph_for(&app.state::<GraphState>(), Some(generation))?;
    let post = blocking(root.clone(), move |root| {
        archive::read_post(&root, &post_id)
    })
    .await?;
    let Some(post) = post else {
        return Ok(None);
    };
    let urls = archive::media_urls(&post)?;
    let resources: Vec<_> = urls
        .iter()
        .filter_map(|url| {
            archive::hash_url(url)
                .ok()
                .map(|hash| json!({"url": url, "hash": hash}))
        })
        .collect();
    // Archives synced from another device also resume missing downloads when opened.
    // Resolution has no durable job state and never rewrites the post JSON.
    download_media(app, root, local_only, generation, urls);
    Ok(Some(json!({"archive": post, "resources": resources})))
}

#[tauri::command]

pub async fn x_archive_owners(
    state: State<'_, GraphState>,
    asset_path: String,
    generation: Option<u64>,
) -> AppResult<Vec<String>> {
    let root = match generation {
        Some(generation) => super::root_for_generation(&state, generation)?,
        None => super::current_root(&state)?,
    };
    blocking(root, move |root| {
        if !asset_path.starts_with("assets/x/") {
            return Ok(vec![]);
        }
        let directory = super::resolve::resolve(&root, "assets/x")?;
        let mut owners = Vec::new();
        if !directory.is_dir() {
            return Ok(owners);
        }
        // The synced JSON is authoritative. Device-local download state would miss
        // owners captured on another device and break private-note classification.
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some(id) = name
                .strip_prefix("post-")
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            if !archive::valid_id(id) {
                continue;
            }
            let Some(post) = archive::read_post(&root, id)? else {
                continue;
            };
            if archive::media_urls(&post)?.iter().any(|url| {
                archive::hash_url(url)
                    .ok()
                    .and_then(|hash| archive::get_candidate_names(&hash).ok())
                    .is_some_and(|names| {
                        names
                            .iter()
                            .any(|name| format!("assets/x/{name}") == asset_path)
                    })
            }) {
                owners.push(format!("assets/x/{name}"));
            }
        }
        Ok(owners)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Command tier: `x_archive_write` takes the folders from the open
    /// graph, so a post never lands in a real local-only folder through an
    /// aliased `assets/`; the control session without folders writes it.
    #[cfg(unix)]
    #[test]
    fn the_write_command_takes_the_folders_from_the_open_graph() {
        for configured in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            std::fs::create_dir_all(root.join("people/secure")).unwrap();
            std::os::unix::fs::symlink(root.join("people/secure"), root.join("assets")).unwrap();
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock app");
            app.manage(GraphState::default());
            {
                let state = app.state::<GraphState>();
                let mut inner = state.0.lock().unwrap();
                inner.generation = 1;
                inner.root = Some(root.clone());
                inner.set_local_only(if configured {
                    LocalOnlyFolders::new(["secure"], None)
                } else {
                    None
                });
            }
            // No media, so nothing is downloaded either way.
            let written = tauri::async_runtime::block_on(x_archive_write(
                app.handle().clone(),
                1,
                json!({ "data": { "id": "123" } }),
            ));
            assert_eq!(written.is_ok(), !configured, "{written:?}");
            assert_eq!(
                root.join("people/secure/x/post-123.json").exists(),
                !configured
            );
        }
    }
}
