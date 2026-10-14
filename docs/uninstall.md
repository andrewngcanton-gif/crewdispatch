# Upgrade and uninstall

Before upgrade or uninstall, finish/cancel active jobs and stop caller MCP/Hub processes that are using the installation. CrewDispatch does not terminate active work automatically.

## Normal installer uninstall

Windows: open **Settings → Apps → Installed apps → CrewDispatch → Uninstall**, or use the Start Menu **Uninstall CrewDispatch** shortcut.

macOS: open `~/Applications/CrewDispatch Uninstaller.command`.

The uninstaller removes managed CrewDispatch program files, Dashboard login autostart, and unmodified CrewDispatch Codex/Claude integration. If a caller file or configuration entry was edited after installation, it is preserved and reported instead of being overwritten or deleted.

Both uninstallers offer an explicit option to also remove all CrewDispatch jobs, logs, settings, and history. This data-removal option only accepts a dedicated `JobQuay`/`CrewDispatch` data-root directory and fails closed on links, protected paths, or arbitrary directory names.

CrewDispatch never uninstalls Node.js, Command Code, WorkBuddy AI, or provider accounts/credentials.

## CLI uninstall

Normal managed uninstall preserves the separate data root:

```text
node <target>/dist/cli/install-cli.js uninstall --target <target>
```

Complete managed uninstall also cleans unmodified Codex/Claude integration:

```text
node <target>/dist/cli/install-cli.js complete-uninstall --target <target>
```

To explicitly remove the dedicated CrewDispatch data root as well:

```text
node <target>/dist/cli/install-cli.js complete-uninstall --target <target> --purge-data
```

## Upgrade

The platform installer upgrades an existing managed installation in place. Advanced users can also run:

```text
node dist/cli/install-cli.js upgrade --target <absolute-installed-directory>
```

User-edited managed files and unowned files are protected; unsafe collisions fail closed.
