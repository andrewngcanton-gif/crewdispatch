# Codex and Claude callers

CrewDispatch can be used from MCP-capable callers. Caller integration is separate from execution providers: Codex/Claude submit and collect CrewDispatch jobs, while Command Code or WorkBuddy AI performs the provider work.

## Codex

The normal Windows/macOS installer automatically registers the CrewDispatch local Codex plugin and the composer prompt. After installation, fully restart Codex/ChatGPT Desktop, then use:

```text
/prompts:crewdispatch
```

The plugin carries the CrewDispatch MCP server and `crewdispatch` dispatch skill. The prompt installer is conservative: an unrelated or user-modified prompt is never overwritten. Advanced/manual repair can re-register the prompt from the installed runtime with:

```text
node <target>/scripts/install-codex-command.cjs
```

Complete uninstall removes the CrewDispatch-owned plugin/marketplace registration and untouched prompt. Edited or foreign entries are preserved and reported. Upgrade may retire a CrewDispatch-owned registration whose previous install target is already gone, but unrelated development/foreign plugins are never deleted just because their names resemble CrewDispatch. If duplicate CrewDispatch slash entries appear, inspect the enabled Codex plugin/marketplace sources and remove obsolete development entries explicitly.
## Claude

The normal Windows/macOS installer automatically installs the user-level Claude caller integration: MCP registration, SessionStart/SessionEnd binding hooks, the `crewdispatch` skill, and `/crewdispatch` command. Start a new Claude session after installation.

Advanced/manual repair from the installed runtime remains available:

```text
node <target>/dist/cli/install-cli.js claude-install
node <target>/dist/cli/install-cli.js claude-doctor
```

Complete uninstall removes only CrewDispatch-owned MCP/hook/skill/command entries. Edited or foreign entries are preserved and reported. `claude-doctor` is the first troubleshooting step if the CrewDispatch MCP or lifecycle hooks are missing after an upgrade; repair from the stable installed runtime with `claude-install` rather than hand-editing unrelated Claude settings.