---
category: Changed
---

- **The deployment operator no longer holds tenant rights.** `ADMIN_LOGINS`
  (deployment-level admin) is gone from the authorization path; the new
  `PLATFORM_OPERATORS` var is a pure allowlist that grants nothing by default.
  The workspace gate classifies `member → invitee → operator-granted →
  operator-denied → outsider`: an operator who is a member keeps ordinary
  membership rights, one without a live `support_grants` row gets the same 404
  an outsider does, and one **with** a live grant may read only the workspace
  identity fields and the member list (login + role). App list, App settings,
  credentials, model chains, settings writes, role changes, member removal,
  invites and the audit list all answer 403 to a granted operator.
- **Every operator request is audited, from the gate.** The workspace middleware
  appends exactly one `audit_events` row before dispatch — `support.read`,
  `support.forbidden` or `support.denied` — so a route handler cannot skip the
  record. Grants are time-boxed and evaluated per request from `expires_at`; an
  expired grant behaves exactly like no grant.
- **Tenants can see the window.** Every member of the workspace gets an
  undismissable notice naming the operator, the grant reason and its expiry —
  with no control that ends or edits the grant. `owner`/`admin` can read the
  audit rows through `GET /dashboard/<ref>/api/audit`; a plain `member` gets
  403. The notice is gone the request after the grant lapses.

<!-- CN -->
- **部署运维者不再自动获得租户权限。** 部署级管理员 `ADMIN_LOGINS` 已从授权路径中移除；
  新的 `PLATFORM_OPERATORS` 变量只是一个白名单，默认不授予任何权限。工作区网关按
  `member → invitee → operator-granted → operator-denied → outsider` 分类：本身是成员的
  运维者仍享有普通成员权限；没有有效 `support_grants` 行的运维者得到与外部人完全相同的
  404；**拥有**有效授权的运维者只能读取工作区身份字段与成员名单（登录名 + 角色）。App
  列表、App 设置、凭据、模型链、设置写入、角色变更、移除成员、邀请与审计列表对已授权
  运维者一律返回 403。
- **每一次运维访问都在网关内留痕。** 工作区中间件在派发之前恰好追加一条 `audit_events`
  记录——`support.read`、`support.forbidden` 或 `support.denied`——因此路由处理器无法跳过
  该记录。授权是限时的，每次请求按 `expires_at` 判定；过期授权与无授权表现完全一致。
- **租户看得见这段窗口。** 工作区的所有成员都会看到一条不可关闭的通知，写明运维者、
  授权原因与到期时间——且不提供任何结束或编辑授权的控件。`owner`/`admin` 可以通过
  `GET /dashboard/<ref>/api/audit` 读取审计记录，普通 `member` 返回 403。授权过期后，
  通知在下一次请求即消失。
