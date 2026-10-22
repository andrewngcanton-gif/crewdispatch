# CrewDispatch

CrewDispatch is a local orchestration layer for durable coding-agent jobs. A caller such as Codex or Claude can dispatch work to supported providers, leave the turn, and later collect the same persisted job result. The first public release targets Command Code and WorkBuddy AI.

## Watch the Demo

[![CrewDispatch demo — Make Your AI Quota Last Longer](assets/crewdispatch-demo-cover.jpg)](https://www.youtube.com/watch?v=0ItbPMPjRis)

*Installation, configuration, and real workflows in Codex and Claude.*

**Written guide:** [CrewDispatch Setup Guide](https://vibeatma.blogspot.com/2026/10/crewdispatch-setup-guide.html)

## Requirements

- **Node.js 22+**, installed and managed by the user. CrewDispatch does not bundle or replace Node/npm.
- Windows x64, macOS Apple Silicon, or macOS Intel x86_64.
- **Command Code CLI** and/or **WorkBuddy AI** (<https://www.workbuddy.ai/>) installed and authenticated separately when you want to use that provider.

CrewDispatch does not modify the global `PATH`, does not install provider accounts, and does not bundle provider credentials.

## Downloads

The latest GitHub Release provides normal installers:

Only artifacts attached to an official GitHub Release are public releases; local/private test packages with another filename or commit suffix are not release evidence.

- `CrewDispatch-Setup-0.1.9.exe` — Windows x64, per-user installer.
- `CrewDispatch-0.1.9.pkg` — macOS installer for Apple Silicon and Intel.

GitHub also provides source-code archives automatically. The 0.1.0 manual ZIPs remain available on the historical 0.1.0 release.

## Main features

- Durable background jobs that outlive a transient MCP/caller turn.
- Command Code and WorkBuddy AI provider adapters.
- MCP tools for spawn, status, one-shot result collection, follow-up, cancellation, and settings.
- Local loopback Dashboard for sessions, logs, approvals, provider settings, follow-up, and cancellation.
- Managed install, doctor, upgrade, and uninstall with preservation of user data and edited/unowned files.
- Installer-managed Codex and Claude caller integrations, with ownership-safe upgrade/repair and complete uninstall that preserves edited/foreign entries.

## Install

Download the installer for your platform and open it. The installer checks the Node.js 22+ prerequisite and installs CrewDispatch for the current user without modifying the global `PATH`.

Windows adds Start Menu entries for the Dashboard and uninstaller. macOS installs the runtime in the current user's Application Support directory and adds Dashboard / Uninstaller launchers under `~/Applications`.

The Windows installer is currently unsigned, so Microsoft Defender SmartScreen may show **Windows protected your PC** on first launch. If you downloaded it from the official GitHub Release, use **More info → Run anyway** after verifying the published SHA-256 checksum.

The macOS package is unsigned and not notarized; first install may require **Open Anyway** in System Settings → Privacy & Security.

## Uninstall

**Windows:** open **Settings → Apps → Installed apps → CrewDispatch → Uninstall**, or use the Start Menu **Uninstall CrewDispatch** shortcut.

**macOS:** open Finder → **Home → Applications**, then double-click **CrewDispatch Uninstaller.command** (`~/Applications/CrewDispatch Uninstaller.command`). The uninstaller removes CrewDispatch program files, Dashboard login startup, and unmodified Codex/Claude integration. It asks whether to also remove CrewDispatch jobs, logs, settings, and history; choose **No** to keep that data or **Yes** for a complete data purge.

Uninstall never removes Node.js, Command Code, WorkBuddy AI, or provider accounts/credentials. See [Upgrade and uninstall](docs/uninstall.md) for advanced/CLI options.

Advanced users can still use the managed CLI installer from a source/release payload.

See [Getting started](docs/getting-started.md) for the complete first-run flow.

## Caller integrations

- [Codex and Claude](docs/callers.md)
- [Dashboard](docs/dashboard.md)
- [Upgrade and uninstall](docs/uninstall.md)
- [Architecture boundaries](ARCHITECTURE.md)

## License

CrewDispatch is licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## Contributions

The 0.1.x line is owner-directed. External pull requests are not currently accepted; reproducible bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
