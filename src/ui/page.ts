// Product-owned Hub shell. Browser behaviour lives in client.ts and is compiled
// separately as strict TypeScript. All dynamic user/provider text is assigned
// through textContent by that client; this static template contains no task
// creation control and no executable inline script.
export const HUB_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CrewDispatch · Local sessions</title>
  <style>
    :root { color-scheme: light; --ink:#17212e; --muted:#64748b; --line:#dce4ee; --bg:#f4f7fb; --card:#fff; --blue:#245de3; --blue-soft:#eaf0ff; --red:#b42331; --green:#16835d; }
    * { box-sizing:border-box; }
    html, body { margin:0; width:100%; height:100%; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
    button, textarea, select, input { font:inherit; }
    button { cursor:pointer; }
    button:disabled { cursor:not-allowed; opacity:.55; }
    button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
    .app { display:grid; grid-template-columns:292px minmax(0,1fr); grid-template-rows:minmax(0,1fr); height:100vh; min-height:440px; overflow:hidden; }
    .sidebar { background:#fff; border-right:1px solid var(--line); display:flex; flex-direction:column; min-width:0; }
    .brand { padding:20px 20px 16px; border-bottom:1px solid var(--line); }
    .brand h1 { font-size:20px; letter-spacing:-.025em; margin:0; }
    .brand small { color:var(--muted); }
    .nav { display:flex; gap:8px; margin-top:16px; }
    .nav button { border:1px solid var(--line); background:#fff; border-radius:8px; padding:7px 12px; color:var(--muted); }
    .nav button[aria-selected="true"] { color:var(--blue); background:var(--blue-soft); border-color:#bbcdfb; font-weight:650; }
    .side-heading { padding:16px 20px 8px; display:flex; justify-content:space-between; align-items:center; color:var(--muted); font-size:12px; font-weight:700; }
    .side-heading button { border:0; background:transparent; color:var(--blue); padding:2px 0; }
    .jobs { flex:1; overflow:auto; padding:0 9px; }
    .job { width:100%; text-align:left; border:1px solid transparent; background:transparent; border-radius:9px; padding:10px 11px; margin:2px 0; display:block; }
    .job:hover { background:#f4f7fb; }
    .job[aria-current="true"] { border-color:#c5d5ff; background:var(--blue-soft); }
    .job-title { display:block; font-weight:400; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .job.unread .job-title { font-weight:700; }
    .job-unread-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--blue); margin-right:7px; vertical-align:1px; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
    .job-meta { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; margin-top:3px; font-size:11px; color:var(--muted); }
    .job-meta span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .job-meta .job-provider { grid-column:1/-1; }
    .job-meta .job-time { text-align:right; }
    .side-footer { padding:12px; border-top:1px solid var(--line); }
    .side-footer button { width:100%; border:1px solid var(--line); border-radius:8px; background:#fff; padding:8px; color:var(--blue); }
    .main { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
    .console-view { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
    .topbar { min-height:76px; background:#fff; border-bottom:1px solid var(--line); padding:16px 24px; display:flex; justify-content:space-between; gap:16px; align-items:start; }
    .topbar h2 { margin:0; font-size:18px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .subline { color:var(--muted); font-size:12px; margin-top:4px; display:flex; flex-wrap:wrap; gap:12px; }
    .subline strong { color:var(--ink); font-weight:600; }
    .subline .fallback { color:#9b591e; font-weight:600; }
    .top-actions { display:flex; gap:8px; flex-shrink:0; }
    .button { border:1px solid var(--line); background:#fff; border-radius:8px; padding:7px 12px; }
    .button.primary { background:var(--blue); color:#fff; border-color:var(--blue); }
    .button.danger { color:var(--red); border-color:#e7b4ba; }
    .workspace { flex:1; min-height:0; display:flex; flex-direction:column; padding:16px 20px 20px; gap:0; overflow:hidden; }
    .conversation { flex:1; min-height:100px; overflow:auto; background:#fff; border:1px solid var(--line); border-radius:12px 12px 0 0; padding:20px; }
    .empty { color:var(--muted); padding:18px; text-align:center; }
    .bubble { max-width:min(780px,90%); margin:0 0 16px; padding:12px 14px; border:1px solid var(--line); border-radius:11px; background:#fff; white-space:pre-wrap; overflow-wrap:anywhere; }
    .bubble.user { background:var(--blue-soft); border-color:#ccd9ff; margin-left:auto; }
    .bubble .who { font-size:11px; font-weight:700; color:var(--muted); margin-bottom:5px; }
    .bubble.assistant .who { color:var(--green); }
    .notice { border:1px solid #f0dca8; background:#fff9e8; color:#80520d; border-radius:8px; padding:9px 12px; margin-bottom:12px; }
    .approval { flex:0 0 auto; max-height:100%; overflow:auto; display:flex; flex-direction:column; border:1px solid #f0dca8; background:#fff9e8; color:#80520d; border-radius:12px; padding:12px 14px; margin-bottom:12px; }
    .approval.resolved { border-color:#cfe3d5; background:#f2faf5; color:#1d6b45; }
    .approval-head { flex:0 0 auto; display:flex; justify-content:space-between; gap:12px; align-items:baseline; font-weight:650; }
    .approval-meta { color:#9a7434; font-size:11px; font-weight:400; white-space:nowrap; }
    .approval.resolved .approval-meta { color:#4f8a6b; }
    .approval-detail { flex:1 1 auto; min-height:0; overflow:auto; margin:6px 0 10px; }
    .approval-detail-line { margin:0 0 6px; }
    .approval-op { display:flex; flex-direction:column; gap:6px; max-height:200px; overflow:auto; }
    .approval-op-row { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .approval-op-label { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:#9a7434; }
    .approval-op-code { margin:0; padding:8px 10px; background:#fff; border:1px solid #f0dca8; border-radius:8px; font-family:"Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace; font-size:12px; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; color:#5c3d09; }
    .approval-op-args { display:flex; flex-direction:column; gap:4px; min-width:0; }
    .approval-op-empty { color:#9a7434; font-style:italic; }
    .approval-op-value { white-space:pre-wrap; overflow-wrap:anywhere; }
    .approval-op-note, .approval-op-missing { margin:0; font-size:11px; color:#9a7434; }
    .pending-approvals { flex:0 0 auto; max-height:150px; overflow:auto; padding:10px 16px; background:#fff9e8; border-bottom:1px solid #f0dca8; }
    .pending-approvals button { display:block; width:100%; text-align:left; border:0; border-left:3px solid transparent; background:transparent; color:#80520d; padding:5px 0 5px 8px; overflow-wrap:anywhere; }
    .pending-approvals button[aria-current="true"] { border-left-color:#b8791a; background:#fff3d6; font-weight:650; }
    .job-approval { color:#80520d; font-weight:600; }
    .approval-task { flex:0 0 auto; margin-top:6px; display:flex; flex-direction:column; gap:2px; min-width:0; }
    .approval-task-label { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:#9a7434; }
    .approval-identity { font-weight:650; overflow-wrap:anywhere; }
    .approval-task-meta { display:flex; flex-wrap:wrap; gap:2px 12px; font-size:12px; color:#80520d; }
    .approval-task-job { font-family:"Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace; }
    .approval-meta { white-space:normal; overflow-wrap:anywhere; }
    .approval-actions { flex:0 0 auto; display:flex; gap:8px; flex-wrap:wrap; }
    /* A provider-published option label is the choice text and may be long
       (bounded at the provider boundary); it wraps inside the card instead of
       overflowing it, and the card scrolls when the choices do not fit a short
       window, so every action stays readable and reachable on narrow views. */
    .approval-actions button { max-width:100%; min-width:0; white-space:normal; overflow-wrap:anywhere; }
    .composer { flex:0 0 auto; background:#fff; border:1px solid var(--line); border-top:0; display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"input send" "tip tip"; gap:4px 10px; align-items:end; padding:12px; }
    .composer textarea { grid-area:input; display:block; width:100%; min-height:52px; max-height:180px; resize:vertical; border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
    .composer > button { grid-area:send; align-self:end; }
    .composer .tip { grid-area:tip; color:var(--muted); font-size:11px; }
    .splitter { flex:0 0 10px; height:10px; cursor:row-resize; background:#edf2f8; border-left:1px solid var(--line); border-right:1px solid var(--line); position:relative; }
    .splitter:after { content:""; display:block; width:44px; height:3px; border-radius:5px; background:#aebbd0; position:absolute; left:50%; top:3px; transform:translateX(-50%); }
    .live { flex:0 0 auto; height:220px; min-height:120px; max-height:65vh; background:#fff; border:1px solid var(--line); border-radius:0 0 12px 12px; display:flex; flex-direction:column; overflow:hidden; }
    .live-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 14px; border-bottom:1px solid var(--line); font-weight:650; }
    .live-status { margin-left:8px; color:var(--muted); font-size:11px; font-weight:400; }
    .live-head label { font-size:12px; font-weight:400; color:var(--muted); display:flex; align-items:center; gap:5px; }
    .live-controls { display:flex; gap:14px; }
    .log { flex:1; overflow:auto; padding:10px 14px; font:12px/1.5 "Cascadia Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace; }
    .log-entry { padding:4px 0; border-bottom:1px solid #f0f3f7; white-space:pre-wrap; overflow-wrap:anywhere; }
    .log-entry.reason { color:#9b591e; }
    .statusbar { min-height:30px; padding:5px 12px; background:#fff; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
    .error { color:var(--red); }
    .settings { flex:1; min-height:0; overflow:auto; padding:22px; }
    .settings-card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:22px; max-width:1040px; }
    .settings-card h2 { margin:0 0 8px; }
    .settings-card p { color:var(--muted); }
    .settings-card + .settings-card { margin-top:18px; }
    .provider-picker { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .provider-picker label { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; }
    .provider-picker select { min-width:220px; border:1px solid var(--line); border-radius:8px; padding:8px 10px; background:#fff; color:var(--ink); }
    .settings-card h3 { font-size:15px; margin:22px 0 10px; }
    .settings-subtitle { margin:6px 0 0; color:var(--muted); font-size:13px; }
    .settings-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 20px; margin-top:15px; }
    .settings-grid label { display:flex; flex-direction:column; gap:5px; color:var(--muted); font-size:12px; }
    .settings-grid input,.settings-grid select,.slot input,.slot select { border:1px solid var(--line); border-radius:8px; padding:8px 10px; background:#fff; color:var(--ink); min-width:0; }
    .settings-grid .wide { grid-column:1/-1; }
    /* Permission: label + dropdown + its explanation on ONE full-width row.
       The note is plain muted text (never a warning card); it never wraps, so
       it starts at 13px and steps down to 12px only when the text actually
       overflows its row — where any remaining overflow is the single-line
       ellipsis. The full text always stays in the element; whether the native
       title tooltip carries it is decided by the client AFTER that final
       13/12px size, and only while the text is actually truncated.
       The dropdown itself is ONE explicit width (140px, near the finished
       control's measured 124px) instead of an intrinsic width: an intrinsic
       select is sized by its WIDEST option, so the empty loading select, the
       single configured mode while capability evidence is pending, and the
       full published list would each render at a different width and visibly
       jump while the provider data arrives. The width never depends on the
       option list; the note flexes/ellipsizes beside it, and the 45vw cap
       keeps the row inside very narrow viewports. */
    .settings-grid .permission-row { grid-column:1/-1; display:flex; flex-direction:row; align-items:center; gap:5px 12px; min-width:0; }
    .settings-grid .permission-row > label { flex:0 0 auto; display:block; }
    .settings-grid .permission-row > select { flex:0 0 auto; width:min(140px,45vw); }
    .permission-note { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); font-size:13px; }
    .settings-note { border:1px solid #d6e1ff; background:#f3f7ff; border-radius:9px; padding:11px 13px; color:#385078; white-space:pre-wrap; overflow-wrap:break-word; }
    .settings-status { margin-top:12px; padding:8px 0; border-top:1px solid var(--line); color:var(--muted); font-size:12px; display:grid; gap:2px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .settings-status > div:first-child { color:var(--ink); font-weight:650; }
    .settings-status.warning { padding:8px 10px; border:1px solid #f1d09c; border-radius:8px; background:#fff8e9; color:#92560b; }
    .settings-status.warning > div:first-child { color:#92560b; }
    .settings-status.loading.wb-loading > div:first-child { font-weight:400; }
    .settings-status.loading > div:first-child::before { content:""; display:inline-block; width:10px; height:10px; margin-right:7px; border:2px solid var(--line); border-top-color:var(--blue); border-radius:50%; vertical-align:-1px; animation:settings-spin .8s linear infinite; }
    @keyframes settings-spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .settings-status.loading > div:first-child::before { animation:none; border-top-color:var(--line); } }
    .settings-warning { border:1px solid #f1d09c; background:#fff8e9; color:#92560b; border-radius:8px; padding:8px 11px; }
    .slots { display:grid; gap:8px; overflow-x:auto; }
    .slot { display:grid; grid-template-columns:auto 120px 120px minmax(140px,1fr) auto; gap:8px; align-items:center; padding:9px; border:1px solid var(--line); border-radius:9px; }
    .slot button { border:1px solid var(--line); background:#fff; border-radius:7px; padding:7px 9px; }
    .slot .order { display:flex; gap:4px; }
    .settings-actions { display:flex; gap:10px; align-items:center; margin-top:16px; }
    .settings-actions span { color:var(--muted); font-size:12px; }
    .hidden { display:none !important; }
    @media(max-width:760px) { .app { grid-template-columns:220px minmax(0,1fr); } .brand { padding:14px; } .topbar { padding:12px; } .workspace { padding:8px; } .subline { gap:6px; } .live-controls { gap:5px; } }
    @media(max-height:480px) { .app { min-height:0; } .pending-approvals { max-height:64px; padding:6px 10px; } .topbar { min-height:52px; padding:6px 12px; } .workspace { padding:6px 8px; } .approval { max-height:calc(100vh - 232px); padding:4px 8px; margin-bottom:4px; } .approval-head { gap:6px; font-size:13px; } .approval-task { margin-top:2px; } .approval-task-label { font-size:9px; } .approval-task-meta { font-size:11px; gap:1px 10px; } .approval-detail { margin:3px 0 4px; } .approval-op { max-height:84px; } .approval-actions button { padding:4px 8px; font-size:12px; } .live { height:84px; min-height:54px; } .statusbar { min-height:24px; } }
    /* Narrow slots: the row's five children follow renderSlots() order —
       enabled, start, end, model, .order — so stack the controls 2-up with
       full-width rows for enabled/model/actions instead of forcing a 640px
       row behind a horizontal scrollbar. */
    @media(max-width:760px) { .settings-grid { grid-template-columns:minmax(0,1fr); } .settings { padding:10px; } .settings-card { padding:15px; } .slot { grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; min-width:0; } .slot > label { display:flex; flex-direction:column; gap:4px; } .slot > label:first-child { grid-column:1/-1; flex-direction:row; align-items:center; gap:6px; } .slot > label:nth-child(4) { grid-column:1/-1; } .slot > .order { grid-column:1/-1; justify-content:flex-end; } }
    @media(max-width:560px) { .app { grid-template-columns:1fr; grid-template-rows:160px minmax(0,1fr); } .sidebar { border-right:0; border-bottom:1px solid var(--line); } .brand { padding:8px 12px; } .brand h1 { font-size:15px; } .nav { margin-top:4px; } .jobs { display:flex; overflow:auto; padding:0 6px; } .job { min-width:160px; width:160px; } .side-heading,.side-footer { display:none; } .settings-actions { flex-wrap:wrap; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <header class="brand"><h1>CrewDispatch</h1><small>Local development sessions</small><nav class="nav" aria-label="Main navigation"><button id="navJobs" aria-selected="true" type="button">Sessions</button><button id="navSettings" aria-selected="false" type="button">Settings</button></nav></header>
      <div class="side-heading"><span>Session list</span><button id="refreshJobs" type="button">Refresh</button></div>
      <div id="jobs" class="jobs" aria-label="Session list"></div>
      <div class="side-footer"><button id="loadMore" class="hidden" type="button">Load 50 more</button></div>
    </aside>
    <main class="main">
      <section id="pendingApprovals" class="pending-approvals hidden" aria-label="Pending approvals"><strong id="pendingApprovalCount" role="status"></strong><div id="pendingApprovalList"></div></section>
      <div id="consoleView" class="console-view">
        <header class="topbar"><div style="min-width:0"><h2 id="jobTitle">Select a session</h2><div class="subline"><span id="jobStatus">Open a task from the list on the left</span><span id="jobRuntime"></span><span id="jobProvider"></span><span id="jobModel"></span><span id="jobEffort"></span><span id="jobFallback" class="fallback"></span><span id="jobUsage"></span></div></div><div class="top-actions"><button id="cancelJob" class="button danger hidden" type="button">Cancel task</button></div></header>
        <div class="workspace"><section id="approvalCard" class="approval hidden" role="alert" aria-live="assertive"><div class="approval-head"><span id="approvalTitle">Approval required</span><span id="approvalMeta" class="approval-meta"></span></div><div class="approval-task"><div id="approvalTaskLabel" class="approval-task-label">Approving task</div><div id="approvalIdentity" class="approval-identity"></div><div class="approval-task-meta"><span id="approvalTaskJob" class="approval-task-job"></span><span id="approvalTaskProvider"></span></div></div><div id="approvalDetail" class="approval-detail"></div><div id="approvalActions" class="approval-actions"></div></section><section id="conversation" class="conversation" aria-label="Conversation content"><div class="empty">Select a session on the left to view its content. New tasks are dispatched through the CrewDispatch MCP.</div></section><form id="composer" class="composer hidden"><textarea id="followupText" aria-label="Follow-up message" placeholder="Send a follow-up message to the same task…"></textarea><button id="sendFollowup" class="button primary" type="submit">Send</button><div class="tip">Ctrl/Cmd+Enter to send · Enter for a new line</div></form><div id="splitter" class="splitter" role="separator" aria-label="Resize the live activity panel" aria-orientation="horizontal" tabindex="0"></div><section id="live" class="live" aria-label="Live activity"><div class="live-head"><span>Live activity <span id="liveStatus" class="live-status">Idle</span></span><div class="live-controls"><label><input id="autoFollow" type="checkbox" checked> Auto-follow</label><label><input id="showReasoning" type="checkbox"> Show reasoning</label></div></div><div id="log" class="log"><div class="empty">No log entries yet</div></div></section></div>
        <div id="statusbar" class="statusbar" role="status">Ready</div>
      </div>
      <section id="settingsView" class="settings hidden" aria-label="Settings">
        <div class="settings-card">
          <div class="provider-picker">
            <label>Provider
              <select id="settingsProvider">
                <option value="command-code">Command Code</option>
                <option value="workbuddy-ai">WorkBuddy AI</option>
              </select>
            </label>
            <span class="settings-note" style="padding:7px 10px">Only the selected provider's configuration is shown below.</span>
          </div>
        </div>
        <div id="commandCodeSettingsCard" class="settings-card"><h2>Command Code settings</h2>
          <div id="cliInfo" class="settings-status hidden" role="status" aria-live="polite"></div>
          <div class="settings-grid">
            <label>Default model<select id="defaultModel"></select></label>
            <label>Default model reasoning<select id="defaultEffort"></select></label>
            <label>Rate-limit fallback<select id="fallbackModel"></select></label>
            <label>Fallback model reasoning<select id="fallbackEffort"></select></label>
            <div class="permission-row">
              <label for="permissionMode">Permission</label>
              <select id="permissionMode" aria-describedby="yoloWarning"></select>
              <div id="yoloWarning" class="permission-note hidden"></div>
            </div>
          </div>
          <div id="catalogInfo" class="settings-status hidden">Reading model catalog…</div>
          <div id="effectiveInfo" class="settings-status hidden"></div>
          <div id="modelIssues" class="settings-warning hidden" style="margin-top:10px"></div>
          <div class="settings-actions"><button id="saveSettings" class="button primary" type="button">Save settings</button><span id="settingsMessage" role="status"></span></div>
        </div>
        <div id="workBuddySettingsCard" class="settings-card hidden"><h2>WorkBuddy AI settings</h2>
          <div id="wbCliInfo" class="settings-status hidden" role="status" aria-live="polite"></div>
          <div class="settings-grid">
            <label>Default model<select id="wbDefaultModel"></select></label>
            <label>Default model reasoning<select id="wbDefaultEffort"></select></label>
            <label>Rate-limit fallback<select id="wbFallbackModel"></select></label>
            <label>Fallback model reasoning<select id="wbFallbackEffort"></select></label>
            <div class="permission-row">
              <label for="wbPermissionMode">Permission</label>
              <select id="wbPermissionMode" aria-describedby="wbYoloWarning"></select>
              <div id="wbYoloWarning" class="permission-note hidden"></div>
            </div>
          </div>
          <div id="wbCatalogInfo" class="settings-status hidden">Reading WorkBuddy AI model catalog…</div>
          <div id="wbEffectiveInfo" class="settings-status hidden"></div>
          <div id="wbModelIssues" class="settings-warning hidden" style="margin-top:10px"></div>
          <div class="settings-actions"><button id="wbSaveSettings" class="button primary" type="button">Save WorkBuddy AI settings</button><span id="wbSettingsMessage" role="status"></span></div>
        </div>
        <div class="settings-card"><h2>Sessions & logs</h2><p class="settings-subtitle">Global settings shared by all providers.</p><div class="settings-grid">
          <label>Sessions per page<select id="pageSize"><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="200">200</option><option value="0">Unlimited</option></select></label>
          <label>Keep logs for days (0 = unlimited)<input id="retentionDays" type="number" min="0" step="1"></label>
          <label>Log size limit in GB (0 = unlimited)<input id="retentionGb" type="number" min="0" step="0.01"></label>
        </div><p>Old logs are cleaned up only after a session has finished.</p>
          <div class="settings-actions"><button id="saveGlobal" class="button primary" type="button">Save</button><span id="globalMessage" role="status"></span></div>
        </div>
      </section>
    </main>
  </div>
  <script defer src="/ui/client.js"></script>
</body>
</html>`;
