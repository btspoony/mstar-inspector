
/** The outcomes a full-page navigation can carry, and their copy key in Layout. */
export type FlashKind = "workspaceDeleted" | "workspaceUnavailable";

/** The one documented key: written before `location.assign`, read + cleared once. */
export const FLASH_STORAGE_KEY = "mstar.dashboard.flash";

const FLASH_KINDS: readonly FlashKind[] = ["workspaceDeleted", "workspaceUnavailable"];

export function setFlash(kind: FlashKind): void {
  try {
    sessionStorage.setItem(FLASH_STORAGE_KEY, kind);
  } catch {
  }
}

/** Read-once: the stored kind and the key removed, or null when nothing was set. */
export function takeFlash(): FlashKind | null {
  try {
    const stored = sessionStorage.getItem(FLASH_STORAGE_KEY);
    if (stored === null) return null;
    sessionStorage.removeItem(FLASH_STORAGE_KEY);
    return FLASH_KINDS.find((kind) => kind === stored) ?? null;
  } catch {
    return null;
  }
}
