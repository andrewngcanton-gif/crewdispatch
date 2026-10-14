# Getting started

## 1. Install prerequisites

Install Node.js 22 or newer and confirm both commands work:

```text
node --version
npm --version
```

Install and sign in to Command Code and/or WorkBuddy AI using the provider's own official instructions. CrewDispatch does not install or alter provider accounts.

## 2. Install CrewDispatch

Windows: download and run `CrewDispatch-Setup-0.1.1.exe`.

macOS: download and open `CrewDispatch-0.1.1.pkg`. The package contains both Apple Silicon and Intel payloads and selects the current architecture automatically.

Both installers use the same managed CrewDispatch install/doctor/uninstall logic. They do not add CrewDispatch to the global `PATH`.

## 3. Verify the installation

After installation, open the Dashboard launcher. Advanced users can run the target-local `doctor` command directly.

Doctor checks the installed payload, Node requirement, plugin/MCP entry, wrappers, runtime dependencies, local MCP/Hub smoke probes, notices/license, and Dashboard autostart state without sending a paid/provider model prompt.

## 4. Open the Dashboard

Use the **CrewDispatch Dashboard** launcher installed for your platform. The Dashboard binds to loopback only.

## 5. Configure a caller

See [Codex and Claude callers](callers.md). Caller integrations are optional; CrewDispatch's persisted jobs and Dashboard are independent of any one caller.
