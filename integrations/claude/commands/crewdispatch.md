---
description: CrewDispatch — dispatch a long-running task from this conversation
argument-hint: [task to hand to CrewDispatch]
---

Load and follow the CrewDispatch dispatch skill (`crewdispatch`), including task
preparation and acceptance. Dispatch the request appended below, or the latest
agreed task in this conversation. Ask only if the objective or workspace is
unclear; report a missing skill or MCP tools instead of guessing.

Bind THIS conversation once using the binding line CrewDispatch's SessionStart
hook printed here (`claude_session_id` or `claude_binding_id`; an opaque id —
never a socket address, a token or an id from another conversation), pass it
explicitly to `crewdispatch_spawn`, then end the turn. A terminal wake collects
the result exactly once; an approval wake is not a completion and is never
answered automatically.

Task: $ARGUMENTS
