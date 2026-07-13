// Prevents an extra console window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::webview::DownloadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const KEYRING_SERVICE: &str = "dev.p2file.desktop";

#[derive(Clone)]
struct DownloadDirState(Arc<Mutex<Option<PathBuf>>>);

#[derive(Serialize, Deserialize)]
struct StoredCredentials {
    username: String,
    password: String,
}

/// One keyring entry per server URL, so switching servers doesn't clobber a
/// previously saved login — each "account" in the OS keychain is keyed by
/// the server address itself.
fn credential_entry(server: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, server).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_credentials(server: String, username: String, password: String) -> Result<(), String> {
    let entry = credential_entry(&server)?;
    let payload = serde_json::to_string(&StoredCredentials { username, password })
        .map_err(|e| e.to_string())?;
    entry.set_password(&payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_credentials(server: String) -> Result<Option<StoredCredentials>, String> {
    let entry = credential_entry(&server)?;
    match entry.get_password() {
        Ok(payload) => serde_json::from_str(&payload)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_credentials(server: String) -> Result<(), String> {
    let entry = credential_entry(&server)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn default_downloads_dir() -> Option<String> {
    dirs::download_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Mirrors the Settings screen's chosen folder into the shared state the
/// `on_download` handler below reads from — called once at startup (with
/// whatever was persisted last) and again every time the user changes it.
#[tauri::command]
fn set_download_dir(path: Option<String>, state: tauri::State<DownloadDirState>) {
    let mut guard = state.0.lock().expect("download dir mutex poisoned");
    *guard = path.map(PathBuf::from);
}

fn main() {
    let download_dir = DownloadDirState(Arc::new(Mutex::new(dirs::download_dir())));
    let on_download_state = download_dir.0.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(download_dir)
        .invoke_handler(tauri::generate_handler![
            save_credentials,
            load_credentials,
            clear_credentials,
            default_downloads_dir,
            set_download_dir
        ])
        .setup(move |app| {
            let on_download_state = on_download_state.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("P2File")
                .inner_size(1080.0, 720.0)
                .min_inner_size(720.0, 480.0)
                // Real WebTorrent P2P transfers run in this webview (see
                // src/lib/webtorrent.ts) exactly like the browser client;
                // finished downloads surface as a normal browser "download"
                // (via WebTorrent's own service worker, or a File System
                // Access / Blob fallback) — this hook is what redirects
                // that into the user's configured default download folder
                // instead of the OS's own Downloads dir / a Save As prompt.
                .on_download(move |_webview, event| match event {
                    DownloadEvent::Requested { destination, .. } => {
                        let dir = on_download_state
                            .lock()
                            .expect("download dir mutex poisoned")
                            .clone();
                        if let Some(dir) = dir {
                            if let Some(name) = destination.file_name().map(|n| n.to_owned()) {
                                *destination = dir.join(name);
                            }
                        }
                        true
                    }
                    _ => true,
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the P2File desktop application");
}
