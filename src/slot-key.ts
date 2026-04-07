/**
 * Slot key utilities for concurrent model sessions.
 *
 * A "slot" is one model session for a chat. The default slot key is the bare
 * chatJid; alias slots use "chatJid@@modelKey". On the filesystem, IPC
 * directories use "--" as the separator (colons are not valid in paths).
 */

const SLOT_SEP = '@@';

/** Build a slot key from chatJid and optional modelKey. */
export function makeSlotKey(chatJid: string, modelKey?: string): string {
  return modelKey ? `${chatJid}${SLOT_SEP}${modelKey}` : chatJid;
}

/** Parse a slot key into chatJid and optional modelKey. */
export function parseSlotKey(slotKey: string): { chatJid: string; modelKey?: string } {
  const idx = slotKey.indexOf(SLOT_SEP);
  if (idx === -1) return { chatJid: slotKey };
  return {
    chatJid: slotKey.slice(0, idx),
    modelKey: slotKey.slice(idx + SLOT_SEP.length),
  };
}

/**
 * IPC directory name under data/ipc/ for a slot.
 * Default slot: just groupFolder. Alias slot: "groupFolder--modelKey".
 * Double-hyphen is used so parseIpcFolderName can unambiguously split the name
 * (single hyphens are common in group folder names).
 */
export function ipcFolderName(groupFolder: string, modelKey?: string): string {
  return modelKey ? `${groupFolder}--${modelKey}` : groupFolder;
}

/**
 * Session key for the SQLite sessions table and in-memory sessions map.
 * Default slot: just groupFolder (backward compatible).
 * Alias slot: "groupFolder:modelKey".
 */
export function sessionKey(groupFolder: string, modelKey?: string): string {
  return modelKey ? `${groupFolder}:${modelKey}` : groupFolder;
}

/**
 * Resolve an IPC directory name to its base groupFolder and optional modelKey.
 * Uses exact match first (default slot), then "--" suffix check (alias slot).
 * Returns null if dirName does not belong to any known group — caller should skip it.
 */
export function parseIpcFolderName(
  dirName: string,
  knownGroupFolders: Set<string>,
): { groupFolder: string; modelKey?: string } | null {
  // Exact match = default slot
  if (knownGroupFolders.has(dirName)) return { groupFolder: dirName };
  // "folder--modelKey" pattern — split at last "--"
  const sep = dirName.lastIndexOf('--');
  if (sep !== -1) {
    const base = dirName.slice(0, sep);
    const modelKey = dirName.slice(sep + 2);
    if (knownGroupFolders.has(base) && modelKey.length > 0) {
      return { groupFolder: base, modelKey };
    }
  }
  return null;
}
