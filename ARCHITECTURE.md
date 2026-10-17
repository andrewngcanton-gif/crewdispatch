# Architecture boundaries

This document is intentionally short. It describes constraints that public changes must preserve; internal design records, incident reports, release evidence, and implementation planning are maintained separately.

## Durable job ownership

A transient MCP/Codex/Claude request does not own a long-running job. The local broker/worker boundary owns execution and persisted state so caller restarts do not silently cancel accepted work.

## Provider isolation

Provider-specific discovery, execution, parsing, approvals, and catalog evidence stay behind provider adapters. Shared job state, MCP responses, usage fields, and Dashboard presentation must not grow provider-specific parsing branches.

## Fresh provider evidence

Current model availability, free status, entitlement, pricing, and provider defaults must come from fresh provider/CLI evidence where the provider exposes it. Static package catalogs may describe model identifiers but are not proof of current commercial or entitlement state.

## Process safety

Cancellation and recovery fail closed when CrewDispatch cannot prove process ownership or termination. A stale PID, ambiguous process tree, or unconfirmed child must not be treated as safely stopped.

## Install and user data

Installed program files are managed separately from the user data root. Upgrade/uninstall may remove only installer-owned, hash-matching files; user-edited and unowned files are preserved and reported. User data is not deleted by the normal uninstall path.

Automated installer and clean-room tests must use disposable user/caller profile roots rather than the developer's real Codex or Claude configuration. Ownership-safe repair may retire a missing previous CrewDispatch registration only when the installer can prove it belongs to CrewDispatch; unrelated or development integrations are preserved.

## Runtime prerequisites

CrewDispatch uses the user's Node.js installation (Node 22+). It does not bundle, replace, or globally configure Node/npm. Command Code and WorkBuddy AI remain external products and retain their own installation/runtime requirements.

## Compatibility

Public names and new filesystem paths use CrewDispatch. Legacy `jobquay` protocol/environment/data identifiers may remain when changing them would break existing persisted state or integrations. Compatibility removal requires an explicit migration rather than a cosmetic rename.

## Platform changes

Windows and macOS platform-specific process, installer, autostart, and packaging code must retain platform-specific regression coverage before release.
