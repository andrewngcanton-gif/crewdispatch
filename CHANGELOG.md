# Changelog

## 0.1.4 — in validation

Caller-label UI patch release.

- Claude-originated tasks now display `You / Claude` instead of the previously hard-coded `You / Codex` label.
- Local conversation metadata records the caller source for accurate Codex / Claude / Dashboard / callback labels; provider task text is unchanged.
- Empty-state copy now refers to the provider-neutral CrewDispatch MCP.


## 0.1.3 — 2026-10-14

Caller-integration and onboarding patch release.

- Windows/macOS installers now configure Codex and Claude callers automatically.
- Codex receives the CrewDispatch local plugin (MCP + skill) plus `/prompts:crewdispatch`; Claude receives MCP, hooks, skill, and `/crewdispatch`.
- Complete uninstall removes only CrewDispatch-owned caller integration and preserves edited/foreign entries.
- The exact Dashboard URL is shown once per caller conversation on its first accepted dispatch.


## 0.1.2 — 2026-10-14

Installer UI patch release.

- Fixes the blank Windows installer welcome page.
- Adds a regression for NSIS Modern UI language initialization.
- macOS keeps the standard Apple Installer UI; this patch does not change its installer presentation.

## 0.1.1 — 2026-10-14

Installer-focused patch release.

- Adds a normal per-user Windows setup executable.
- Adds one macOS installer package that selects Apple Silicon or Intel payload automatically.
- Adds a unified complete-uninstall path that removes managed program files, Dashboard autostart, and unmodified Codex/Claude integration.
- Adds an explicit **remove all CrewDispatch data** option for jobs, logs, settings, and history; Node.js, Command Code, and WorkBuddy AI are never removed.
- Keeps user-edited or foreign files/configuration fail-closed and reports them instead of deleting them.

## 0.1.0 — 2026-10-14

Initial public developer release.

Highlights:

- Durable local broker/worker job execution.
- Command Code and WorkBuddy AI providers.
- MCP dispatch/status/result/follow-up/cancel/settings tools.
- Browser Dashboard and approval flow.
- Windows x64 plus macOS arm64/x86_64 packaging.
- Managed install/doctor/upgrade/uninstall.
- Optional Codex and Claude caller integrations.
- Apache-2.0 licensing with bundled third-party notices.

Known limits:

- Node.js 22+ is a user-managed prerequisite.
- Linux is not supported in 0.1.0.
- macOS packages are not Developer ID signed/notarized.
- Authenticated Intel WorkBuddy/Claude GUI coverage is limited compared with Apple Silicon.
