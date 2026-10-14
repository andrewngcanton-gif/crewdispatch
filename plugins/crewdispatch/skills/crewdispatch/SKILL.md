---
name: crewdispatch
description: Dispatch a long-running coding task through the CrewDispatch MCP server using Command Code or WorkBuddy AI, then collect its result exactly once. Use when work should keep running after the current turn ends or when the user asks to hand work to CrewDispatch.
---

# Dispatching work through CrewDispatch

CrewDispatch runs a selected coding-agent CLI task as a durable local job in a detached
worker. The first-release providers are Command Code and WorkBuddy AI. The job
keeps running after your turn ends; a closed request, a timeout or an ended
Codex/Claude turn never cancels it. Only an explicit `crewdispatch_cancel` does.

## The call flow (follow it exactly)

1. **Bind this conversation once.** Pass the caller identity for THIS
   conversation explicitly; never let the wake be inferred from the latest
   conversation, a title or the working directory.
   - **Codex:** read `CODEX_THREAD_ID` once in a local, no-LLM shell and keep
     the value. The long-running MCP server does not reliably inherit it, so
     pass it explicitly as `codex_thread_id`.
   - **Claude Code:** use the binding line CrewDispatch's SessionStart hook
     printed in THIS conversation and pass its `claude_session_id` (or
     `claude_binding_id`) value. It is an opaque id — never a socket address or
     a token, and never an id from another conversation. Without that line the
     wake capability is unavailable in this host; do not guess.
2. **Dispatch.** Call `crewdispatch_spawn` with `task`, `cwd`, and your caller
   identity. It returns a stable `job_id` immediately. For a task you expect to
   finish quickly you may use `crewdispatch_run` (a bounded local wait) instead.
   If the accepted response contains `dashboard_hint`, show that one-line hint
   to the user once. Do not repeat it on later calls when the field is absent.
3. **End the turn.** After an async dispatch, stop. Do **not** poll status or
   resume the cell; CrewDispatch attempts one terminal wake per generation. If
   delivery fails, a user-initiated status check can recover the result.
4. **Collect once (terminal wakes only).** When woken by a terminal completion, call
   `crewdispatch_result` exactly once with the job id. Do not call it in a loop.
5. **Decide the next action (after acceptance).** When acceptance finds defects
   in the **same objective**, default to `crewdispatch_follow_up` (`id`,
   `message`) on the existing job with a precise repair packet; the job id and
   provider session are preserved and the generation advances. Use
   `crewdispatch_spawn` only for an **independent new objective**. Only a
   terminal job can be continued.

## Permission mode (only when the user asks)

Omit `permission_mode` to preserve the provider's saved/default setting. Set it
only when the user explicitly chooses a mode for this dispatch: standard
permission is `standard` for Command Code (`default` is an accepted synonym)
and `default` for WorkBuddy AI. Honor other explicitly requested modes subject
to the selected CLI's capabilities; never substitute a broader permission.

The provider decides when tool execution needs human approval; selecting a
permission mode does not itself grant that approval (see Two kinds of wake).

## Repair the same objective or start a new one

A worker terminal result must be reviewed and verified by the acceptance owner
(you, or the external controller when it owns acceptance). It is not itself
acceptance and never a reason to spawn a replacement job. Only after that
review does the next action below apply.

- **Defect in the SAME objective** — default to `crewdispatch_follow_up` on the
  existing job id with a precise repair packet: the observed defect, the
  evidence, the exact files/functions, the required behavior and the acceptance
  check. The job id and provider session are preserved.
- **Independent new objective** — use `crewdispatch_spawn`; it creates a new
  logical job. Repairing already-delivered work is never a new objective.
- **Cancelled or interrupted job** — not an acceptance outcome. Do not resume it
  automatically; a follow-up requires authorized remaining work.

The terminal result repeats this guidance in its advisory `continuation_hint`
field (which names the actual job id). The advisory adds no automatic dispatch,
continuation or retry; the existing terminal-wake recovery of
`crewdispatch_result` is unchanged.

## Two kinds of wake

A wake is one of two typed events:

- **Terminal completion** — the job finished; collect exactly once as above.
- **`approval_required`** — a RUNNING provider turn paused for a human decision
  and the job is NOT finished. Tell the human, show them the job/run, the bounded
  operation and the Dashboard link from the wake, and let them decide in the
  Dashboard. Do not call `crewdispatch_result`, do not approve or reject on the
  human's behalf, and do not poll; the same job/session continues once the human
  resolves it.

