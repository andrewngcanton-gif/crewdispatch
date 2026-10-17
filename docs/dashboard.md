# Dashboard

Start or reuse the local Dashboard with the target-local `crewdispatch web` wrapper. The Hub listens on IPv4 loopback only and refuses a foreign service that already occupies the selected port.

The Dashboard provides session history, bounded logs, approval decisions, provider/global settings, follow-up, cancellation, and diagnostics cleanup. Starting the Dashboard is not required for already accepted background jobs to continue.

In provider Settings, freshly verified free models are ordered first and labelled `Free now`. The native model select remains platform-native; some macOS browser menus may not visibly render the requested per-option bold weight, so the reliable indicators are ordering and the `Free now` label.

Useful forms:

```text
crewdispatch web
crewdispatch web --no-open
crewdispatch web --port 30080
```

The default port is 30080. `--port` wins over environment defaults.
