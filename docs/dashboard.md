# Dashboard

Start or reuse the local Dashboard with the target-local `crewdispatch web` wrapper. The Hub listens on IPv4 loopback only and refuses a foreign service that already occupies the selected port.

The Dashboard provides session history, bounded logs, approval decisions, provider/global settings, follow-up, cancellation, and diagnostics cleanup. Starting the Dashboard is not required for already accepted background jobs to continue.

Useful forms:

```text
crewdispatch web
crewdispatch web --no-open
crewdispatch web --port 30080
```

The default port is 30080. `--port` wins over environment defaults.
