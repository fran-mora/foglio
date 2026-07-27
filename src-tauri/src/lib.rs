use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::OnceCell;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

// Debug logging is off unless the app is launched with MD_DEBUG set, e.g.
// `MD_DEBUG=1 ./Foglio.app/Contents/MacOS/foglio`. Writes to $TMPDIR/foglio-debug.log.
static DEBUG: OnceCell<bool> = OnceCell::new();

fn log(msg: &str) {
    if !*DEBUG.get_or_init(|| std::env::var_os("MD_DEBUG").is_some()) {
        return;
    }
    let path = std::env::temp_dir().join("foglio-debug.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

// --- per-window registry -----------------------------------------------------
// Each open window reports what file it shows and whether it has unsaved
// edits. This drives open-in-existing-window focusing, vacant-window reuse,
// and the quit-with-unsaved-changes guard.

#[derive(Default)]
struct WinInfo {
    path: Option<String>,
    dirty: bool,
}

static REGISTRY: OnceCell<Mutex<HashMap<String, WinInfo>>> = OnceCell::new();

fn registry() -> &'static Mutex<HashMap<String, WinInfo>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

// Files assigned to freshly created windows before their JS has booted.
// The window's frontend collects its file via `initial_file`.
static ASSIGNED: OnceCell<Mutex<HashMap<String, String>>> = OnceCell::new();

fn assigned() -> &'static Mutex<HashMap<String, String>> {
    ASSIGNED.get_or_init(|| Mutex::new(HashMap::new()))
}

// Cold-start slot for the config-created "main" window: the OS may deliver an
// "open file" event before any webview is ready.
static PENDING_FILE: OnceCell<Mutex<Option<String>>> = OnceCell::new();

fn pending() -> &'static Mutex<Option<String>> {
    PENDING_FILE.get_or_init(|| Mutex::new(None))
}

fn set_pending(path: String) {
    if let Ok(mut guard) = pending().lock() {
        *guard = Some(path);
    }
}

fn take_pending() -> Option<String> {
    pending().lock().ok().and_then(|mut g| g.take())
}

static NEXT_WIN: AtomicU32 = AtomicU32::new(1);
static QUIT_PENDING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn initial_file(window: tauri::WebviewWindow) -> Option<String> {
    let label = window.label().to_string();
    let p = assigned()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&label))
        .or_else(|| if label == "main" { take_pending() } else { None });
    log(&format!("initial_file({}) -> {:?}", label, p));
    p
}

#[tauri::command]
fn register_window(window: tauri::WebviewWindow) {
    if let Ok(mut reg) = registry().lock() {
        reg.entry(window.label().to_string()).or_default();
    }
}

#[tauri::command]
fn register_path(window: tauri::WebviewWindow, path: String) {
    if let Ok(mut reg) = registry().lock() {
        reg.entry(window.label().to_string()).or_default().path = Some(path);
    }
}

#[tauri::command]
fn set_dirty(window: tauri::WebviewWindow, dirty: bool) {
    if let Ok(mut reg) = registry().lock() {
        reg.entry(window.label().to_string()).or_default().dirty = dirty;
    }
}

#[tauri::command]
fn cancel_quit() {
    QUIT_PENDING.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn new_window(app: AppHandle) {
    create_doc_window(&app, None);
}

// Route a picked file: focus the window that already shows it, reuse an
// empty window, or open a new one.
#[tauri::command]
fn deliver_path(app: AppHandle, path: String) {
    deliver(&app, PathBuf::from(path));
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("read_text_file({}) failed: {}", path, e);
        log(&msg);
        msg
    })
}

// Writes through a temporary file in the same directory and renames it into
// place. A plain write truncates first, so a full disk or a crash midway would
// leave the previous contents destroyed and the new ones incomplete. The
// watcher survives this because it watches the parent directory by name rather
// than holding the file itself.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let name = target
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?
        .to_string_lossy()
        .to_string();

    let fail = |e: std::io::Error, stage: &str| {
        let msg = format!("write_text_file({}) failed at {}: {}", path, stage, e);
        log(&msg);
        msg
    };

    let tmp = dir.join(format!(".{}.foglio-tmp", name));
    std::fs::write(&tmp, content).map_err(|e| fail(e, "write"))?;

    // Keep whatever permissions the file already had; a fresh temp file would
    // otherwise hand it the default mode.
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }

    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        fail(e, "rename")
    })
}

