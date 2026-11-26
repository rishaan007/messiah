use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use keyring::Entry;
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const MAX_LOG_LINES: usize = 200;
const KEYRING_SERVICE: &str = "com.messiah.desktop";

const ALLOWED_DEEP_LINK_PREFIXES: &[&str] = &[
    "/",
    "/chat",
    "/agents",
    "/swarms",
    "/memory",
    "/workflows",
    "/approvals",
    "/audit",
    "/settings",
];

struct BridgeManagerState {
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl Default for BridgeManagerState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            last_error: Mutex::new(None),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatusResponse {
    running: bool,
    pid: Option<u32>,
    last_error: Option<String>,
    cli_available: bool,
    bridge_entry_path: Option<String>,
    autostart_enabled: bool,
    platform: String,
    arch: String,
    app_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResponse {
    available: bool,
    current_version: String,
    latest_version: Option<String>,
    notes: Option<String>,
    signed_manifest_verified: bool,
    error: Option<String>,
}

fn push_bounded_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let redacted = redact_sensitive_text(&line);
    if let Ok(mut guard) = logs.lock() {
        if guard.len() >= MAX_LOG_LINES {
            guard.pop_front();
        }
        guard.push_back(redacted);
    }
}

fn redact_sensitive_text(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    if lower.contains("sk-")
        || lower.contains("bearer ")
        || lower.contains("password")
        || lower.contains("msh_")
        || lower.contains("private key")
    {
        return "[REDACTED_SENSITIVE_BRIDGE_LINE]".to_string();
    }
    input.to_string()
}

pub fn validate_deep_link(raw_uri: &str) -> Option<String> {
    let trimmed = raw_uri.trim();
    if !trimmed.starts_with("messiah://") {
        return None;
    }
    let rel = format!("/{}", trimmed["messiah://".len()..].trim_start_matches('/'));
    if rel.contains("..") || rel.contains('\\') || rel.contains('\0') || rel.contains('\r') || rel.contains('\n') {
        return None;
    }
    let fake_base = Url::parse("https://messiah.local").ok()?;
    let joined = fake_base.join(&rel).ok()?;
    if joined.host_str() != Some("messiah.local") {
        return None;
    }
    let path = joined.path();
    let allowed = ALLOWED_DEEP_LINK_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    if !allowed {
        return None;
    }
    Some(match joined.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.to_string(),
    })
}

fn resolve_bridge_cli_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("MESSIAH_BRIDGE_CLI_PATH") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("bridge-daemon").join("index.js");
        if bundled.exists() {
            return Some(bundled);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(4) {
            let candidate = ancestor
                .join("apps")
                .join("bridge-daemon")
                .join("dist")
                .join("cli")
                .join("index.js");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_node_binary() -> String {
    for candidate in &[
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        if Path::new(candidate).exists() {
            return (*candidate).to_string();
        }
    }
    "node".to_string()
}

fn check_child_alive(state: &BridgeManagerState) -> (bool, Option<u32>) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(ref mut ch) = *guard {
            match ch.try_wait() {
                Ok(None) => return (true, Some(ch.id())),
                Ok(Some(_)) | Err(_) => {
                    *guard = None;
                }
            }
        }
    }
    (false, None)
}

#[tauri::command]
fn messiah_desktop_status(
    app: AppHandle,
    state: tauri::State<'_, BridgeManagerState>,
) -> DesktopStatusResponse {
    let (running, pid) = check_child_alive(&state);
    let cli_entry = resolve_bridge_cli_entry(&app);
    let last_error = state.last_error.lock().ok().and_then(|g| g.clone());
    let autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(false);

    DesktopStatusResponse {
        running,
        pid,
        last_error,
        cli_available: cli_entry.is_some(),
        bridge_entry_path: cli_entry.map(|p| p.to_string_lossy().to_string()),
        autostart_enabled,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn messiah_bridge_logs(state: tauri::State<'_, BridgeManagerState>) -> Vec<String> {
    state
        .logs
        .lock()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
fn messiah_bridge_start(
    app: AppHandle,
    state: tauri::State<'_, BridgeManagerState>,
) -> Result<(), String> {
    let (alive, _) = check_child_alive(&state);
    if alive {
        return Ok(());
    }

    let cli_entry = resolve_bridge_cli_entry(&app)
        .ok_or_else(|| "Bridge CLI entry (@messiah/bridge-daemon/dist/cli/index.js) not found.".to_string())?;

    let node_bin = resolve_node_binary();
    let mut child = Command::new(&node_bin)
        .arg(&cli_entry)
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed spawning Bridge daemon: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let logs = Arc::clone(&state.logs);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                push_bounded_log(&logs, format!("[bridge] {line}"));
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let logs = Arc::clone(&state.logs);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                push_bounded_log(&logs, format!("[bridge:err] {line}"));
            }
        });
    }

    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    if let Ok(mut err_guard) = state.last_error.lock() {
        *err_guard = None;
    }
    push_bounded_log(&state.logs, "[desktop] Local Agent Bridge process started.".to_string());
    Ok(())
}

#[tauri::command]
fn messiah_bridge_stop(state: tauri::State<'_, BridgeManagerState>) -> Result<(), String> {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            push_bounded_log(&state.logs, "[desktop] Local Agent Bridge stopped cleanly.".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn messiah_set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    mgr.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn messiah_pick_workspace_directory(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Select Project Folder (Authorize explicitly in Device Policy)")
        .blocking_pick_folder()
        .map(|fp| fp.to_string())
}

