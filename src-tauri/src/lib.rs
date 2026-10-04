use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager, State};
use tempfile::NamedTempFile;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    Light,
    Dark,
    System,
}

#[derive(Serialize, Deserialize)]
struct Preferences {
    theme: Theme,
    autosave: bool,
    shortcuts: BTreeMap<String, String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            autosave: true,
            shortcuts: BTreeMap::new(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct AppState {
    recent: Vec<String>,
    preferences: Preferences,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAsset {
    name: String,
    mime: String,
    data_url: String,
}

#[derive(Serialize)]
struct RecoveryEntry {
    id: String,
    content: String,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate Punakawan's application data directory: {error}"))
}

fn user_file(path: &str) -> Result<&Path, String> {
    let file = Path::new(path);
    if path.is_empty() || !file.is_absolute() || file.file_name().is_none() {
        return Err("Choose an absolute file path in the native file dialog.".into());
    }
    Ok(file)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine the destination folder for {}.", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!("Cannot create the destination folder {}: {error}", parent.display())
    })?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Cannot replace the symbolic link {}. Choose the original file instead.",
                path.display()
            ));
        }
        if !metadata.is_file() {
            return Err(format!("{} is not a regular file.", path.display()));
        }
    }
    let mut temp = NamedTempFile::new_in(parent).map_err(|error| {
        format!("Cannot create a temporary file in {}: {error}", parent.display())
    })?;
    temp.write_all(contents)
        .and_then(|_| temp.flush())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| format!("Cannot write {}: {error}", path.display()))?;
    temp.persist(path)
        .map_err(|error| format!("Cannot replace {}: {}", path.display(), error.error))?;
    #[cfg(target_os = "linux")]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Cannot sync the folder {}: {error}", parent.display()))?;
    Ok(())
}

fn read_state(app: &AppHandle) -> Result<AppState, String> {
    let path = app_data_dir(app)?.join("state.json");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(AppState::default()),
        Err(error) => return Err(format!("Cannot read settings at {}: {error}", path.display())),
    };
    serde_json::from_str(&content)
        .map_err(|error| format!("Invalid settings at {}: {error}", path.display()))
}

fn write_state(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Cannot encode Punakawan settings: {error}"))?;
    atomic_write(&app_data_dir(app)?.join("state.json"), &content)
}

