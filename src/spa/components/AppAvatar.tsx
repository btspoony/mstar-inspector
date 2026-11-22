import { useEffect, useState } from "react";
import { appAvatarUrl } from "../../contracts/app-avatar";
import { GitHubMark } from "../pages/LoginPage";

export function AppAvatar({
  src,
  appId,
  className,
}: {
  src: string | null;
  appId?: number;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = src ?? (appId === undefined ? null : appAvatarUrl(appId));
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
