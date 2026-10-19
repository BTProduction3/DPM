/* ==========================================================================
   Design tokens
   Corporate blue/amber theme matching the BIOTEK Planning Platform: deep-blue
   header bar, white left sidebar, very light blue-grey page, white cards with
   a soft shadow, amber for the "currently selected filter" state.

   Every colour used for text was checked for WCAG contrast against the
   surface it actually sits on, which is why the amber and green used for
   TEXT are darker than the amber and green used for stripes and borders:
     blue   #1d4ed8 on white  6.70:1      header bar white-on-#17418f 9.59:1
     red    #dc2626 on white  4.83:1      amber ink #b45309 on white  5.02:1
     green  #15803d on white  5.02:1      muted ink #566072 on page   5.29:1
   The lighter #d97706 / #16a34a are stripe-and-border only, never text.
   ========================================================================== */

:root {
  --bg: #f4f6fa;
  --surface: #ffffff;
  --surface-alt: #f7f9fc;
  --border: #e3e8ef;
  --border-strong: #d4dbe6;

  --text: #0f1b2d;
  --text-muted: #566072;
  --text-faint: #8a94a6;

  --accent: #1d4ed8;
  --accent-strong: #17418f;
  --accent-soft: #e8effb;

  --ok: #15803d;
  --ok-mark: #16a34a;
  --ok-soft: #e6f4ec;
  --warn: #b45309;
  --warn-mark: #d97706;
  --warn-soft: #fdf3e2;
  --danger: #dc2626;
  --danger-mark: #ef4444;
  --danger-soft: #fdeaea;
  --neutral: #566072;
  --neutral-soft: #eef1f6;

  /* The "this filter is on" treatment from the reference platform. */
  --pick-bg: #fdf4e3;
  --pick-border: #e2b84f;
  --pick-ink: #8a6212;

  --shadow: 0 1px 2px rgba(15, 27, 45, 0.05), 0 4px 14px rgba(15, 27, 45, 0.06);
  --shadow-sm: 0 1px 2px rgba(15, 27, 45, 0.06);
  --radius: 10px;
  --radius-sm: 7px;
  --sidebar-w: 236px;
  --topbar-h: 60px;
  --font-ui: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d1420;
    --surface: #141d2b;
    --surface-alt: #1a2434;
    --border: #27334a;
    --border-strong: #35435e;
    --text: #e8edf5;
    --text-muted: #a3b0c2;
    --text-faint: #74839a;
    --accent: #6f9bff;
    --accent-strong: #9dbcff;
    --accent-soft: #1b2c4d;
    --ok: #5cc98d;
    --ok-mark: #4fae81;
    --ok-soft: #14301f;
    --warn: #e0ad5c;
    --warn-mark: #d6a44b;
    --warn-soft: #362a14;
    --danger: #f08b82;
    --danger-mark: #dd6d62;
    --danger-soft: #3a1f1d;
    --neutral: #a3b0c2;
    --neutral-soft: #202b3d;
    --pick-bg: #33290f;
    --pick-border: #8a6f2a;
    --pick-ink: #e8c877;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 14px rgba(0, 0, 0, 0.28);
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  }
}

* {
  box-sizing: border-box;
}
html,
body {
  padding: 0;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
h1,
h2,
h3,
h4 {
  margin: 0;
}
a {
  color: inherit;
}
table {
  border-collapse: collapse;
}
.tabular {
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

/* ============================ application shell ========================== */

.app-shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  min-height: 100vh;
}

.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 18px 18px 20px;
}
.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--accent-strong);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 15px;
  flex: none;
}
.brand-name {
  display: block;
  font-weight: 700;
  font-size: 14.5px;
  letter-spacing: 0.01em;
  line-height: 1.2;
  white-space: nowrap;
}
.brand-sub {
  display: block;
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.3;
  white-space: nowrap;
}