fn recovery_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let uuid = Uuid::parse_str(id).map_err(|_| "Recovery ID must be a document UUID.".to_string())?;
    Ok(app_data_dir(app)?
        .join("recovery")
        .join(format!("{uuid}.json")))
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack.as_bytes().windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn validate_svg(bytes: &[u8], safe_for_import: bool) -> Result<(), String> {
    let source = std::str::from_utf8(bytes)
        .map_err(|_| "SVG images must be UTF-8 encoded XML.".to_string())?;
    if safe_for_import && (source.contains("<!DOCTYPE") || source.contains("<!ENTITY")) {
        return Err("SVG images with document types or entity declarations cannot be imported.".into());
    }
    let document = roxmltree::Document::parse(source)
        .map_err(|error| format!("Invalid SVG image: {error}"))?;
    let root = document.root_element();
    if root.tag_name().name() != "svg"
        || !matches!(root.tag_name().namespace(), None | Some("http://www.w3.org/2000/svg"))
    {
        return Err("The image is not an SVG document.".into());
    }
    if !safe_for_import {
        return Ok(());
    }
    const FORBIDDEN_ELEMENTS: [&str; 19] = [
        "script", "foreignObject", "iframe", "object", "embed", "image", "feImage", "style",
        "a", "animate", "animateColor", "animateMotion", "animateTransform", "set", "discard",
        "audio", "video", "handler", "listener",
    ];
    for node in document.descendants() {
        if node.is_pi() {
            return Err("SVG processing instructions cannot be imported.".into());
        }
        if !node.is_element() {
            continue;
        }
        if !matches!(node.tag_name().namespace(), None | Some("http://www.w3.org/2000/svg")) {
            return Err("SVG images with non-SVG elements cannot be imported.".into());
        }
        if FORBIDDEN_ELEMENTS.iter().any(|name| node.tag_name().name().eq_ignore_ascii_case(name)) {
            return Err("SVG images containing executable, linked, or embedded content cannot be imported.".into());
        }
        for attribute in node.attributes() {
            let name = attribute.name();
            let value = attribute.value().trim();
            if name.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("on"))
                || name.eq_ignore_ascii_case("style") || name.eq_ignore_ascii_case("base")
                || contains_ascii_case_insensitive(value, "javascript:")
                || contains_ascii_case_insensitive(value, "data:")
                || contains_ascii_case_insensitive(value, "@import")
            {
                return Err(format!("Unsafe SVG attribute '{name}' cannot be imported."));
            }
            if name.eq_ignore_ascii_case("href") {
                let fragment = value.strip_prefix('#').unwrap_or("");
                if fragment.is_empty() || !fragment.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c)) {
                    return Err("SVG references must point to an element within the same image.".into());
                }
            }
            if contains_ascii_case_insensitive(value, "url(") {
                let fragment = value.get(..4)
                    .filter(|prefix| prefix.eq_ignore_ascii_case("url("))
                    .and_then(|_| value.get(4..))
                    .and_then(|rest| rest.strip_suffix(')'))
                    .map(|rest| rest.trim().trim_matches(['\'', '"']).trim())
                    .and_then(|rest| rest.strip_prefix('#'));
                if !fragment.is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))) {
                    return Err("SVG paint URLs must reference an element within the same image.".into());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn load_app_state(app: AppHandle, lock: State<'_, Mutex<()>>) -> Result<AppState, String> {
    let _guard = lock.lock().map_err(|_| "Settings lock is unavailable.".to_string())?;
    read_state(&app)
}

#[tauri::command]
async fn save_preferences(
    app: AppHandle,
    lock: State<'_, Mutex<()>>,
    preferences: Preferences,
) -> Result<(), String> {
    let _guard = lock.lock().map_err(|_| "Settings lock is unavailable.".to_string())?;
    let mut state = read_state(&app)?;
    state.preferences = preferences;
    write_state(&app, &state)
}

#[tauri::command]
async fn record_recent(app: AppHandle, lock: State<'_, Mutex<()>>, path: String) -> Result<(), String> {
    user_file(&path)?;
    let _guard = lock.lock().map_err(|_| "Settings lock is unavailable.".to_string())?;
    let mut state = read_state(&app)?;
    state.recent.retain(|existing| existing != &path);
    state.recent.insert(0, path);
    state.recent.truncate(12);
    write_state(&app, &state)
}

#[tauri::command]
async fn read_design(path: String) -> Result<String, String> {
    let file = user_file(&path)?;
    fs::read_to_string(file).map_err(|error| format!("Cannot open design {}: {error}", file.display()))
}

#[tauri::command]
async fn write_design(path: String, content: String) -> Result<(), String> {
    let file = user_file(&path)?;
    let document: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Cannot save invalid design JSON: {error}"))?;
    if document.get("format").and_then(|v| v.as_str()) != Some("punakawan-design")
        || document.get("version").and_then(|v| v.as_u64()) != Some(1)
        || document.get("id").and_then(|v| v.as_str()).is_none()
        || !document.get("pages").is_some_and(|v| v.as_array().is_some_and(|pages| !pages.is_empty()))
    {
        return Err("Cannot save a file that is not a valid Punakawan design.".into());
    }
    atomic_write(file, content.as_bytes())
}

#[tauri::command]
async fn import_asset(path: String) -> Result<ImportedAsset, String> {
    let file = user_file(&path)?;
    let extension = file.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") {
        return Err("Choose a PNG, JPEG, GIF, WebP, or SVG image.".into());
    }
    let bytes = fs::read(file).map_err(|error| format!("Cannot import {}: {error}", file.display()))?;
    let mime = match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => "image/jpeg",
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => "image/gif",
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) => "image/webp",
        "svg" => {
            validate_svg(&bytes, true)?;
            "image/svg+xml"
        }
        _ => return Err(format!("{} does not contain a valid {} image.", file.display(), extension.to_uppercase())),
    };
    let name = file.file_name().and_then(|s| s.to_str())
        .ok_or_else(|| "The image file name is not valid UTF-8.".to_string())?;
    Ok(ImportedAsset {
        name: name.to_string(),
        mime: mime.to_string(),
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
    })
}

#[tauri::command]
async fn write_export(path: String, data_base64: String) -> Result<(), String> {
    let file = user_file(&path)?;
    let bytes = STANDARD.decode(data_base64.as_bytes())
        .map_err(|error| format!("Cannot decode exported image data: {error}"))?;
    match file.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => {}
        Some("svg") => validate_svg(&bytes, false)?,
        Some("png") => return Err("The exported bytes are not a PNG image.".into()),
        _ => return Err("Export images as a .png or .svg file.".into()),
    }
    atomic_write(file, &bytes)
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

#[derive(Serialize)]
struct FontFace {
    label: String,
    weight: u16,
    style: FontStyle,
}

#[derive(Serialize)]
struct FontFamily {
    family: String,
    styles: Vec<FontFace>,
}

