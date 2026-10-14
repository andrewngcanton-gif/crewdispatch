# Upgrade and uninstall

Before upgrade or uninstall, finish/cancel active jobs and stop caller MCP/Hub processes that are using the installation. The installer does not kill running work automatically.

## Upgrade

Run the upgrade from a release/source tree outside the installed target:

```text
node dist/cli/install-cli.js upgrade --target <absolute-installed-directory>
```

User-edited managed files and unowned files are protected; unsafe collisions fail closed.

## Caller cleanup

If you installed caller integrations and want them removed, run those cleanup commands before deleting the main target:

```text
node <target>/scripts/uninstall-codex-command.cjs
node <target>/dist/cli/install-cli.js claude-uninstall
```

Both preserve user-edited/foreign content.

## Main uninstall

```text
node <target>/dist/cli/install-cli.js uninstall --target <target>
```

Normal uninstall removes only installer-owned, hash-matching program files and login-autostart entries. The separate CrewDispatch data root (jobs, logs, settings/history) is intentionally left untouched.