#[tauri::command]
fn js_log(msg: String) {
    log(&format!("js: {}", msg));
}

// --- file watchers -----------------------------------------------------------
// One watcher per watched file path. Watch events are emitted app-wide with
// the path as payload; each window filters by its own current file.

static WATCHERS: OnceCell<Mutex<HashMap<String, RecommendedWatcher>>> = OnceCell::new();

fn watchers() -> &'static Mutex<HashMap<String, RecommendedWatcher>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn watch_file(app: AppHandle, path: String) -> Result<(), String> {
    {
        let map = watchers().lock().map_err(|e| e.to_string())?;
        if map.contains_key(&path) {
            return Ok(());
        }
    }

    let p = PathBuf::from(&path);
    let parent = p
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?
        .to_path_buf();
    let target: OsString = p
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?
        .to_os_string();

    let app_handle = app.clone();
    let path_clone = path.clone();

    // Watch the parent dir non-recursive and filter by filename. This catches
    // atomic-rename saves (Dropbox, TextEdit-style) where the file itself is
    // briefly replaced — a direct watch on the file path would be invalidated.
    let mut new_watcher = notify::recommended_watcher(
        move |res: Result<Event, notify::Error>| match res {
            Ok(event) => {
                let touches_target = event
                    .paths
                    .iter()
                    .any(|ep| ep.file_name() == Some(target.as_os_str()));
                if !touches_target {
                    return;
                }
                match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) => {
                        log(&format!("watcher: changed {}", path_clone));
                        let _ = app_handle.emit("file-changed", &path_clone);
                    }
                    EventKind::Remove(_) => {
                        log(&format!("watcher: removed {}", path_clone));
                        let _ = app_handle.emit("file-removed", &path_clone);
                    }
                    _ => {}
                }
            }
            Err(e) => log(&format!("watcher error: {:?}", e)),
        },
    )
    .map_err(|e| format!("watcher init: {}", e))?;

    new_watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch start: {}", e))?;

    watchers()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(path.clone(), new_watcher);
    log(&format!("watching: {}", path));
    Ok(())
}

#[tauri::command]
fn unwatch_file(path: String) -> Result<(), String> {
    drop_watcher_if_unused(&path);
    Ok(())
}

fn drop_watcher_if_unused(path: &str) {
    let still_used = registry()
        .lock()
        .map(|r| r.values().any(|i| i.path.as_deref() == Some(path)))
        .unwrap_or(true);
    if !still_used {
        if let Ok(mut map) = watchers().lock() {
            if map.remove(path).is_some() {
                log(&format!("unwatched: {}", path));
            }
        }
    }
}

// Writes a rendered-HTML document to a temp file and opens it with the system
// handler (default browser on macOS). WKWebView doesn't surface window.print()
// to the user, so we hand off to the browser where ⌘P → Save as PDF works.
// Reduces a document name to something safe to place in a temp path. Anything
// that isn't alphanumeric, dash, underscore or dot becomes an underscore, so a
// name can't walk out of the temp directory or invent a nested path.
fn safe_export_name(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() || safe.chars().all(|c| c == '.') {
        "untitled".to_string()
    } else {
        safe
    }
}

#[tauri::command]
fn export_html(html: String, name: String) -> Result<String, String> {
    let safe = safe_export_name(&name);
    let mut path = std::env::temp_dir();
    path.push(format!("md-export-{}.html", safe));
    std::fs::write(&path, &html).map_err(|e| {
        let msg = format!("export_html write failed: {}", e);
        log(&msg);
        msg
    })?;
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| {
            let msg = format!("export_html open failed: {}", e);
            log(&msg);
            msg
        })?;
    log(&format!("export_html: {}", path.display()));
    Ok(path.to_string_lossy().to_string())
}

