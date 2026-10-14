# CrewDispatch

CrewDispatch is a local orchestration layer for durable coding-agent jobs. A caller such as Codex or Claude can dispatch work to supported providers, leave the turn, and later collect the same persisted job result. The first public release targets Command Code and WorkBuddy AI.

## Requirements

- Node.js 22 or newer, installed and managed by the user. CrewDispatch does not bundle or replace Node/npm.
- Windows x64, macOS Apple Silicon, or macOS Intel x86_64.
- Command Code and/or WorkBuddy AI installed and authenticated separately when you want to use that provider.

CrewDispatch does not modify the global `PATH`, does not install provider accounts, and does not bundle provider credentials.

## Downloads

The GitHub Release provides two binary downloads:

- `CrewDispatch-0.1.0-Windows-x64.zip`
- `CrewDispatch-0.1.0-macOS.zip` — contains the verified Apple Silicon (`arm64`) and Intel (`x86_64`) packages.

GitHub also provides source-code archives automatically.

## Main features

- Durable background jobs that outlive a transient MCP/caller turn.
- Command Code and WorkBuddy AI provider adapters.
- MCP tools for spawn, status, one-shot result collection, follow-up, cancellation, and settings.
- Local loopback Dashboard for sessions, logs, approvals, provider settings, follow-up, and cancellation.
- Managed install, doctor, upgrade, and uninstall with preservation of user data and edited/unowned files.
- Optional Codex and Claude caller integrations.

## Install from a release ZIP

Unpack the release, then run the installer with an absolute target directory:

```text
node dist/cli/install-cli.js install --target <absolute-directory>
```

The installed command wrappers are target-local:

```text
<target>/bin/crewdispatch web
```

On Windows the wrapper is `<target>\bin\crewdispatch.cmd`.

Run a health check at any time:

```text
node <target>/dist/cli/install-cli.js doctor --target <target>
```

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
