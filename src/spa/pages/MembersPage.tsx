import { useCallback, useEffect, useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";
import { canViewMembers, inviteLoginNoticeKey, parseMembers, type MemberRow } from "./data";
import { LoadFailedNotice, LoadingNotice, PageNotice, type NoticeKind } from "./PageNotice";

export function MembersPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);

  const allowed = canViewMembers(boot.role);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const parsed = parseMembers(await fetchJson("/dashboard/api/members"));
      if (!parsed) {
        setState("error");
        return;
      }
      setMembers(parsed);
      setState("ok");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  async function onInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const login = String(new FormData(form).get("login") ?? "");
    const key = inviteLoginNoticeKey(login);
    if (key) {
      setNotice({ kind: "error", message: t(locale, key, { login }) });
      return;
    }
    const trimmed = login.trim();
    const existed = members?.some((m) => m.github_login.toLowerCase() === trimmed.toLowerCase()) ?? false;
    const { status } = await postForm("/dashboard/members/invite", { login: trimmed });
    if (status >= 400) {
      setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
      return;
    }
    await load();
    setNotice({
      kind: existed ? "warn" : "success",
      message: t(locale, existed ? "notice.warn.alreadyMember" : "notice.success.invited", { login: trimmed }),
    });
    form.reset();
  }

  async function onRemove(userId: string, login: string): Promise<void> {
    const { status } = await postForm("/dashboard/members/remove", { userId });
    if (status >= 400) {
      setNotice({ kind: "error", message: t(locale, "notice.error.removeFailed", { login }) });
      await load();
      return;
    }
    await load();
    setNotice({ kind: "success", message: t(locale, "notice.success.removedMember", { login }) });
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t(locale, "members.heading")}</h1>
      {!allowed ? <PageNotice kind="error" message={t(locale, "members.adminOnly")} /> : null}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {allowed && state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {allowed && state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {allowed && state === "ok" && members ? (
        <section className={styles.card}>
          {members.length === 0 ? (
            <p className={styles.status}>{t(locale, "members.empty")}</p>
          ) : (
            <ul className={styles.list}>
              {members.map((member) => {
                const self = boot.login !== null && member.github_login.toLowerCase() === boot.login.toLowerCase();
                return (
                  <li key={member.id}>
                    <strong>{member.github_login}</strong>
                    <span className={styles.meta}>
                      {member.role === "admin" ? t(locale, "members.roleAdmin") : t(locale, "members.roleMember")}
                      {" · "}
                      <span className={styles.mono}>{member.created_at}</span>
                    </span>
                    {self ? (
                      <span className={styles.you}>{t(locale, "members.you")}</span>
                    ) : (
                      <button
                        className={`${styles.btnDanger} ${styles.btnSmall}`}
                        type="button"
                        onClick={() => void onRemove(member.id, member.github_login)}
                      >
                        {t(locale, "members.remove")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <form className={styles.form} onSubmit={(event) => void onInvite(event)}>
            <label className={styles.field}>
              {t(locale, "members.inviteLabel")}
              <input type="text" name="login" placeholder={t(locale, "members.invitePlaceholder")} />
            </label>
            <button className={styles.btnPrimary} type="submit">
              {t(locale, "members.inviteButton")}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