// --- menu bar ----------------------------------------------------------------
// Items with an id emit a "menu" event to the focused window; the frontend
// runs the matching editor command. Undo/redo/select-all are custom rather
// than predefined so they drive CodeMirror's own history instead of the
// webview's, which doesn't know about the editor's state.

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Foglio",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Foglio"), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new_window", "New Window", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, "save_as", "Save As…", true, Some("Shift+CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "export_pdf", "Export as PDF…", true, Some("CmdOrCtrl+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "redo", "Redo", true, Some("Shift+CmdOrCtrl+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(app, "select_all", "Select All", true, Some("CmdOrCtrl+A"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    log(&format!("menu event: {}", id));
    if id == "new_window" {
        create_doc_window(app, None);
        return;
    }
    let focused = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label);
    if let Some(label) = focused {
        let _ = app.emit_to(label.as_str(), "menu", id);
    }
}

// --- window management -------------------------------------------------------

fn create_doc_window(app: &AppHandle, path: Option<String>) {
    let n = NEXT_WIN.fetch_add(1, Ordering::SeqCst);
    let label = format!("doc-{}", n);
    if let Some(p) = &path {
        if let Ok(mut m) = assigned().lock() {
            m.insert(label.clone(), p.clone());
        }
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Foglio")
    .inner_size(900.0, 700.0)
    .min_inner_size(480.0, 360.0);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    // Cascade below-right of the focused window so new windows don't stack
    // exactly on top of each other.
    if let Some(focused) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
    {
        if let (Ok(pos), Ok(scale)) = (focused.outer_position(), focused.scale_factor()) {
            let logical = pos.to_logical::<f64>(scale);
            builder = builder.position(logical.x + 28.0, logical.y + 28.0);
        }
    }

    match builder.build() {
        Ok(_) => log(&format!("created window {} for {:?}", label, path)),
        Err(e) => log(&format!("create window {} failed: {}", label, e)),
    }
}

fn deliver(app: &AppHandle, path: PathBuf) {
    let s = path.to_string_lossy().to_string();
    log(&format!("deliver: {}", s));

    let mut open_in: Option<String> = None;
    let mut vacant: Option<String> = None;
    let mut any_registered = false;
    if let Ok(reg) = registry().lock() {
        for (label, info) in reg.iter() {
            any_registered = true;
            if info.path.as_deref() == Some(s.as_str()) {
                open_in = Some(label.clone());
                break;
            }
            if vacant.is_none() && info.path.is_none() && !info.dirty {
                vacant = Some(label.clone());
            }
        }
    }

    // Already open somewhere → just focus that window.
    if let Some(label) = open_in {
        log(&format!("deliver: already open in {}, focusing", label));
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_focus();
        }
        return;
    }

    // An empty untitled window with no edits can take the file.
    if let Some(label) = vacant {
        log(&format!("deliver: reusing vacant window {}", label));
        let _ = app.emit_to(label.as_str(), "open-file", &s);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_focus();
        }
        return;
    }

    // Cold start: no webview has booted yet — stash for the config-created
    // main window, which asks via `initial_file` (and also listens for the
    // event in case it's already up).
    let pending_free = pending().lock().map(|g| g.is_none()).unwrap_or(false);
    if !any_registered && pending_free {
        set_pending(s.clone());
        let _ = app.emit("open-file", &s);
        return;
    }

    create_doc_window(app, Some(s));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(build_menu)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            initial_file,
            register_window,
            register_path,
            set_dirty,
            cancel_quit,
            new_window,
            deliver_path,
            read_text_file,
            write_text_file,
            js_log,
            watch_file,
            unwatch_file,
            export_html
        ])
        .setup(|_app| {
            log(&format!("setup: argv = {:?}", std::env::args().collect::<Vec<_>>()));
            let mut args = std::env::args().skip(1);
            if let Some(arg) = args.next() {
                let p = PathBuf::from(&arg);
                if p.exists() {
                    log(&format!("setup: argv path exists, stashing {}", p.display()));
                    set_pending(p.to_string_lossy().to_string());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Opened { urls } => {
                log(&format!("RunEvent::Opened fired with {} urls", urls.len()));
                for url in urls {
                    log(&format!("  url: {}", url));
                    match url.to_file_path() {
                        Ok(p) => deliver(app, p),
                        Err(_) => log(&format!("  could not convert {} to file path", url)),
                    }
                }
            }
            // ⌘Q (or last-window close). If any window holds unsaved edits,
            // veto the exit and ask each window to close itself instead —
            // dirty ones prompt the user. When the last window is destroyed
            // while a quit is pending, the app exits below.
            RunEvent::ExitRequested { api, .. } => {
                let any_dirty = registry()
                    .lock()
                    .map(|r| r.values().any(|i| i.dirty))
                    .unwrap_or(false);
                if any_dirty {
                    log("exit requested with dirty windows — intercepting");
                    api.prevent_exit();
                    QUIT_PENDING.store(true, Ordering::SeqCst);
                    let _ = app.emit("request-close", ());
                }
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => {
                log(&format!("window destroyed: {}", label));
                let closed_path = registry()
                    .lock()
                    .ok()
                    .and_then(|mut r| r.remove(&label))
                    .and_then(|i| i.path);
                if let Some(p) = closed_path {
                    drop_watcher_if_unused(&p);
                }
                let none_left = registry().lock().map(|r| r.is_empty()).unwrap_or(true);
                if none_left && QUIT_PENDING.load(Ordering::SeqCst) {
                    log("quit pending and no windows left — exiting");
                    app.exit(0);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{safe_export_name, write_text_file};

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("foglio-test-{}-{}.md", std::process::id(), tag))
    }

    #[test]
    fn writes_a_new_file() {
        let p = temp_path("new");
        let _ = std::fs::remove_file(&p);
        write_text_file(p.to_string_lossy().to_string(), "hello".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn replaces_existing_content_and_leaves_no_temp_file() {
        let p = temp_path("replace");
        std::fs::write(&p, "old contents that are longer").unwrap();
        write_text_file(p.to_string_lossy().to_string(), "new".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new");

        // The write goes via a dotfile in the same directory; it must be gone.
        let dir = p.parent().unwrap();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let tmp = dir.join(format!(".{}.foglio-tmp", name));
        assert!(!tmp.exists(), "temp file left behind at {:?}", tmp);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn keeps_the_original_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let p = temp_path("perms");
        std::fs::write(&p, "x").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_text_file(p.to_string_lossy().to_string(), "y".into()).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "permissions were not carried over");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn reports_an_error_rather_than_panicking_on_a_bad_path() {
        assert!(write_text_file("/".into(), "x".into()).is_err());
    }

    #[test]
    fn keeps_ordinary_names_intact() {
        assert_eq!(safe_export_name("field-notes"), "field-notes");
        assert_eq!(safe_export_name("Report_v2.final"), "Report_v2.final");
    }

    #[test]
    fn strips_path_separators() {
        // A name is pasted into a temp path, so it must not be able to point
        // anywhere else.
        assert_eq!(safe_export_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_export_name("/absolute/path"), "_absolute_path");
        assert!(!safe_export_name("a/b").contains('/'));
    }

    #[test]
    fn replaces_shell_and_space_characters() {
        assert_eq!(safe_export_name("my notes"), "my_notes");
        assert_eq!(safe_export_name("a;rm -rf b"), "a_rm_-rf_b");
        assert_eq!(safe_export_name("$(whoami)"), "__whoami_");
    }

    #[test]
    fn falls_back_when_nothing_usable_remains() {
        assert_eq!(safe_export_name(""), "untitled");
        assert_eq!(safe_export_name("///"), "___");
        assert_eq!(safe_export_name("."), "untitled");
        assert_eq!(safe_export_name(".."), "untitled");
    }

    #[test]
    fn keeps_unicode_letters() {
        assert_eq!(safe_export_name("relazione-tecnica"), "relazione-tecnica");
        assert_eq!(safe_export_name("città"), "città");
    }
}
