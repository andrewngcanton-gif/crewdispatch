# Getting started

## 1. Install prerequisites

Install Node.js 22 or newer and confirm both commands work:

```text
node --version
npm --version
```

Install and sign in to Command Code and/or WorkBuddy AI using the provider's own official instructions. CrewDispatch does not install or alter provider accounts.

## 2. Install CrewDispatch

Windows users unpack `CrewDispatch-0.1.0-Windows-x64.zip`. macOS users unpack `CrewDispatch-0.1.0-macOS.zip`, choose the `arm64` package for Apple Silicon or the `x86_64` package for Intel, then unpack that package.

Choose an absolute installation directory that does not already exist:

```text
node dist/cli/install-cli.js install --target <absolute-directory>
```

The installer stages production dependencies, verifies the managed payload, and creates target-local wrappers. It does not add them to your global `PATH`.

## 3. Verify the installation

```text
node <target>/dist/cli/install-cli.js doctor --target <target>
```

Doctor checks the installed payload, Node requirement, plugin/MCP entry, wrappers, runtime dependencies, local MCP/Hub smoke probes, notices/license, and Dashboard autostart state without sending a paid/provider model prompt.

## 4. Open the Dashboard

macOS/Linux-style path:

```text
<target>/bin/crewdispatch web
```

Windows:

```text
<target>\bin\crewdispatch.cmd web
```

The Dashboard binds to loopback only.

## 5. Configure a caller

See [Codex and Claude callers](callers.md). Caller integrations are optional; CrewDispatch's persisted jobs and Dashboard are independent of any one caller.
