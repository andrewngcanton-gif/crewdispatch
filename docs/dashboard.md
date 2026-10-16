# Dashboard

Start or reuse the local Dashboard with the target-local `crewdispatch web` wrapper. The Hub listens on IPv4 loopback only and refuses a foreign service that already occupies the selected port.

The Dashboard provides session history, bounded logs, approval decisions, provider/global settings, follow-up, cancellation, and diagnostics cleanup. Starting the Dashboard is not required for already accepted background jobs to continue.

Provider Settings intentionally distinguish first load from later refreshes. The first usable read shows `Loading configuration… First load may take a moment.`. Command Code keeps that first-load feedback visible while its initial capability/Reasoning evidence is still being read, even if the local model list appears quickly. After a provider has a usable view, switching away and back or verifying a save keeps the existing form visible and usable while fresh evidence is read in the background. `Saving…` ends when the config write succeeds; provider verification continues afterwards.

Useful forms:

```text
crewdispatch web
crewdispatch web --no-open
crewdispatch web --port 30080
```

The default port is 30080. `--port` wins over environment defaults.
