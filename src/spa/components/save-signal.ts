import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The per-form save signal: the button-resident face of one save flow.
 * idle → loading on submit; success reverts to idle on its own after a short
 * confirmation window; error stays put until the next submit (a failure is
 * never transient). The revert timer is cleared when a new submit restarts
 * the flow and on unmount, so no state update can land in a gone tree.
 *
 * SPA-local on purpose: the design system ships the Button face, the save
 * lifecycle belongs to the app.
 */
export type SaveStatus = "idle" | "loading" | "success" | "error";

export const SAVE_SUCCESS_REVERT_MS = 2000;

export function useSaveSignal(): {
  status: SaveStatus;
  start: () => void;
  succeed: () => void;
  fail: () => void;
} {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Effect-managed lifetime: StrictMode's setup/cleanup/setup re-arms it,
  // and a real unmount flips it off for good — an async completion that
  // resolves after teardown retains its callbacks but can neither transition
  // state nor arm a new timer.
  const mounted = useRef(false);

  const clearRevert = useCallback(() => {
    if (revertTimer.current !== null) {
      clearTimeout(revertTimer.current);
      revertTimer.current = null;
    }
  }, []);

  // Unmount is the last word: the pending revert is disarmed and every
  // retained callback becomes a no-op.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearRevert();
    };
  }, [clearRevert]);

  const start = useCallback(() => {
    if (!mounted.current) return;
    clearRevert();
    setStatus("loading");
  }, [clearRevert]);

  const succeed = useCallback(() => {
    if (!mounted.current) return;
    clearRevert();
    setStatus("success");
    revertTimer.current = setTimeout(() => {
      revertTimer.current = null;
      setStatus("idle");
    }, SAVE_SUCCESS_REVERT_MS);
  }, [clearRevert]);

  const fail = useCallback(() => {
    if (!mounted.current) return;
    clearRevert();
    setStatus("error");
  }, [clearRevert]);

  return { status, start, succeed, fail };
}