## The task packet

`task` is passed to the selected provider CLI **verbatim** — CrewDispatch adds no prefix,
no parent history, no credential and no boilerplate. You prepare the packet. For
a coding task, make each field concrete:

1. **Objective, workspace and ownership.** The goal, the `cwd`, and the specific
   files/functions or subsystem the worker owns. State that other work may
   coexist and must not be reverted.
2. **Observed evidence and call path.** The failure you actually observed and the
   production call path involved. If either is unknown, say so and assign
   *investigation* — never present a guess as fact.
3. **Required behavior and limits.** The user-visible behavior, invariants,
   compatibility and safety limits, including what external state may and may not
   change.
4. **Acceptance matched to the real boundary.** A finite matrix: pure-logic tests
   for pure logic; a real separate process/entry for process, persistence or
   notification behavior. Include cleanup of test processes and disposable data.
5. **Final report format.** Short, separating *implementation* from *acceptance*,
   with exact commands, external evidence and remaining gaps.

Never put the parent conversation, a whole-repo search, credentials, real
transcripts or oversized logs into the packet. **Do not pad a simple task to fill
the template** — a one-line task gets a one-line packet.

### File-backed packets and cleanup

Keep one-line tasks inline. For a substantial self-prepared task or repair packet,
write the complete packet once as a UTF-8 file in the workspace's established
artifact area. Use an absolute path readable by the actual worker. Pass only a
short read-and-execute instruction plus that path in task or message; do not
repeat the file body in MCP arguments or progress updates. For example:

> Read "<absolute packet path>" fully, then execute it. Do not modify or delete the packet.

- Use a unique file for each request/round; record its path with the returned job
  id/generation in your existing task notes. Never overwrite it after dispatch.
  Same-objective repairs use follow_up with a new file containing precise new
  evidence and instructions; keep previous rounds available.
- The parent owns cleanup, not the worker. Keep packets through execution,
  acceptance and repairs. At final project wrap-up, delete only your explicitly
  recorded generated packets whose objective is accepted and which no active
  task still needs. Keep reusable project summaries and acceptance evidence
  separate; do not delete them or user files as temporary packets. If interrupted
  or ownership/acceptance is unclear, leave packets for a later wrap-up.
- This is a caller convention, not a daemon snapshot, cache or expiry service.
  Use the existing task/message fields; there are no task_file/message_file
  parameters. Worker reads still consume tokens and normal read approvals apply.
  Do not file-wrap an external controller's prescribed exact task: its verbatim
  protocol-bridge exception below takes precedence.

## External-controller protocol bridge

When an external controller such as WebCodex explicitly says that **it owns quality
acceptance** and gives you an exact worker task, switch to protocol-bridge mode:

- pass the exact worker task to `crewdispatch_spawn` without rewriting it;
- after spawn, end the turn and wait for the terminal wake; do not poll;
- on each terminal wake, call `crewdispatch_result` exactly once for that same job and
  return the terminal job/generation/status/result evidence to the controller;
- do **not** inspect the workspace/diff, run the controller's review contract,
  decide pass/fail, or create a repair follow-up on your own;
- call `crewdispatch_follow_up` only when that same external controller explicitly
  sends a concrete repair message, and always continue the same job/session;
- after an explicit follow-up, end the turn, wait for the next terminal wake, call
  `crewdispatch_result` exactly once, and return control to the external controller;
- never create a replacement job merely because acceptance failed.

This exception keeps the normal direct CrewDispatch workflow intact: when there is no
external acceptance owner, Codex may still review delegated work normally. When an
external controller owns acceptance, only its explicit repair instruction permits a
follow-up.

## Tools

| Tool | Purpose |
| --- | --- |
| `crewdispatch_spawn` | Async dispatch; returns a stable job id immediately. |
| `crewdispatch_run` | Dispatch and wait locally (short tasks only); never cancels on timeout. |
| `crewdispatch_status` | Status of one job, or a bounded list. |
| `crewdispatch_result` | One-shot compact result (call once after the wake). |
| `crewdispatch_follow_up` | Continue the same job/session as a new generation. |
| `crewdispatch_cancel` | Explicit cancel; the only action that stops a running job early. |

The completion wake is short (job id + status only); an approval wake is a
distinct typed event and never a completion. Wake priority is
`callback_url` > explicit Claude session/binding > `codex_thread_id` > the
`CODEX_THREAD_ID` environment fallback; competing explicit caller identities are
rejected instead of silently choosing one.
