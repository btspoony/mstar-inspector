/**
 * The App's brand mark on both dashboard surfaces (Apps list row, App
 * identity card). `github_avatar_url` is derived from the GitHub App id
 * (`avatars.githubusercontent.com/in/<id>`) — a CDN object that can 404, so a
 * load failure swaps in the default octocat placeholder at the SAME box size
 * (no broken-image icon, no layout jump). `className` is the square box.
 */
import { useState } from "react";
import { GitHubMark } from "../pages/LoginPage";

export function AppAvatar({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  if (src !== null && !failed) {
    return <img src={src} alt="" className={className} onError={() => setFailed(true)} />;
  }
  return (
    <div className={`${className} flex items-center justify-center bg-muted text-muted-foreground`}>
      <GitHubMark className="h-1/2 w-1/2" />
    </div>
  );
}
