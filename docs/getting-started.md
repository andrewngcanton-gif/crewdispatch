# Getting started

## 1. Install prerequisites

Install Node.js 22 or newer and confirm both commands work:

```text
node --version
npm --version
```

Install and sign in to Command Code and/or WorkBuddy AI using the provider's own official instructions. CrewDispatch does not install or alter provider accounts.

## 2. Install CrewDispatch

Windows: download and run `CrewDispatch-Setup-0.1.3.exe`. The installer is currently unsigned, so Microsoft Defender SmartScreen may show **Windows protected your PC**. If you downloaded it from the official GitHub Release, verify the published SHA-256 checksum, then use **More info → Run anyway**.

macOS: download and open `CrewDispatch-0.1.3.pkg`. The package contains both Apple Silicon and Intel payloads and selects the current architecture automatically.

The macOS package is unsigned/not notarized. If macOS blocks it, use **Open Anyway** in System Settings → Privacy & Security.

Both installers use the same managed CrewDispatch install/doctor/uninstall logic. They do not add CrewDispatch to the global `PATH`.

The installer also configures supported callers automatically. Fully restart Codex/ChatGPT Desktop to use `/prompts:crewdispatch`; start a new Claude session to use `/crewdispatch`. Codex carries the CrewDispatch MCP + skill through its local plugin, while Claude receives MCP + hooks + skill + command.

## 3. Verify the installation

After installation, open the Dashboard launcher. Advanced users can run the target-local `doctor` command directly.

Doctor checks the installed payload, Node requirement, packaged plugin/MCP entry, wrappers, runtime dependencies, local MCP/Hub smoke probes, notices/license, and Dashboard autostart state without sending a paid/provider model prompt. The platform installer lifecycle separately verifies the user-level Codex/Claude caller files and registrations.

## 4. Open the Dashboard

Use the **CrewDispatch Dashboard** launcher installed for your platform. The Dashboard binds to loopback only.

## 5. Configure a caller

See [Codex and Claude callers](callers.md). The normal installer configures supported callers automatically; CrewDispatch's persisted jobs and Dashboard remain independent of any one caller.
