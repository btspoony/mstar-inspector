/**
 * One-shot flash across a full-page navigation (the delete flow's outcome).
 *
 * sessionStorage — not the URL — so the message never lands in history or the
 * address bar, and the dashboard boot reads and clears it before React mounts.
 */

/** The one documented key: written before `location.assign`, read + cleared once. */
export const FLASH_STORAGE_KEY = "mstar.dashboard.flash";

// shortcut: one flash today (the delete outcome); store a value when a second
// consumer needs to tell kinds apart.
export function setFlash(): void {
  try {
    sessionStorage.setItem(FLASH_STORAGE_KEY, "1");
  } catch {
    // Unavailable storage (private mode): the delete still happened, only the
    // confirmation is lost.
  }
}

/** Read-once: true and the key is removed, so the next page load shows nothing. */
export function takeFlash(): boolean {
  try {
    if (sessionStorage.getItem(FLASH_STORAGE_KEY) === null) return false;
    sessionStorage.removeItem(FLASH_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
