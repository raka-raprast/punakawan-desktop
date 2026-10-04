import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { AppState, ExportFormat, FontFamily, ImportedAsset, Preferences, RecoveryEntry } from './model';

function requireDesktop(): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Disk access requires the Punakawan desktop application. Open it with Tauri to use native files.');
  }
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  requireDesktop();
  return invoke<T>(name, args);
}

export function loadAppState(): Promise<AppState> {
  return command('load_app_state');
}

export function readDesign(path: string): Promise<string> {
  return command('read_design', { path });
}

export function writeDesign(path: string, content: string): Promise<void> {
  return command('write_design', { path, content });
}

export function importAsset(path: string): Promise<ImportedAsset> {
  return command('import_asset', { path });
}

export function writeExport(path: string, dataBase64: string): Promise<void> {
  return command('write_export', { path, dataBase64 });
}

export function listFonts(): Promise<FontFamily[]> {
  return command('list_fonts');
}

export function savePreferences(preferences: Preferences): Promise<void> {
  return command('save_preferences', { preferences });
}

export function recordRecent(path: string): Promise<void> {
  return command('record_recent', { path });
}

export function saveRecovery(id: string, content: string): Promise<void> {
  return command('save_recovery', { id, content });
}

export function listRecovery(): Promise<RecoveryEntry[]> {
  return command('list_recovery');
}

export function deleteRecovery(id: string): Promise<void> {
  return command('delete_recovery', { id });
}

export async function pickOpenFile(): Promise<string | null> {
  requireDesktop();
  const selection = await open({ directory: false, multiple: false, filters: [
    { name: 'Punakawan design', extensions: ['punakawan', 'json'] },
  ] });
  return typeof selection === 'string' ? selection : null;
}

export async function pickSaveFile(defaultPath?: string): Promise<string | null> {
  requireDesktop();
  return save({ defaultPath, filters: [
    { name: 'Punakawan design', extensions: ['punakawan'] },
    { name: 'JSON design', extensions: ['json'] },
  ] });
}

export async function pickAsset(): Promise<string | null> {
  requireDesktop();
  const selection = await open({ directory: false, multiple: false, filters: [
    { name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
  ] });
  return typeof selection === 'string' ? selection : null;
}

export async function pickExport(defaultName: string, extension: ExportFormat): Promise<string | null> {
  requireDesktop();
  const defaultPath = defaultName.toLowerCase().endsWith(`.${extension}`) ? defaultName : `${defaultName}.${extension}`;
  return save({ defaultPath, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
}

export async function pickExportFolder(): Promise<string | null> {
  requireDesktop();
  const selection = await open({ directory: true, multiple: false });
  return typeof selection === 'string' ? selection : null;
}