.sidebar-section {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: 14px 18px 7px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 18px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  border-left: 3px solid transparent;
}
.nav-item:hover {
  background: var(--surface-alt);
  color: var(--text);
}
.nav-item.active {
  background: var(--accent-soft);
  border-left-color: var(--accent);
  color: var(--accent-strong);
  font-weight: 600;
}
.nav-item svg {
  width: 17px;
  height: 17px;
  flex: none;
  stroke-width: 1.7;
}
.nav-badge {
  margin-left: auto;
  background: var(--neutral-soft);
  color: var(--text-muted);
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  font-variant-numeric: tabular-nums;
}
.nav-item.active .nav-badge {
  background: #fff;
  color: var(--accent-strong);
}

.sidebar-foot {
  margin-top: auto;
  padding: 16px 18px 18px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-faint);
}
.sidebar-foot strong {
  color: var(--text-muted);
}

.topbar {
  background: var(--accent-strong);
  color: #fff;
  min-height: var(--topbar-h);
  padding: 11px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  position: sticky;
  top: 0;
  z-index: 20;
}
.topbar-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.topbar-tag {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.72);
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar-user {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: right;
}
.topbar-user .who {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
}
.topbar-user .role {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.72);
  line-height: 1.25;
}
.topbar-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex: none;
}
.topbar-btn {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.32);
  background: transparent;
  color: #fff;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.topbar-btn:hover {
  background: rgba(255, 255, 255, 0.13);
}

/* Search lives in the topbar so it is reachable from every screen. It is a
   plain GET form: it works with JavaScript disabled and the results page is
   a normal, linkable URL. */
.topbar-search input {
  font-family: var(--font-ui);
  font-size: 12.5px;
  width: 230px;
  max-width: 34vw;
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.32);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.topbar-search input::placeholder {
  color: rgba(255, 255, 255, 0.66);
}
.topbar-search input:focus {
  outline: 2px solid rgba(255, 255, 255, 0.75);
  outline-offset: -1px;
  background: rgba(255, 255, 255, 0.2);
}

.topbar-btn.bell {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 6px 9px;
}
/* The count sits on the bell rather than beside it, so the topbar layout
   doesn't shift every time a notification arrives. */
.bell-count {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--danger);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
}

.content {
  padding: 24px;
  max-width: 1480px;
  margin: 0 auto;
  width: 100%;
}

/* On a phone or a narrow window the sidebar becomes a compact scrolling strip
   above the content, instead of a full-height column you'd have to scroll past
   before reaching the page itself. */
@media (max-width: 900px) {
  .app-shell {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-brand {
    padding: 12px 16px;
  }
  .sidebar nav {
    display: flex;
    overflow-x: auto;
    border-top: 1px solid var(--border);
    scrollbar-width: none;
  }
  .sidebar nav::-webkit-scrollbar {
    display: none;
  }
  .sidebar nav > div {
    display: flex;
  }
  /* Two classes, so this beats the `.sidebar nav > div` rule above whether the
     label is a direct child of nav or nested inside a section wrapper. */
  .sidebar nav .sidebar-section {
    display: none;
  }
  .nav-item {
    border-left: none;
    border-bottom: 3px solid transparent;
    padding: 11px 14px;
    white-space: nowrap;
  }
  .nav-item.active {
    border-left: none;
    border-bottom-color: var(--accent);
  }
  .sidebar-foot {
    display: none;
  }
  .content {
    padding: 16px;
  }
}

/* ================================ surfaces =============================== */

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
}
.panel {
  padding: 16px;
}
.panel h3 {
  font-size: 12.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 700;
  margin-bottom: 12px;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.eyebrow {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  font-weight: 700;
  margin-bottom: 6px;
}
.screen-title {
  font-size: 23px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 3px;
}
.screen-sub {
  color: var(--text-muted);
  font-size: 13px;
  margin-bottom: 20px;
  margin-top: 0;
}

/* =============================== stat tiles ============================== */

/* Four across on a wide screen, so eight tiles land as two even rows rather
   than seven-plus-a-stranded-one. Narrower screens fall back to auto-fit. */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
@media (min-width: 1100px) {
  .kpi-row {
    grid-template-columns: repeat(4, 1fr);
  }
}
.kpi {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--neutral);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  padding: 13px 15px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kpi-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
}
.kpi-value {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  color: var(--text);
}
.kpi-sub {
  font-size: 11px;
  color: var(--text-faint);
}
.kpi.blue {
  border-left-color: var(--accent);
}
.kpi.blue .kpi-value {
  color: var(--accent);
}
.kpi.green {
  border-left-color: var(--ok-mark);
}
.kpi.green .kpi-value {
  color: var(--ok);
}
.kpi.amber {
  border-left-color: var(--warn-mark);
}
.kpi.amber .kpi-value {
  color: var(--warn);
}
.kpi.red {
  border-left-color: var(--danger-mark);
}
.kpi.red .kpi-value {
  color: var(--danger);
}

