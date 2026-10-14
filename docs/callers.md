# Codex and Claude callers

CrewDispatch can be used from MCP-capable callers. Caller integration is separate from execution providers: Codex/Claude submit and collect CrewDispatch jobs, while Command Code or WorkBuddy AI performs the provider work.

## Codex

The release carries an optional thin composer prompt. Install it with:

```text
node <target>/scripts/install-codex-command.cjs
```

Reload Codex, then select `/prompts:crewdispatch`. The installer is conservative: an unrelated or user-modified prompt is not overwritten.

Remove the CrewDispatch-owned prompt with:

```text
node <target>/scripts/uninstall-codex-command.cjs
```

The uninstaller removes only the known CrewDispatch-owned prompt content and preserves user modifications.

The canonical plugin/skill payload is under:

```text
<target>/plugins/crewdispatch/
```

## Claude

Install the user-level Claude integration from the installed CrewDispatch runtime:

```text
node <target>/dist/cli/install-cli.js claude-install
node <target>/dist/cli/install-cli.js claude-doctor
```

It manages only CrewDispatch-owned MCP/hook/skill/command entries. Unrelated Claude configuration is preserved.

Remove it with:

```text
node <target>/dist/cli/install-cli.js claude-uninstall
```

Edited managed entries are preserved and reported instead of being force-deleted.