fn font_style_label(weight: u16, style: FontStyle) -> String {
    let suffix = match style {
        FontStyle::Normal => "",
        FontStyle::Italic => " Italic",
        FontStyle::Oblique => " Oblique",
    };
    let weight_label = match weight {
        100 => "Thin",
        200 => "Extra Light",
        300 => "Light",
        400 if style != FontStyle::Normal => return suffix.trim_start().to_owned(),
        400 => "Regular",
        500 => "Medium",
        600 => "Semi Bold",
        700 => "Bold",
        800 => "Extra Bold",
        900 => "Black",
        _ => return format!("Weight {weight}{suffix}"),
    };
    format!("{weight_label}{suffix}")
}

#[tauri::command]
async fn list_fonts() -> Result<Vec<FontFamily>, String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let mut families = BTreeMap::<String, FontFamily>::new();
    for face in database.faces() {
        // fontdb puts the English family first when available; other names are locale aliases.
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        let family = families.entry(name.to_lowercase()).or_insert_with(|| FontFamily {
            family: name.clone(),
            styles: Vec::new(),
        });
        let style = match face.style {
            fontdb::Style::Normal => FontStyle::Normal,
            fontdb::Style::Italic => FontStyle::Italic,
            fontdb::Style::Oblique => FontStyle::Oblique,
        };
        let weight = face.weight.0;
        if !family.styles.iter().any(|entry| entry.weight == weight && entry.style == style) {
            family.styles.push(FontFace {
                label: font_style_label(weight, style),
                weight,
                style,
            });
        }
    }
    if families.is_empty() {
        return Err("No installed system font families could be found.".into());
    }
    Ok(families.into_values().map(|mut family| {
        family.styles.sort_unstable_by_key(|face| (face.weight, face.style));
        family
    }).collect())
}

#[tauri::command]
async fn save_recovery(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let file = recovery_path(&app, &id)?;
    let snapshot: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Cannot store invalid recovery JSON: {error}"))?;
    let document = snapshot.get("document");
    let document_id = document.and_then(|value| value.get("id")).and_then(|value| value.as_str());
    if document_id.and_then(|value| Uuid::parse_str(value).ok()).is_none()
        || document.and_then(|value| value.get("format")).and_then(|value| value.as_str()) != Some("punakawan-design")
        || document.and_then(|value| value.get("version")).and_then(|value| value.as_u64()) != Some(1)
        || !snapshot.get("path").is_some_and(|value| value.is_null() || value.is_string())
        || !snapshot.get("revision").is_some_and(|value| value.as_u64().is_some())
    {
        return Err("Recovery data must contain a design document UUID, path, and revision.".into());
    }
    atomic_write(&file, content.as_bytes())
}

#[tauri::command]
async fn list_recovery(app: AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    let directory = app_data_dir(&app)?.join("recovery");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot list recovery drafts in {}: {error}", directory.display())),
    };
    let mut recovered = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Cannot inspect a recovery draft: {error}"))?;
        let kind = entry.file_type().map_err(|error| format!("Cannot inspect recovery file type: {error}"))?;
        if !kind.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else { continue };
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
        {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Cannot read recovery draft {}: {error}", path.display()))?;
        let modified = entry.metadata().and_then(|metadata| metadata.modified()).unwrap_or(UNIX_EPOCH);
        recovered.push((modified, RecoveryEntry { id: id.to_string(), content }));
    }
    recovered.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    Ok(recovered.into_iter().map(|(_, entry)| entry).collect())
}

#[tauri::command]
async fn delete_recovery(app: AppHandle, id: String) -> Result<(), String> {
    let file = recovery_path(&app, &id)?;
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot discard recovery draft {}: {error}", file.display())),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(()))
        .invoke_handler(tauri::generate_handler![
            load_app_state,
            read_design,
            write_design,
            import_asset,
            write_export,
            list_fonts,
            save_preferences,
            record_recent,
            save_recovery,
            list_recovery,
            delete_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("Punakawan could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_a_design_file_leaves_only_the_complete_new_content() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("design.punakawan");
        atomic_write(&file, b"original document").unwrap();
        atomic_write(&file, b"replacement document with more content").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"replacement document with more content");
    }

    #[test]
    fn imported_svg_cannot_load_external_content_or_execute_scripts() {
        assert!(validate_svg(br#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>"#, true).is_ok());
        assert!(validate_svg(br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#, true).is_err());
        assert!(validate_svg(br#"<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/payload.svg#icon"/></svg>"#, true).is_err());
    }
    #[test]
    fn importing_an_image_embeds_its_bytes_and_exporting_preserves_them() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png");
        let asset = tauri::async_runtime::block_on(import_asset(source.to_string_lossy().into_owned())).unwrap();
        assert_eq!(asset.mime, "image/png");
        let encoded = asset.data_url.strip_prefix("data:image/png;base64,").unwrap();
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("export.png");
        tauri::async_runtime::block_on(write_export(target.to_string_lossy().into_owned(), encoded.to_string())).unwrap();
        assert_eq!(fs::read(target).unwrap(), fs::read(source).unwrap());
    }

}