#[tauri::command]
fn messiah_send_desktop_notification(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    let safe_title: String = title.chars().take(120).collect();
    let safe_body: String = redact_sensitive_text(&body).chars().take(240).collect();
    app.notification()
        .builder()
        .title(safe_title)
        .body(safe_body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn messiah_store_keychain_preference(key: String, value: String) -> Result<(), String> {
    // Allow strictly validated non-secret preference slots; never store raw LLM/service credentials from UI
    if !matches!(key.as_str(), "workspace_id" | "server_origin" | "device_label") {
        return Err("DISALLOWED_KEYCHAIN_SLOT: arbitrary frontend secret storage is blocked.".to_string());
    }
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn messiah_read_keychain_preference(key: String) -> Result<Option<String>, String> {
    if !matches!(key.as_str(), "workspace_id" | "server_origin" | "device_label") {
        return Err("DISALLOWED_KEYCHAIN_SLOT".to_string());
    }
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn messiah_check_for_updates(app: AppHandle) -> UpdateCheckResponse {
    let current_version = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateCheckResponse {
                available: false,
                current_version,
                latest_version: None,
                notes: None,
                signed_manifest_verified: false,
                error: Some(format!("Updater unavailable: {e}")),
            };
        }
    };

    match updater.check().await {
        Ok(Some(update)) => UpdateCheckResponse {
            available: true,
            current_version,
            latest_version: Some(update.version.clone()),
            notes: update.body.clone(),
            signed_manifest_verified: true,
            error: None,
        },
        Ok(None) => UpdateCheckResponse {
            available: false,
            current_version,
            latest_version: None,
            notes: None,
            signed_manifest_verified: true,
            error: None,
        },
        Err(e) => UpdateCheckResponse {
            available: false,
            current_version,
            latest_version: None,
            notes: None,
            signed_manifest_verified: false,
            error: Some(format!("Signed update check failed cleanly: {e}")),
        },
    }
}

fn dispatch_deep_link_to_window(app: &AppHandle, raw_uri: &str) {
    if let Some(safe_path) = validate_deep_link(raw_uri) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
            let serialized = serde_json::to_string(&safe_path).unwrap_or_else(|_| "\"/\"".to_string());
            let _ = win.eval(format!(
                "window.dispatchEvent(new CustomEvent('messiah:deep-link', {{ detail: {{ url: {serialized} }} }}));"
            ));
        }
        let _ = app.emit("messiah-deep-link", safe_path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BridgeManagerState::default())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            messiah_desktop_status,
            messiah_bridge_logs,
            messiah_bridge_start,
            messiah_bridge_stop,
            messiah_set_autostart,
            messiah_pick_workspace_directory,
            messiah_send_desktop_notification,
            messiah_store_keychain_preference,
            messiah_read_keychain_preference,
            messiah_check_for_updates,
        ])
        .setup(|app| {
            // Tray menu & minimize-to-tray behavior
            let show_i = MenuItem::with_id(app, "show", "Open MESSIAH", true, None::<&str>)?;
            let approvals_i = MenuItem::with_id(app, "approvals", "Approval Queue", true, None::<&str>)?;
            let devices_i = MenuItem::with_id(app, "devices", "Local Bridges & Devices", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit MESSIAH", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &approvals_i, &devices_i, &quit_i])?;

            if let Some(icon) = app.default_window_icon() {
                TrayIconBuilder::with_id("messiah-tray")
                    .icon(icon.clone())
                    .menu(&menu)
                    .tooltip("MESSIAH — One intelligence layer. Every agent. Every device.")
                    .on_menu_event(|app_handle, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app_handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "approvals" => dispatch_deep_link_to_window(app_handle, "messiah://approvals"),
                        "devices" => dispatch_deep_link_to_window(app_handle, "messiah://settings/devices"),
                        "quit" => {
                            if let Some(state) = app_handle.try_state::<BridgeManagerState>() {
                                if let Ok(mut g) = state.child.lock() {
                                    if let Some(mut c) = g.take() {
                                        let _ = c.kill();
                                        let _ = c.wait();
                                    }
                                }
                            }
                            app_handle.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // Deep link listener (`messiah://...`)
            let handle_for_dl = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    dispatch_deep_link_to_window(&handle_for_dl, url.as_str());
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray instead of terminating active sessions/daemon unexpectedly
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MESSIAH desktop application");
}

#[cfg(test)]
mod tests {
    use super::validate_deep_link;

    #[test]
    fn accepts_valid_allowlisted_deep_links() {
        assert_eq!(
            validate_deep_link("messiah://approvals?id=123"),
            Some("/approvals?id=123".to_string())
        );
        assert_eq!(
            validate_deep_link("messiah://workflows/runs/run-1"),
            Some("/workflows/runs/run-1".to_string())
        );
    }

    #[test]
    fn rejects_traversal_external_schemes_and_unlisted_routes() {
        assert_eq!(validate_deep_link("https://evil.com/approvals"), None);
        assert_eq!(validate_deep_link("messiah://approvals/../../etc/passwd"), None);
        assert_eq!(validate_deep_link("messiah://unknown/admin/shell"), None);
        assert_eq!(validate_deep_link("messiah://chat\\..\\secret"), None);
    }
}