/* ===================== toolbar / segmented filter group ================== */

.toolbar {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  padding: 14px 16px;
  margin-bottom: 16px;
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  align-items: flex-end;
}
.toolbar-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.toolbar-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
}
.toolbar-spacer {
  margin-left: auto;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface);
}
.seg > * {
  font-family: var(--font-ui);
  font-size: 12.5px;
  font-weight: 500;
  padding: 7px 13px;
  color: var(--text-muted);
  text-decoration: none;
  background: transparent;
  border: none;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
}
.seg > *:last-child {
  border-right: none;
}
.seg > *:hover {
  background: var(--surface-alt);
  color: var(--text);
}
.seg > .active {
  background: var(--pick-bg);
  color: var(--pick-ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--pick-border);
}

/* ================================= chips ================================= */

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 99px;
  line-height: 1.5;
  white-space: nowrap;
}
.chip::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.chip.ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.chip.warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.chip.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.chip.neutral {
  background: var(--neutral-soft);
  color: var(--neutral);
}
.chip.accent {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* ============================== progress bar ============================= */

.pbar {
  height: 6px;
  border-radius: 99px;
  background: var(--neutral-soft);
  overflow: hidden;
  min-width: 64px;
}
.pbar > span {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 99px;
}
.pbar.ok > span {
  background: var(--ok-mark);
}
.pbar.warn > span {
  background: var(--warn-mark);
}
.pbar.danger > span {
  background: var(--danger-mark);
}

/* ================================ controls =============================== */

.btn {
  font-family: var(--font-ui);
  font-size: 12.5px;
  font-weight: 500;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
.btn:hover {
  background: var(--surface-alt);
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
.btn.primary:hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}
.btn.danger {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

select,
input[type="text"],
input[type="password"],
input[type="email"],
input[type="date"],
input[type="number"],
textarea {
  font-family: var(--font-ui);
  font-size: 13px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  width: 100%;
}
select {
  width: auto;
}
textarea {
  min-height: 80px;
  resize: vertical;
}
label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
  display: block;
  margin-bottom: 5px;
}
.field {
  margin-bottom: 14px;
}
.field-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.form-error {
  color: var(--danger);
  font-size: 11.5px;
  margin-top: 4px;
}
.form-banner {
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
}
.form-banner.error {
  background: var(--danger-soft);
  color: var(--danger);
}
.form-banner.success {
  background: var(--ok-soft);
  color: var(--ok);
}

/* ================================= tables ================================ */

table.grid {
  width: 100%;
  font-size: 12.5px;
}
table.grid th {
  text-align: left;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  font-weight: 700;
  padding: 0 10px 9px;
  border-bottom: 1px solid var(--border-strong);
  white-space: nowrap;
}
table.grid td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
table.grid tr:last-child td {
  border-bottom: none;
}
table.grid tr:hover td {
  background: var(--surface-alt);
}

.avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  margin-right: 6px;
  flex: none;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.proj-id {
  color: var(--text-faint);
  font-size: 11px;
}

/* ============================== auth screens ============================= */

.auth-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* A single branded blue field with a little depth — no hard diagonal edge,
     which read as a mistake rather than a decision. */
  background: radial-gradient(1200px 620px at 50% -12%, #235fc0 0%, var(--accent-strong) 55%, #102f68 100%);
}
.auth-card {
  width: 100%;
  max-width: 380px;
  padding: 28px;
}
