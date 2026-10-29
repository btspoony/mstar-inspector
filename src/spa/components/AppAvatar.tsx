/**
 * The App's brand mark on both dashboard surfaces (Apps list row, App
 * identity card).
 *
 * `src` is the cached `github_avatar_url` column, which can be NULL (never
 * synced, or synced by a version that could not derive it — the column is
 * filled by the metadata sync and stays NULL until the 24h TTL expires). So
 * the mark falls back to the URL the shared contract derives from the numeric
 * App id (src/contracts/app-avatar.ts — the same function the dashboard's
 * metadata sync caches with): an App whose cache is empty still shows its real
 * icon on the first page load, no refresh needed.
 *
 * A CDN miss (404) swaps in the default octocat placeholder at the SAME box
 * size — no broken-image icon, no layout jump. A NEW url gets a fresh attempt,
 * so a card reloaded with a different App never inherits the previous failure.
 */
import { useEffect, useState } from "react";
import { appAvatarUrl } from "../../contracts/app-avatar";
import { GitHubMark } from "../pages/LoginPage";

export function AppAvatar({
  src,
  appId,
  className,
}: {
  /** The cached avatar column; NULL = never synced, derived from `appId`. */
  src: string | null;
  /** The numeric GitHub App id — the read-time derivation when `src` is NULL. */
  appId?: number;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = src ?? (appId === undefined ? null : appAvatarUrl(appId));
  // A different url is a different image: clear the failure so it is tried.
  useEffect(() => setFailed(false), [url]);
  if (url !== null && !failed) {
    return <img src={url} alt="" className={className} onError={() => setFailed(true)} />;
  }
  return (
    <div className={`${className} flex items-center justify-center bg-muted text-muted-foreground`}>
      <GitHubMark className="h-1/2 w-1/2" />
    </div>
  );
}
