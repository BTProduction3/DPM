// DPM frontend — plain JavaScript, no build step.
// All data comes from one "load" call; completion %, health and overdue are worked out here.
"use strict";

// ---------- basics ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = $("#app");

let S = null; // everything from the server's "load"
let flash = null; // one-time banner shown at the top of the next screen
let timers = [];
let renderToken = 0;

async function api(action, data = {}) {
  const res = await fetch("/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const out = await res.json().catch(() => ({ error: "The server didn't answer properly. Try again." }));
  if (out.signedOut) {
    S = null;
    boot();
  }
  if (out.mustChange) location.hash = "#/change-password";
  if (!res.ok || out.error) throw new Error(out.error || "Request failed.");
  return out;
}

// ---------- dates & numbers ----------
const fmtDate = (d, withYear = true) =>
  d
    ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", ...(withYear ? { year: "2-digit" } : {}), timeZone: "UTC" }).format(
        new Date(d + "T00:00:00Z"),
      )
    : "—";
const fmtWhen = (iso) =>
  new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const addDays = (d, n) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const dayMs = (d) => Date.parse(d + "T00:00:00Z");
const dayDiff = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 864e5);
const round2 = (n) => Math.round(n * 100) / 100;
const hours = (m) => {
  if (!m) return "0h";
  const h = Math.floor(m / 60), r = m % 60;
  return h === 0 ? `${r}m` : r === 0 ? `${h}h` : `${h}h ${r}m`;
};
const humanize = (v) => String(v).toLowerCase().split("_").map((w) => (w[0] || "").toUpperCase() + w.slice(1)).join(" ");
const initials = (n) => String(n || "").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- indexes and calculations ----------
let byUser, byProject, byTask, tasksByProject, subsByTask;
function index() {
  byUser = new Map(S.users.map((u) => [u.id, u]));
  byProject = new Map(S.projects.map((p) => [p.id, p]));
  byTask = new Map(S.tasks.map((t) => [t.id, t]));
  tasksByProject = new Map();
  for (const t of S.tasks) tasksByProject.set(t.project_id, [...(tasksByProject.get(t.project_id) || []), t]);
  subsByTask = new Map();
  for (const s of S.subtasks) subsByTask.set(s.task_id, [...(subsByTask.get(s.task_id) || []), s]);
}
const rules = () => S.settings.rules || { atRiskThresholdDays: 3, overdueGraceDays: 0, defaultTaskWeight: 1 };
const userName = (id) => byUser.get(id)?.name ?? "—";
const tasksOf = (pid) => tasksByProject.get(pid) || [];
const subsOf = (tid) => subsByTask.get(tid) || [];
const liveProjects = () => S.projects.filter((p) => !p.is_template);
const liveTasks = () => S.tasks.filter((t) => !byProject.get(t.project_id)?.is_template);
const isOpen = (t) => !["COMPLETED", "CANCELLED"].includes(t.status);
const isOverdue = (t) => isOpen(t) && t.target_date < addDays(S.today, -Number(rules().overdueGraceDays || 0));
function weighted(items) {
  const total = items.reduce((s, i) => s + Number(i.w), 0);
  if (!items.length || !(total > 0)) return 0;
  return Math.max(0, Math.min(100, items.reduce((s, i) => s + Number(i.c) * Number(i.w), 0) / total));
}
const taskPct = (t) => {
  const subs = subsOf(t.id);
  return round2(subs.length ? weighted(subs.map((s) => ({ c: s.completion, w: s.weight }))) : Number(t.completion));
};
const projectPct = (p) => round2(weighted(tasksOf(p.id).map((t) => ({ c: taskPct(t), w: t.weight }))));
function health(p) {
  if (p.status === "COMPLETED") return "COMPLETED";
  if (tasksOf(p.id).some(isOverdue) || p.target_date < S.today) return "DELAYED";
  if (dayDiff(S.today, p.target_date) <= Number(rules().atRiskThresholdDays)) return "AT_RISK";
  return "ON_TRACK";
}
const activeList = (key) => (S.settings[key] || []).filter((x) => x.active).map((x) => x.name);
const activeStages = () => (S.settings.stages || []).filter((s) => s.active).sort((a, b) => a.seq - b.seq);
const activeUsers = () => S.users.filter((u) => u.active);

// ---------- permissions (same rules as the server) ----------
const has = (res, act, scope) => S.me.grants.includes(`${res}:${act}:${scope}`);
const canAdmin = (act) => has("ADMIN", act, "ALL");
const canCreate = (res) => has(res, "CREATE", "ALL");
function canProject(act, p) {
  if (has("PROJECT", act, "ALL")) return true;
  if (p.pm_id === S.me.id && has("PROJECT", act, "OWN")) return true;
  if (act === "VIEW" && S.me.department && has("PROJECT", "VIEW", "DEPARTMENT") && tasksOf(p.id).some((t) => t.department === S.me.department))
    return true;
  return false;
}
function canTask(act, t, p) {
  if (has("TASK", act, "ALL")) return true;
  if (p.pm_id === S.me.id && has("TASK", act, "OWN")) return true;
  if (t.owner_id === S.me.id && has("TASK", act, "OWN")) return true;
  if (t.department && t.department === S.me.department && has("TASK", act, "DEPARTMENT")) return true;
  return false;
}

// ---------- small UI pieces ----------
const TONE = {
  ON_TRACK: "ok", AT_RISK: "warn", DELAYED: "danger", COMPLETED: "neutral", PLANNED: "accent", ACTIVE: "accent",
  ON_HOLD: "neutral", CANCELLED: "neutral", NOT_STARTED: "neutral", IN_PROGRESS: "accent", CRITICAL: "danger",
  HIGH: "warn", MEDIUM: "accent", LOW: "neutral",
};
const chip = (v, label) => `<span class="chip ${TONE[v] ?? "neutral"}">${esc(label ?? humanize(v))}</span>`;
const pbar = (v) => {
  const c = Math.max(0, Math.min(100, Number(v) || 0));
  return `<div class="pct-cell" style="display:flex;align-items:center;gap:8px"><div class="pbar"><span style="width:${c}%"></span></div><span class="tabular" style="font-size:11.5px;color:var(--text-muted);min-width:30px">${c}%</span></div>`;
};
const options = (list, selected, blank) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : "") +
  list
    .map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${String(v) === String(selected ?? "") ? " selected" : ""}>${esc(l)}</option>`;
    })
    .join("");
const userOptions = (sel, blank = "Select") =>
  `<option value="" disabled${sel ? "" : " selected"}>${esc(blank)}</option>` + options(activeUsers().map((u) => [u.id, u.name]), sel);
const STATUS_OPTS = [["NOT_STARTED", "Not Started"], ["IN_PROGRESS", "In Progress"], ["ON_HOLD", "On Hold"], ["COMPLETED", "Completed"], ["CANCELLED", "Cancelled"], ["DELAYED", "Delayed"]];
const PRIORITY_OPTS = [["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"], ["CRITICAL", "Critical"]];
const PSTATUS_OPTS = [["PLANNED", "Planned"], ["ACTIVE", "Active"], ["ON_HOLD", "On Hold"], ["COMPLETED", "Completed"], ["CANCELLED", "Cancelled"]];
const faint = (t, extra = "") => `<p style="font-size:11px;color:var(--text-faint);${extra}">${t}</p>`;
const banner = (cls = "") => `<div class="form-banner ${cls}" data-banner hidden></div>`;
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-faint);padding:24px">${text}</td></tr>`;
const header = (eyebrow, title, sub) =>
  `<div class="eyebrow">${esc(eyebrow)}</div><h2 class="screen-title">${title}</h2>${sub ? `<p class="screen-sub">${sub}</p>` : ""}`;
const projLink = (p) =>
  `<a href="#/projects/${p.id}/overview" style="text-decoration:none"><div class="stack"><span style="font-weight:600">${esc(p.name)}</span><span class="proj-id">${esc(p.number)}</span></div></a>`;
const noAccess = (what) => `<div class="card panel"><p>You don’t have permission to ${what}.</p></div>`;

const ICON = (() => {
  const b = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  return {
    dashboard: `<svg ${b}><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
    projects: `<svg ${b}><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>`,
    tasks: `<svg ${b}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1.2 1.2L7.5 4.8M4 12l1.2 1.2L7.5 10.8M4 18l1.2 1.2L7.5 16.8"/></svg>`,
    gantt: `<svg ${b}><path d="M4 6h9M7 12h11M4 18h7"/><path d="M3 3v18" opacity="0.45"/></svg>`,
    chat: `<svg ${b}><path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-4.5A7 7 0 0 1 8 5h5a7 7 0 0 1 7 7z"/></svg>`,
    reports: `<svg ${b}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 14h6M9 17h4"/></svg>`,
    admin: `<svg ${b}><circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>`,
    recycle: `<svg ${b}><path d="M4 13a8 8 0 0 1 8-8h1.5"/><path d="M12.5 3 15 5.5 12.5 8"/><path d="M20 11a8 8 0 0 1-8 8h-1.5"/><path d="M11.5 21 9 18.5 11.5 16"/></svg>`,
    template: `<svg ${b}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9.5 9v11"/></svg>`,
  };
})();

// ---------- routing ----------
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "") || "dashboard";
  const [path, query = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), path: "/" + path, query: new URLSearchParams(query), queryString: query };
}

function shell(r) {
  const myOpen = liveTasks().filter((t) => t.owner_id === S.me.id && isOpen(t)).length;
  const sections = [
    ["Workspace", [["/dashboard", "Dashboard", ICON.dashboard], ["/recycle-bin", "Recycle Bin", ICON.recycle]]],
    ["Planning", [
      ["/projects", "Projects", ICON.projects], ["/my-tasks", "My Tasks", ICON.tasks, myOpen], ["/gantt", "Gantt Chart", ICON.gantt],
      ["/projects/templates", "Templates", ICON.template], ["/chat", "Chat", ICON.chat], ["/reports", "Reports", ICON.reports],
    ]],
  ];
  if (canAdmin("VIEW")) sections.push(["Setup", [["/admin/users", "Administration", ICON.admin]]]);
  const activeHref = (href) => {
    if (href === "/projects") return r.path === "/projects" || (r.path.startsWith("/projects/") && !r.path.startsWith("/projects/templates"));
    if (href === "/admin/users") return r.path.startsWith("/admin");
    return r.path === href || r.path.startsWith(href + "/");
  };
  const nav = sections
    .map(([title, items]) =>
      `<div><div class="sidebar-section">${title}</div>${items
        .map(([href, label, icon, badge]) =>
          `<a href="#${href}" class="nav-item${activeHref(href) ? " active" : ""}">${icon}<span>${label}</span>${badge > 0 ? `<span class="nav-badge">${badge}</span>` : ""}</a>`)
        .join("")}</div>`)
    .join("");
  const me = S.me;
  return `<div class="app-shell">
  <aside class="sidebar">
    <div class="sidebar-brand"><span class="brand-mark">DP</span><span><span class="brand-name">DESIGN &amp; DEV</span><span class="brand-sub">Project Management</span></span></div>
    <nav>${nav}</nav>
    <div class="sidebar-foot">Signed in as <strong>${esc(me.loginId)}</strong><br>${esc(me.role)}${me.department ? ` · ${esc(me.department)}` : ""}<br><br>Phase 1 · Design &amp; Development<br>Project Management Application</div>
  </aside>
  <div>
    <header class="topbar">
      <div><div class="topbar-title">Design &amp; Development Project Management</div><div class="topbar-tag">Projects · Tasks · Scheduling · Team Collaboration</div></div>
      <div class="topbar-right">
        <form class="topbar-search" role="search" data-form="search"><input type="search" name="q" placeholder="Search projects, tasks, people…" aria-label="Search"></form>
        <a href="#/notifications" class="topbar-btn bell" aria-label="Notifications"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.7 21a2 2 0 0 1-3.4 0" stroke-linecap="round" stroke-linejoin="round"/></svg>${S.unread > 0 ? `<span class="bell-count">${S.unread > 99 ? "99+" : S.unread}</span>` : ""}</a>
        <a href="#/change-password" class="topbar-btn">Password</a>
        <button type="button" class="topbar-btn" data-click="signOut">Sign out</button>
        <div class="topbar-user"><div><div class="who">${esc(me.name)}</div><div class="role">${esc(me.role)}</div></div><span class="topbar-avatar">${initials(me.name)}</span></div>
      </div>
    </header>
    <main class="content" id="main"><p style="color:var(--text-faint)">Loading…</p></main>
  </div>
</div>`;
}

async function render() {
  timers.forEach(clearInterval);
  timers = [];
  if (!S) return;
  const token = ++renderToken;
  const r = parseRoute();
  if (r.path === "/change-password" && S.me.mustChangePassword) return authScreen("change");
  app.innerHTML = shell(r);
  const main = $("#main");
  try {
    const html = await view(r);
    if (token !== renderToken) return;
    main.innerHTML = (flash ? `<div class="form-banner ${flash.error ? "error" : "success"}">${esc(flash.text)}</div>` : "") + html;
    flash = null;
    afterRender(main);
  } catch (e) {
    if (token === renderToken) main.innerHTML = `<div class="card panel"><div class="form-banner error">${esc(e.message)}</div></div>`;
  }
}

// Fetch fresh data, then show `hash` (or the current screen) with an optional message on top.
async function reload(message, hash) {
  S = await api("load");
  index();
  if (message) flash = { text: message };
  if (hash && location.hash !== hash) location.hash = hash; // the hashchange event renders
  else await render();
}

// ---------- views ----------
async function view(r) {
  const [a, b, c, d] = r.parts;
  if (a === "dashboard") return dashboardView(r);
  if (a === "projects" && !b) return projectsView();
  if (a === "projects" && b === "new") return newProjectView();
  if (a === "projects" && b === "templates") return templatesView();
  if (a === "projects" && b) return projectView(r, b, c || "overview", d);
  if (a === "my-tasks") return myTasksView();
  if (a === "gantt") return ganttListView();
  if (a === "chat") return teamChatView();
  if (a === "reports") return reportsView();
  if (a === "notifications") return notificationsView();
  if (a === "search") return searchView(r);
  if (a === "recycle-bin") return recycleView();
  if (a === "change-password") return changePasswordView();
  if (a === "admin") return adminView(r, b || "users", c);
  return `<div class="card panel"><p>That page doesn’t exist. <a href="#/dashboard">Go to the dashboard</a>.</p></div>`;
}

function kpi(label, value, tone, sub) {
  return `<div class="kpi ${tone}"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub}</span></div>`;
}

function dashboardView(r) {
  const f = { pm: r.query.get("pm") || "", department: r.query.get("department") || "", status: r.query.get("status") || "", priority: r.query.get("priority") || "" };
  const all = liveProjects();
  const tasks = liveTasks();
  let projects = all;
  if (f.pm) projects = projects.filter((p) => p.pm_id === f.pm);
  if (f.status) projects = projects.filter((p) => p.status === f.status);
  if (f.priority) projects = projects.filter((p) => p.priority === f.priority);
  if (f.department) projects = projects.filter((p) => tasksOf(p.id).some((t) => t.department === f.department));
  projects = projects.slice(0, 100);
  const pms = [...new Set(S.projects.map((p) => p.pm_id))].map((id) => [id, userName(id)]);
  const depts = activeList("departments");
  const open = tasks.filter(isOpen);
  const dueWeek = open.filter((t) => t.target_date >= S.today && t.target_date <= addDays(S.today, 6)).length;
  const rows = projects
    .map((p) => {
      const ts = tasksOf(p.id);
      return `<tr><td>${projLink(p)}</td><td><span class="avatar">${initials(userName(p.pm_id))}</span>${esc(userName(p.pm_id))}</td>
        <td>${chip(p.status)}</td><td class="tabular">${fmtDate(p.target_date)}</td><td>${pbar(projectPct(p))}</td><td>${chip(p.priority)}</td>
        <td>${esc(p.stage ?? "—")}</td><td>${chip(health(p))}</td>
        <td class="tabular">${ts.filter(isOpen).length} / ${ts.filter((t) => t.status === "COMPLETED").length} / ${ts.filter(isOverdue).length}</td></tr>`;
    })
    .join("");
  return `${header("Main Dashboard", "Overview", `${all.length} projects across ${depts.length} departments`)}
  <div class="kpi-row">
    ${kpi("Total Projects", all.length, "blue", "all projects on record")}
    ${kpi("Active", all.filter((p) => p.status === "ACTIVE").length, "blue", "currently in progress")}
    ${kpi("Completed", all.filter((p) => p.status === "COMPLETED").length, "green", "closed out")}
    ${kpi("Delayed", all.filter((p) => health(p) === "DELAYED").length, "red", "past target date")}
    ${kpi("At Risk", all.filter((p) => health(p) === "AT_RISK").length, "amber", "approaching target")}
    ${kpi("Open Tasks", open.length, "blue", "not yet completed")}
    ${kpi("Overdue Tasks", tasks.filter(isOverdue).length, "red", "past their due date")}
    ${kpi("Due This Week", dueWeek, "amber", "next 7 days")}
  </div>
  <form class="toolbar" data-form="filter" data-base="#/dashboard">
    <div class="toolbar-group"><span class="toolbar-label">Project manager</span><select name="pm">${options(pms, f.pm, "All")}</select></div>
    <div class="toolbar-group"><span class="toolbar-label">Department</span><select name="department">${options(depts, f.department, "All")}</select></div>
    <div class="toolbar-group"><span class="toolbar-label">Status</span><select name="status">${options(PSTATUS_OPTS.map(([v]) => v), f.status, "All")}</select></div>
    <div class="toolbar-group"><span class="toolbar-label">Priority</span><select name="priority">${options(PRIORITY_OPTS.map(([v]) => v), f.priority, "All")}</select></div>
    <div class="toolbar-group"><span class="toolbar-label">&nbsp;</span><div style="display:flex;gap:8px"><button type="submit" class="btn">Apply</button><a href="#/dashboard" class="btn">Reset</a></div></div>
    <div class="toolbar-group toolbar-spacer"><span class="toolbar-label">&nbsp;</span><a href="#/projects/new" class="btn primary">+ New project</a></div>
  </form>
  <div class="card panel" style="overflow-x:auto"><h3>All Projects</h3>
    <table class="grid"><thead><tr><th>Project</th><th>PM</th><th>Status</th><th>Target</th><th>Completion</th><th>Priority</th><th>Stage</th><th>Health</th><th>Tasks (Open/Done/Overdue)</th></tr></thead>
    <tbody>${rows || emptyRow(9, "No projects match these filters.")}</tbody></table></div>`;
}

function projectsView() {
  const projects = [...liveProjects()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const rows = projects
    .map((p) => `<tr><td>${projLink(p)}</td><td>${esc(userName(p.pm_id))}</td><td>${chip(p.status)}</td><td>${chip(p.priority)}</td>
      <td>${pbar(projectPct(p))}</td><td class="tabular">${fmtDate(p.start_date)}</td><td class="tabular">${fmtDate(p.target_date)}</td></tr>`)
    .join("");
  return `${header("Project Management", "Projects", "Create and manage design &amp; development projects.")}
  <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap">
    <a href="#/projects/new" class="btn primary">+ New project</a><a href="#/projects/templates" class="btn">Start from a template</a>
    <button type="button" class="btn" style="margin-left:auto" data-click="exportProjects">Export CSV</button>
  </div>
  <div class="card panel" style="overflow-x:auto"><table class="grid"><thead><tr><th>Project</th><th>PM</th><th>Status</th><th>Priority</th><th>Completion</th><th>Start</th><th>Target</th></tr></thead>
  <tbody>${rows || emptyRow(7, `No projects yet. <a href="#/projects/new">Create the first one</a>.`)}</tbody></table></div>`;
}

function newProjectView() {
  return `${header("Project Management", "New project")}
  <div class="card panel" style="max-width:760px"><form data-form="createProject">${banner("error")}
    <div class="field-row"><div class="field"><label>Project name</label><input name="name" required></div>
      <div class="field"><label>Project ID</label><input name="number" placeholder="DPM-2026-001" required></div></div>
    <div class="field"><label>Description</label><textarea name="description"></textarea></div>
    <div class="field-row"><div class="field"><label>Customer / Product</label><input name="customer"></div>
      <div class="field"><label>Project Manager</label><select name="pmId" required>${userOptions("", "Select a project manager")}</select></div></div>
    <div class="field-row"><div class="field"><label>Start date</label><input name="startDate" type="date" required></div>
      <div class="field"><label>Target completion date</label><input name="targetDate" type="date" required></div></div>
    <div class="field-row"><div class="field"><label>Priority</label><select name="priority">${options(PRIORITY_OPTS, "MEDIUM")}</select></div>
      <div class="field"><label>Status</label><select name="status">${options(PSTATUS_OPTS.slice(0, 3), "PLANNED")}</select></div></div>
    <div class="field"><label>Remarks</label><textarea name="remarks"></textarea></div>
    <button type="submit" class="btn primary" data-busy="Creating…">Create project</button>
  </form></div>`;
}

// ----- project detail -----
async function projectView(r, id, tab, sub) {
  const p = byProject.get(id);
  if (!p) return `<div class="card panel"><p>That project doesn’t exist (it may have been deleted).</p></div>`;
  if (!canProject("VIEW", p)) return noAccess("view this project");
  const stages = activeStages();
  const cur = stages.findIndex((s) => s.name === p.stage);
  const pct = projectPct(p);
  const tabs = [["overview", "Overview"], ["tasks", "Tasks"], ["board", "Board"], ["gantt", "Gantt"], ["discussion", "Discussion"], ["documents", "Documents"], ["activity", "Activity Log"]];
  const meta = (label, v) => `<div><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint);font-weight:600">${label}</div><div style="font-size:13px;margin-top:2px">${v}</div></div>`;
  let body;
  if (tab === "overview") body = overviewTab(p);
  else if (tab === "tasks" && sub === "new") body = taskFormCard(p, null);
  else if (tab === "tasks" && sub) body = await taskDetail(p, sub);
  else if (tab === "tasks") body = tasksTab(p, r);
  else if (tab === "board") body = boardTab(p);
  else if (tab === "gantt") body = ganttTab(p);
  else if (tab === "discussion") body = chatPanel({ projectId: p.id }, "Project discussion", `Anyone who can view ${esc(p.name)} can read and post here. Type @ and someone's User ID to notify them.`, 460);
  else if (tab === "documents") body = await documentsTab(p);
  else if (tab === "activity") body = await activityTab(p);
  else body = "";
  return `<div class="eyebrow">Project Detail</div>
  <div class="card" style="padding:18px 20px;margin-bottom:16px;display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap">
    <div style="flex:1;min-width:260px">
      <div class="tabular" style="font-size:12px;color:var(--text-faint);margin-bottom:4px">${esc(p.number)}</div>
      <h2 style="font-size:19px">${esc(p.name)}</h2>
      <div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:10px">${meta("Status", chip(p.status))}${meta("Project Manager", esc(userName(p.pm_id)))}${meta("Target Date", fmtDate(p.target_date))}${meta("Priority", chip(p.priority))}${meta("Health", chip(health(p)))}</div>
      ${p.stage && stages.length ? `<div style="display:flex;gap:3px;margin-top:14px">${stages.map((s, i) => `<div style="height:6px;flex:1;border-radius:3px;background:${i < cur ? "var(--ok)" : i === cur ? "var(--accent)" : "var(--surface-alt)"}"></div>`).join("")}</div>
      <div style="margin-top:6px;font-size:11px;color:var(--text-faint)">Stage ${cur + 1} of ${stages.length} — ${esc(p.stage)}</div>` : ""}
    </div>
    <svg width="64" height="64" viewBox="0 0 64 64" aria-label="${Math.round(pct)}% complete"><circle cx="32" cy="32" r="27" fill="none" stroke="var(--surface-alt)" stroke-width="7"/>
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--ok)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(pct / 100) * 169.6} 169.6" transform="rotate(-90 32 32)"/>
      <text x="32" y="37" text-anchor="middle" font-family="IBM Plex Mono" font-weight="600" font-size="15" fill="var(--text)">${Math.round(pct)}%</text></svg>
  </div>
  <div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:16px;overflow-x:auto">
    ${tabs.map(([k, l]) => `<a href="#/projects/${p.id}/${k}" style="font-size:12.5px;font-weight:${k === tab ? 700 : 500};color:${k === tab ? "var(--accent)" : "var(--text-muted)"};padding:10px 14px;text-decoration:none;white-space:nowrap;${k === tab ? "border-bottom:2px solid var(--accent);" : ""}">${l}</a>`).join("")}
  </div>${body}`;
}

function overviewTab(p) {
  const dl = (k, v, extra = "") => `<dt style="color:var(--text-muted)">${k}</dt><dd style="margin:0;${extra}">${v}</dd>`;
  const taskCount = tasksOf(p.id).length;
  return `<div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
    <div class="card panel"><h3>Project information</h3><dl style="display:grid;grid-template-columns:160px 1fr;row-gap:12px;font-size:13px;margin:0">
      ${dl("Customer / Product", esc(p.customer ?? "—"))}${dl("Description", esc(p.description ?? "—"), "white-space:pre-wrap")}
      ${dl("Start date", fmtDate(p.start_date))}${dl("Target completion", fmtDate(p.target_date))}${dl("Actual completion", fmtDate(p.actual_date))}
      ${dl("Remarks", esc(p.remarks ?? "—"), "white-space:pre-wrap")}</dl></div>
    <div class="card panel"><h3>Update status</h3>
      <form data-form="projectStatus" data-project-id="${p.id}" data-version="${p.version}">${banner("error")}
        <div class="field"><label>Project status</label><select name="status">${options(PSTATUS_OPTS, p.status)}</select></div>
        <button type="submit" class="btn primary">Save</button></form>
      ${canAdmin("EDIT") ? `<div style="border-top:1px solid var(--border);margin-top:16px;padding-top:14px"><h3>Project dates</h3>
        <form data-form="projectDates" data-project-id="${p.id}" data-version="${p.version}">${banner("error")}
          <div class="field"><label>Start date</label><input name="startDate" type="date" required value="${p.start_date}"></div>
          <div class="field"><label>Target completion</label><input name="targetDate" type="date" required value="${p.target_date}"></div>
          <div class="field"><label>Reason for change (optional)</label><input name="reason" placeholder="e.g. customer moved delivery"></div>
          <button type="submit" class="btn primary">Save dates</button></form></div>` : ""}
      ${!p.is_template ? `<div style="border-top:1px solid var(--border);margin-top:16px;padding-top:14px">
        <button type="button" class="btn" data-click="toggle" data-target="#tpl-form">Save as template</button>
        <form id="tpl-form" hidden data-form="saveTemplate" data-project-id="${p.id}" style="margin-top:12px">${banner("error")}
          <div class="field"><label>Template name</label><input name="name" required value="${esc(p.name)} (template)"></div>
          <div class="field"><label>Template ID</label><input name="number" required value="TPL-${esc(p.number)}"></div>
          <button type="submit" class="btn primary">Save ${plural(taskCount, "task")} as a template</button>
          ${faint("This project is not changed. The copy keeps the tasks, owners, departments, weights, planned effort and dependencies, and drops all progress — it becomes the starting shape for the next project of this kind.", "margin-top:9px;margin-bottom:0")}
        </form></div>` : ""}
    </div></div>`;
}

function tasksTab(p, r) {
  const f = { q: r.query.get("q") || "", status: r.query.get("status") || "", priority: r.query.get("priority") || "", owner: r.query.get("owner") || "", department: r.query.get("department") || "", overdue: r.query.get("overdue") || "" };
  const all = tasksOf(p.id);
  let tasks = all;
  if (f.status) tasks = tasks.filter((t) => t.status === f.status);
  if (f.priority) tasks = tasks.filter((t) => t.priority === f.priority);
  if (f.owner) tasks = tasks.filter((t) => t.owner_id === f.owner);
  if (f.department) tasks = tasks.filter((t) => (f.department === "none" ? !t.department : t.department === f.department));
  if (f.overdue === "1") tasks = tasks.filter(isOverdue);
  if (f.q) tasks = tasks.filter((t) => t.name.toLowerCase().includes(f.q.toLowerCase()));
  const canEdit = canProject("EDIT", p);
  const canDelete = canTask("DELETE", { owner_id: "", department: null }, p);
  const base = `#/projects/${p.id}/tasks`;
  const currentQuery = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const views = (S.settings.views || []).filter((v) => v.scope === "project-tasks").sort((a, b) => a.name.localeCompare(b.name));
  const lbl = (text, inner) => `<label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text-muted)">${text}${inner}</label>`;
  const users = activeUsers().map((u) => [u.id, u.name]);
  const depts = activeList("departments");
  const rows = tasks
    .map((t) => {
      const n = subsOf(t.id).length;
      return `<tr>${canEdit ? `<td><input type="checkbox" name="taskIds[]" value="${t.id}" data-change="pickRow" style="width:auto" aria-label="Select ${esc(t.name)}"></td>` : ""}
        <td><a href="${base}/${t.id}" style="text-decoration:none;font-weight:500">${t.is_milestone ? '<span title="Milestone">◆ </span>' : ""}${esc(t.name)}</a>${n ? `<div style="font-size:11px;color:var(--text-faint)">${n} subtasks</div>` : ""}</td>
        <td>${esc(userName(t.owner_id))}</td><td>${esc(t.department ?? "—")}</td><td class="tabular">${fmtDate(t.target_date)}</td>
        <td>${pbar(taskPct(t))}</td><td>${chip(isOverdue(t) ? "DELAYED" : t.status)}</td><td>${chip(t.priority)}</td>
        <td><div style="display:flex;gap:6px"><a href="${base}/${t.id}" class="btn">Open</a>${canDelete ? `<button type="button" class="btn danger" data-click="deleteTask" data-id="${t.id}" data-name="${esc(t.name)}">Delete</button>` : ""}</div></td></tr>`;
    })
    .join("");
  return `<div class="card panel" style="padding:11px 14px;margin-bottom:14px">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint);font-weight:600">Views</span>
      <a href="${base}" class="btn" style="font-size:11.5px">All tasks</a>
      ${views.map((v) => `<span style="display:inline-flex;align-items:center"><a href="${base}?${esc(v.query)}" class="btn" style="font-size:11.5px${v.ownerId === S.me.id ? ";border-top-right-radius:0;border-bottom-right-radius:0" : ""}" ${v.shared && v.ownerId !== S.me.id ? `title="Shared by ${esc(v.ownerName)}"` : ""}>${esc(v.name)}${v.shared ? '<span style="color:var(--text-faint)"> ·shared</span>' : ""}</a>${v.ownerId === S.me.id ? `<button type="button" class="btn" data-click="deleteView" data-id="${v.id}" title="Delete the view" style="font-size:11.5px;padding:4px 7px;border-left:none;border-top-left-radius:0;border-bottom-left-radius:0">×</button>` : ""}</span>`).join("")}
      <button type="button" class="btn" style="margin-left:auto;font-size:11.5px" data-click="toggle" data-target="#save-view" ${currentQuery ? "" : 'disabled title="Filter the list first, then save what you’re looking at"'}>Save this view</button>
    </div>
    <form id="save-view" hidden data-form="saveView" data-query="${esc(currentQuery)}" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${banner("error")}
      <input name="name" placeholder="e.g. My department, overdue" maxlength="40" required style="width:240px">
      ${canEdit ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" name="shared" style="width:auto"> Share with everyone</label>` : ""}
      <button type="submit" class="btn primary">Save</button><span style="font-size:11px;color:var(--text-faint)">Saving over a name you’ve used before replaces that view.</span>
    </form></div>
  <form data-form="filter" data-base="${base}" class="card panel" style="padding:11px 14px;margin-bottom:14px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      ${lbl("Name contains", `<input type="search" name="q" value="${esc(f.q)}" placeholder="any part of the name" style="width:190px">`)}
      ${lbl("Status", `<select name="status">${options(STATUS_OPTS, f.status, "any")}</select>`)}
      ${lbl("Priority", `<select name="priority">${options(PRIORITY_OPTS, f.priority, "any")}</select>`)}
      ${lbl("Owner", `<select name="owner">${options(users, f.owner, "anyone")}</select>`)}
      ${lbl("Department", `<select name="department"><option value="">any</option><option value="none"${f.department === "none" ? " selected" : ""}>none set</option>${options(depts, f.department)}</select>`)}
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding-bottom:6px"><input type="checkbox" name="overdue" value="1" ${f.overdue === "1" ? "checked" : ""} style="width:auto"> Overdue only</label>
      <button type="submit" class="btn primary">Filter</button>${currentQuery ? `<a href="${base}" class="btn">Clear</a>` : ""}
    </div></form>
  <div class="card panel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <h3 style="margin-bottom:0">Tasks <span style="font-weight:400;color:var(--text-faint);font-size:12.5px">${tasks.length === all.length ? `(${all.length})` : `(${tasks.length} of ${all.length})`}</span></h3>
      <div style="display:flex;gap:8px"><button type="button" class="btn" data-click="exportTasks" data-project="${p.id}">Export CSV</button><a href="${base}/new" class="btn primary">+ New task</a></div>
    </div>
    <form data-form="bulk" data-project-id="${p.id}">${banner()}
      <div style="overflow-x:auto"><table class="grid"><thead><tr>${canEdit ? `<th style="width:28px"><input type="checkbox" data-change="pickAll" style="width:auto" aria-label="Select every task shown"></th>` : ""}<th>Task</th><th>Owner</th><th>Dept.</th><th>Target</th><th>Completion</th><th>Status</th><th>Priority</th><th></th></tr></thead>
      <tbody>${rows || emptyRow(canEdit ? 9 : 8, `No tasks match. Clear the filters, or <a href="${base}/new">add a task</a>.`)}</tbody></table></div>
      ${canEdit ? `<div id="bulk-bar" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);opacity:0.55">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px" id="bulk-title">Tick tasks above to change several at once</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          ${lbl("Status", `<select name="status">${options(STATUS_OPTS, "", "leave alone")}</select>`)}
          ${lbl("Priority", `<select name="priority">${options(PRIORITY_OPTS, "", "leave alone")}</select>`)}
          ${lbl("Owner", `<select name="ownerId">${options(users, "", "leave alone")}</select>`)}
          ${lbl("Department", `<select name="department"><option value="">leave alone</option><option value="none">clear it</option>${options(depts, "")}</select>`)}
          ${lbl("Shift dates (days)", `<input type="number" name="shiftDays" placeholder="0" step="1" min="-365" max="365" style="width:92px">`)}
          ${lbl("Reason (if dates move)", `<input name="shiftReason" placeholder="e.g. tooling delayed" style="width:190px">`)}
          <button type="submit" class="btn primary" data-busy="Applying…" id="bulk-apply" disabled>Apply</button>
        </div>
        ${faint("Anything left on “leave alone” isn’t touched. Shifting dates moves start and target together, so a task’s length never changes, and each move is written to the activity log with the reason — that’s what the delay analysis export reads.", "margin-top:9px;margin-bottom:0")}
      </div>` : ""}
    </form>
    ${faint("Task completion rolls up from its subtasks (weighted) when it has any; project completion rolls up from tasks using each task’s weight — never a flat average. The CSV export contains exactly the tasks of this project you have permission to see, not what’s filtered on screen.", "margin-top:10px")}
  </div>`;
}

function taskFormCard(p, t) {
  const v = t || { status: "NOT_STARTED", priority: "MEDIUM", completion: 0, weight: rules().defaultTaskWeight ?? 1 };
  const hasSubs = t && subsOf(t.id).length > 0;
  const form = `<form data-form="${t ? "updateTask" : "createTask"}" data-project-id="${p.id}" ${t ? `data-task-id="${t.id}" data-version="${t.version}"` : ""}>${banner("error")}
    <div class="field"><label>Task name</label><input name="name" required value="${esc(v.name)}"></div>
    <div class="field"><label>Description</label><textarea name="description">${esc(v.description)}</textarea></div>
    <div class="field-row"><div class="field"><label>Task owner</label><select name="ownerId" required>${userOptions(v.owner_id, "Select owner")}</select></div>
      <div class="field"><label>Department</label><select name="department">${options(activeList("departments"), v.department, "—")}</select></div></div>
    <div class="field-row"><div class="field"><label>Start date</label><input name="startDate" type="date" required value="${v.start_date ?? ""}"></div>
      <div class="field"><label>Target date</label><input name="targetDate" type="date" required value="${v.target_date ?? ""}"></div></div>
    <div class="field-row"><div class="field"><label>Status</label><select name="status">${options(STATUS_OPTS, v.status)}</select></div>
      <div class="field"><label>Priority</label><select name="priority">${options(PRIORITY_OPTS, v.priority)}</select></div></div>
    <div class="field-row"><div class="field"><label>Completion % ${hasSubs ? '<span style="font-weight:400">(rolled up from subtasks)</span>' : ""}</label>
        <input name="completion" type="number" min="0" max="100" step="any" value="${t ? taskPct(t) : 0}" ${hasSubs ? "disabled" : ""}></div>
      <div class="field"><label>Weight (for project roll-up)</label><input name="weight" type="number" min="0.01" max="9999" step="any" value="${v.weight}">
        ${faint("How much this task counts towards the project’s completion percentage, <em>relative to the other tasks</em> — it isn’t a percentage and doesn’t need to add up to anything. Leave it at 1 to count the same as everything else; use 3 for a task worth three ordinary ones, or 0.5 for a trivial one.", "margin-top:5px;margin-bottom:0")}</div></div>
    <div class="field"><label>Planned effort (hours, optional)</label><input name="estimatedHours" type="number" min="0" step="any" placeholder="leave blank if not estimated" value="${v.est_minutes != null ? round2(v.est_minutes / 60) : ""}">
      ${faint("How long the work itself should take, which is not the same as how long the task is open for. Time logged against the task is compared with this — leave it blank rather than guessing, and the task is simply left out of the planned-versus-actual figures.", "margin-top:5px;margin-bottom:0")}</div>
    ${t ? `<div class="field"><label>Reason for delay (only recorded if the target date changes)</label><input name="delayReason" placeholder="e.g. vendor lead time slipped"></div>` : ""}
    <div class="field"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="isMilestone" ${v.is_milestone ? "checked" : ""} style="width:auto"> This task is a milestone</label></div>
    <div class="field"><label>Remarks</label><textarea name="remarks">${esc(v.remarks)}</textarea></div>
    <button type="submit" class="btn primary">${t ? "Save changes" : "Create task"}</button></form>`;
  return t ? form : `<div class="card panel" style="max-width:760px"><h3>New task</h3>${form}</div>`;
}

// ----- critical path (forward and backward pass over the dependency graph) -----
function schedule(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const edges = tasks.flatMap((t) => (t.deps || []).filter((d) => ids.has(d.pred)).map((d) => ({ pred: d.pred, succ: t.id, type: d.type, lag: d.lag })));
  const dur = (t) => Math.max(1, dayDiff(t.start_date, t.target_date)) * 864e5;
  const inc = new Map(tasks.map((t) => [t.id, []])), out = new Map(tasks.map((t) => [t.id, []]));
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  for (const e of edges) { inc.get(e.succ).push(e); out.get(e.pred).push(e); indeg.set(e.succ, indeg.get(e.succ) + 1); }
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id), order = [];
  while (queue.length) {
    const id = queue.shift(); order.push(id);
    for (const e of out.get(id)) { indeg.set(e.succ, indeg.get(e.succ) - 1); if (indeg.get(e.succ) === 0) queue.push(e.succ); }
  }
  if (order.length !== tasks.length) return { cycle: tasks.filter((t) => !order.includes(t.id)).map((t) => t.id), map: new Map() };
  const byId = new Map(tasks.map((t) => [t.id, t])), es = new Map(), ef = new Map(), lf = new Map();
  for (const id of order) {
    const t = byId.get(id), d = dur(t);
    let earliest = dayMs(t.start_date);
    for (const e of inc.get(id)) {
      const lag = e.lag * 864e5;
      earliest = Math.max(earliest, e.type === "FINISH_TO_START" ? ef.get(e.pred) + lag : e.type === "START_TO_START" ? es.get(e.pred) + lag : ef.get(e.pred) + lag - d);
    }
    es.set(id, earliest); ef.set(id, earliest + d);
  }
  const finish = Math.max(...order.map((id) => ef.get(id)));
  for (const id of [...order].reverse()) {
    const d = dur(byId.get(id));
    let latest = out.get(id).length ? Infinity : finish;
    for (const e of out.get(id)) {
      const sLF = lf.get(e.succ), sLS = sLF - dur(byId.get(e.succ)), lag = e.lag * 864e5;
      latest = Math.min(latest, e.type === "FINISH_TO_START" ? sLS - lag : e.type === "START_TO_START" ? sLS - lag + d : sLF - lag);
    }
    lf.set(id, latest);
  }
  const map = new Map(tasks.map((t) => {
    const slack = Math.round((lf.get(t.id) - ef.get(t.id)) / 864e5);
    return [t.id, { es: es.get(t.id), ef: ef.get(t.id), slack, critical: slack <= 0, tooEarly: es.get(t.id) > dayMs(t.start_date) }];
  }));
  return { cycle: null, map, edges };
}

async function taskDetail(p, taskId) {
  const t = byTask.get(taskId);
  if (!t || t.project_id !== p.id) return `<div class="card panel"><p>That task doesn’t exist (it may have been deleted).</p></div>`;
  const canEdit = canTask("EDIT", t, p), canDelete = canTask("DELETE", t, p);
  const canLog = canEdit || t.owner_id === S.me.id;
  const { entries } = await api("timeEntries", { taskId: t.id });
  const subs = subsOf(t.id);
  const siblings = tasksOf(p.id);
  const plan = schedule(siblings);
  const mine = plan.cycle ? null : plan.map.get(t.id);
  const TYPE = { FINISH_TO_START: "starts after it finishes", START_TO_START: "starts when it starts", FINISH_TO_FINISH: "finishes when it finishes" };
  const depLine = (d, other, unlink) => `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
    <div><div style="font-weight:500">${esc(other?.name ?? "—")}</div><div style="font-size:11px;color:var(--text-faint)">${TYPE[d.type] ?? d.type}${d.lag ? `, ${d.lag > 0 ? "+" : ""}${d.lag} day${Math.abs(d.lag) === 1 ? "" : "s"} lag` : ""}</div></div>
    ${unlink ? `<button type="button" class="btn" style="padding:3px 9px;font-size:11px" data-click="removeDep" data-task="${t.id}" data-id="${d.id}">Unlink</button>` : ""}</div>`;
  const preds = (t.deps || []).map((d) => depLine(d, byTask.get(d.pred), canProject("EDIT", p)));
  const succs = siblings.flatMap((s) => (s.deps || []).filter((d) => d.pred === t.id).map((d) => depLine(d, s, false)));
  const linked = new Set([...(t.deps || []).map((d) => d.pred), t.id]);
  const candidates = siblings.filter((s) => !linked.has(s.id)).map((s) => [s.id, s.name]);
  const logged = S.timeTotals[t.id] || 0;
  const stat = (label, value, tone) => `<div><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint);font-weight:600">${label}</div><div class="tabular" style="font-size:16px;font-weight:600;margin-top:2px;color:${tone ? `var(--${tone})` : "var(--text)"}">${value}</div></div>`;
  const h4 = (text, top = 0) => `<h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint);margin-top:${top}px">${text}</h4>`;
  return `<div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px;align-items:start">
    <div class="card panel"><h3>Edit task</h3>${taskFormCard(p, t)}
      ${canDelete ? `<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:16px"><button type="button" class="btn danger" data-click="deleteTask" data-id="${t.id}" data-name="${esc(t.name)}" data-subtasks="1">Delete task</button></div>` : ""}</div>
    <div class="card panel"><h3>Subtasks</h3>
      ${subs.length ? "" : '<p style="color:var(--text-faint);font-size:12.5px">No subtasks yet — add one below.</p>'}
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">${subs.map((s) => `<div style="border:1px solid var(--border);border-radius:8px;padding:10px">
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><span style="font-weight:500;font-size:13px">${esc(s.name)}</span>
          ${canDelete ? `<button type="button" class="btn danger" style="padding:3px 8px;font-size:11px" data-click="deleteSubtask" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>` : ""}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px">Owner: ${esc(userName(s.owner_id))} · Start: ${s.start_date} · Target: ${s.target_date}</div>
        <form data-form="updateSubtask" data-subtask-id="${s.id}" data-version="${s.version}">${banner("error")}<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${canEdit ? `<label style="font-size:11px;color:var(--text-muted);display:flex;gap:4px;align-items:center">Start <input type="date" name="startDate" required value="${s.start_date}" style="width:auto"></label>
          <label style="font-size:11px;color:var(--text-muted);display:flex;gap:4px;align-items:center">Target <input type="date" name="targetDate" required value="${s.target_date}" style="width:auto"></label>` : ""}
          <select name="status" style="width:auto">${options(STATUS_OPTS, s.status)}</select>
          <input type="number" name="completion" min="0" max="100" step="any" value="${s.completion}" style="width:70px">
          <button type="submit" class="btn" style="font-size:11px" data-busy="Updating…">Update</button><span style="margin-left:auto">${pbar(s.completion)}</span></div></form></div>`).join("")}</div>
      <h3>Add subtask</h3>
      <form data-form="createSubtask" data-task-id="${t.id}">${banner("error")}
        <div class="field"><label>Subtask name</label><input name="name" required></div>
        <div class="field-row"><div class="field"><label>Owner</label><select name="ownerId" required>${userOptions("", "Select owner")}</select></div>
          <div class="field"><label>Status</label><select name="status">${options(STATUS_OPTS.filter(([v]) => ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"].includes(v)), "NOT_STARTED")}</select></div></div>
        <div class="field-row"><div class="field"><label>Start date</label><input name="startDate" type="date" required></div><div class="field"><label>Target date</label><input name="targetDate" type="date" required></div></div>
        <div class="field-row"><div class="field"><label>Completion %</label><input name="completion" type="number" min="0" max="100" value="0"></div>
          <div class="field"><label>Weight</label><input name="weight" type="number" min="0.01" max="9999" step="any" value="1">${faint("How much this subtask counts towards <em>this task’s</em> percentage. 1 is normal.", "font-size:10.5px;margin-top:4px;margin-bottom:0")}</div></div>
        <button type="submit" class="btn" data-busy="Adding…">Add subtask</button></form></div>
    <div class="card panel"><h3>Dependencies</h3>
      ${mine ? `<div style="border:1px solid var(--border);border-left:3px solid ${mine.critical ? "var(--danger)" : "var(--ok)"};border-radius:8px;padding:9px 11px;margin-bottom:14px;font-size:12px">
        <div style="font-weight:600;margin-bottom:3px">${mine.critical ? "On the critical path" : `${mine.slack} days of slack`}</div>
        <div style="color:var(--text-muted)">${mine.critical ? "Every day this task slips, the project's finish date slips with it." : "This task can slip by that much before it starts pushing the project's finish date."}</div>
        ${mine.tooEarly ? `<div style="color:var(--warn);margin-top:6px">Its planned start is earlier than what it waits on allows — the earliest honest start is <strong>${new Date(mine.es).toISOString().slice(0, 10)}</strong>.</div>` : ""}</div>` : ""}
      ${h4("Waits on")}${preds.join("") || '<p style="color:var(--text-faint);font-size:12.5px">Nothing — this task can start whenever it is planned to.</p>'}
      ${h4("Waiting on this", 16)}${succs.join("") || '<p style="color:var(--text-faint);font-size:12.5px">Nothing is held up by this task.</p>'}
      ${canProject("EDIT", p) ? `<form data-form="addDep" data-task-id="${t.id}" style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">${banner("error")}
        <div class="field"><label>This task waits on</label><select name="predecessorId" required><option value="" disabled selected>Choose a task</option>${options(candidates)}</select></div>
        <div class="field-row"><div class="field"><label>Link type</label><select name="type">${options([["FINISH_TO_START", "Finish to start"], ["START_TO_START", "Start to start"], ["FINISH_TO_FINISH", "Finish to finish"]], "FINISH_TO_START")}</select></div>
          <div class="field"><label>Lag (days)</label><input name="lagDays" type="number" value="0" min="-365" max="365"></div></div>
        <button type="submit" class="btn primary" data-busy="Linking…" ${candidates.length ? "" : "disabled"}>Add dependency</button>
        ${faint("A link that would make the plan circular is refused rather than saved — otherwise the schedule could never produce dates. Lag can be negative, for work that may start before the thing it follows is quite finished.", "margin-top:10px;margin-bottom:0")}</form>` : ""}
    </div>
    <div class="card panel"><h3>Time spent</h3>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">${stat("Logged", hours(logged))}${stat("Planned", t.est_minutes ? hours(t.est_minutes) : "—")}
        ${t.est_minutes && logged ? stat(logged > t.est_minutes ? "Over plan" : "Under plan", hours(Math.abs(logged - t.est_minutes)), logged > t.est_minutes ? "danger" : "ok") : ""}</div>
      ${canLog ? `<form data-form="logTime" data-task-id="${t.id}" style="border-top:1px solid var(--border);padding-top:12px">${banner("error")}
        <div class="field-row"><div class="field"><label>How long</label><input name="duration" placeholder="1.5 · 1:30 · 90m" required></div>
          <div class="field"><label>Day it was worked</label><input name="spentOn" type="date" value="${S.today}" max="${S.today}"></div></div>
        <div class="field"><label>Note (optional)</label><input name="note" placeholder="e.g. revised the fixture drawing after DFM review"></div>
        <button type="submit" class="btn primary">Log time</button></form>` : ""}
      ${entries.length ? `<div style="margin-top:14px">${entries.map((e) => `<div style="display:flex;gap:8px;align-items:baseline;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
        <div style="min-width:0"><span class="tabular" style="font-weight:600">${hours(e.minutes)}</span> <span style="color:var(--text-muted)">· ${esc(e.user_name)}</span>${e.note ? `<div style="font-size:11px;color:var(--text-faint)">${esc(e.note)}</div>` : ""}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-shrink:0"><span class="tabular" style="font-size:11px;color:var(--text-faint)">${e.spent_on}</span>
          ${e.user_id === S.me.id ? `<button type="button" class="btn" style="padding:2px 7px;font-size:10.5px" data-click="deleteTime" data-id="${e.id}">Remove</button>` : ""}</div></div>`).join("")}</div>`
        : '<p style="color:var(--text-faint);font-size:12.5px;margin-top:12px;margin-bottom:0">Nothing logged yet. Entries here are what turns “this always takes longer than we think” into a number the next plan can use.</p>'}
    </div>
    <div class="card panel" style="grid-column:1 / -1"><div style="display:flex;gap:10px;align-items:center">${chip(isOverdue(t) ? "DELAYED" : t.status)}${t.is_milestone ? chip("ACTIVE", "Milestone") : ""}${mine?.critical ? chip("CRITICAL", "Critical path") : ""}</div></div>
    <div style="grid-column:1 / -1">${chatPanel({ taskId: t.id }, "Task discussion", "Anyone who can view this task can read and post here. Type @ and someone's User ID to notify them.", 360)}</div>
  </div>`;
}

function boardTab(p) {
  const COLS = [["NOT_STARTED", "Not started", "var(--text-faint)"], ["IN_PROGRESS", "In progress", "var(--accent)"], ["ON_HOLD", "On hold", "var(--warn-mark)"], ["COMPLETED", "Completed", "var(--ok)"]];
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const tasks = [...tasksOf(p.id)].sort((a, b) => rank[a.priority] - rank[b.priority] || a.target_date.localeCompare(b.target_date));
  const canEdit = canProject("EDIT", p);
  const delayed = tasks.filter((t) => t.status === "DELAYED"), cancelled = tasks.filter((t) => t.status === "CANCELLED").length;
  const cols = COLS.map(([key, label, tone], i) => {
    const inCol = tasks.filter((t) => t.status === key);
    const move = (t, to, arrow) => (to ? `<button type="button" class="btn" style="padding:1px 7px;font-size:12px" title="Move to ${to[1]}" data-click="moveTask" data-id="${t.id}" data-status="${to[0]}">${arrow}</button>` : "");
    return `<div class="card panel" style="padding:12px;min-width:200px">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid ${tone};padding-bottom:7px;margin-bottom:10px"><span style="font-size:12.5px;font-weight:700">${label}</span><span class="tabular" style="font-size:11.5px;color:var(--text-faint)">${inCol.length}</span></div>
      ${inCol.length ? "" : '<p style="font-size:11.5px;color:var(--text-faint);margin:6px 0">Nothing here.</p>'}
      <div style="display:flex;flex-direction:column;gap:8px">${inCol.map((t) => `<div style="border:1px solid var(--border);border-left:3px solid ${isOverdue(t) ? "var(--danger)" : tone};border-radius:8px;padding:9px 10px;background:var(--surface)">
        <a href="#/projects/${p.id}/tasks/${t.id}" style="font-size:12.5px;font-weight:600;text-decoration:none;color:inherit">${t.is_milestone ? "◆ " : ""}${esc(t.name)}</a>
        <div style="font-size:11px;color:var(--text-faint);margin-top:4px">${esc(userName(t.owner_id))} · ${fmtDate(t.target_date, false)} · ${taskPct(t)}%</div>
        <div style="display:flex;gap:5px;margin-top:7px;align-items:center;flex-wrap:wrap">${chip(t.priority)}${isOverdue(t) ? chip("DELAYED", "Overdue") : ""}
          ${canEdit && canTask("EDIT", t, p) ? `<span style="margin-left:auto;display:flex;gap:4px">${move(t, COLS[i - 1], "←")}${move(t, COLS[i + 1], "→")}</span>` : ""}</div></div>`).join("")}</div></div>`;
  }).join("");
  return `<div style="display:grid;grid-template-columns:repeat(4, minmax(200px, 1fr));gap:12px;align-items:start;overflow-x:auto">${cols}</div>
  ${delayed.length || cancelled ? `<div class="card panel" style="margin-top:16px"><h3>Not on the board</h3>
    ${delayed.length ? `<p style="font-size:12.5px">${delayed.length} task${delayed.length === 1 ? " is" : "s are"} marked <strong>Delayed</strong>, which is a fact about the date rather than a stage of work. Open ${delayed.slice(0, 4).map((t) => `<a href="#/projects/${p.id}/tasks/${t.id}">${esc(t.name)}</a>`).join(", ")}${delayed.length > 4 ? ` and ${delayed.length - 4} more` : ""} and set the stage the work is actually at.</p>` : ""}
    ${cancelled ? `<p style="font-size:12.5px;margin:0;color:var(--text-muted)">${plural(cancelled, "cancelled task")} hidden.</p>` : ""}</div>` : ""}`;
}

function ganttTab(p) {
  const tasks = tasksOf(p.id);
  if (!tasks.length) return `<div class="card panel"><p style="color:var(--text-faint)">Add tasks to see them on the timeline.</p></div>`;
  const plan = schedule(tasks);
  if (plan.cycle)
    return `<div class="card panel"><h3>The plan is circular</h3><p style="font-size:13px">These tasks depend on each other in a loop, so there is no order in which they could actually be done, and no honest set of dates to draw:</p>
      <ul style="font-size:13px">${tasks.filter((t) => plan.cycle.includes(t.id)).map((t) => `<li>${esc(t.name)}</li>`).join("")}</ul>
      <p style="font-size:12.5px;color:var(--text-muted)">Open any one of them and unlink a dependency to break the loop.</p></div>`;
  const ROW = 34, LABEL = 230, CHART = 760, PAD = 10;
  const min = Math.min(...tasks.map((t) => dayMs(t.start_date)), ...[...plan.map.values()].map((s) => s.es));
  const max = Math.max(...tasks.map((t) => dayMs(t.target_date)), ...[...plan.map.values()].map((s) => s.ef));
  const span = Math.max(max - min, 864e5), height = tasks.length * ROW + 34, width = LABEL + CHART;
  const x = (ms) => LABEL + PAD + ((ms - min) / span) * (CHART - PAD * 2), y = (i) => 26 + i * ROW;
  const idx = new Map(tasks.map((t, i) => [t.id, i]));
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  const ticks = [{ x: LABEL + PAD, label: month.format(new Date(min)), line: false }];
  const cur = new Date(min); cur.setUTCDate(1); cur.setUTCMonth(cur.getUTCMonth() + 1);
  while (cur.getTime() <= max && ticks.length < 24) { ticks.push({ x: x(cur.getTime()), label: month.format(cur), line: true }); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  const todayX = x(dayMs(S.today));
  const tooEarly = [...plan.map.values()].filter((s) => s.tooEarly).length;
  const critical = [...plan.map.values()].filter((s) => s.critical).length;
  const links = plan.edges.map((e) => {
    const a = byTask.get(e.pred), b = byTask.get(e.succ);
    const x1 = x(dayMs(a.target_date)), y1 = y(idx.get(e.pred)) + 8, x2 = x(dayMs(b.start_date)), y2 = y(idx.get(e.succ)) + 8;
    const crit = plan.map.get(e.pred).critical && plan.map.get(e.succ).critical, mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 14));
    return `<path d="M ${x1} ${y1} H ${mid} V ${y2} H ${x2 - 4}" fill="none" stroke="${crit ? "var(--danger)" : "var(--text-faint)"}" stroke-width="${crit ? 1.5 : 1}" opacity="${crit ? 0.85 : 0.55}" marker-end="url(#${crit ? "arrow-crit" : "arrow"})"/>`;
  }).join("");
  const bars = tasks.map((t, i) => {
    const s = plan.map.get(t.id), top = y(i), bx = x(dayMs(t.start_date)), w = Math.max(x(dayMs(t.target_date)) - bx, 6);
    const color = t.status === "COMPLETED" ? "var(--ok)" : s.critical ? "var(--danger)" : isOverdue(t) ? "var(--warn-mark)" : "var(--accent)";
    const pct = taskPct(t);
    return `<g><text x="6" y="${top + 12}" font-size="11.5" font-family="IBM Plex Sans" fill="var(--text)">${esc(t.name.length > 30 ? t.name.slice(0, 29) + "…" : t.name)}</text>
      <text x="6" y="${top + 24}" font-size="9.5" font-family="IBM Plex Mono" fill="${s.critical ? "var(--danger)" : "var(--text-faint)"}">${s.critical ? "critical path" : `${s.slack}d slack`} · ${pct}%</text>
      ${s.tooEarly ? `<rect x="${x(s.es)}" y="${top}" width="${Math.max(x(s.ef) - x(s.es), 6)}" height="16" rx="4" fill="none" stroke="var(--warn-mark)" stroke-dasharray="3 2" stroke-width="1.2"/>` : ""}
      ${t.is_milestone ? `<rect x="${bx - 6}" y="${top + 2}" width="12" height="12" transform="rotate(45 ${bx} ${top + 8})" fill="${color}"/>`
        : `<rect x="${bx}" y="${top}" width="${w}" height="16" rx="4" fill="${color}" opacity="0.28"/><rect x="${bx}" y="${top}" width="${(w * pct) / 100}" height="16" rx="4" fill="${color}"/><rect x="${bx}" y="${top}" width="${w}" height="16" rx="4" fill="none" stroke="${color}" stroke-width="1"/>`}</g>`;
  }).join("");
  const legend = (c, text) => `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:16px;height:8px;border-radius:3px;background:${c};display:inline-block"></span>${text}</span>`;
  return `<div class="card panel" style="overflow-x:auto">
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:10px"><h3 style="margin-bottom:0">Timeline</h3>
      <div style="font-size:11.5px;color:var(--text-muted)">${plural(plan.edges.length, "link")} · ${plural(critical, "task")} on the critical path</div></div>
    ${tooEarly ? `<div style="margin-top:12px;border:1px solid var(--border);border-left:3px solid var(--warn-mark);border-radius:8px;padding:9px 11px;font-size:12.5px"><strong>${tooEarly} task${tooEarly === 1 ? " is" : "s are"} planned to start too early.</strong> Their planned start is before the work they wait on can be finished. The hollow bar behind each one is where the dependencies actually allow it to sit.</div>` : ""}
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="margin-top:12px;max-width:100%">
      <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--text-faint)"/></marker>
        <marker id="arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--danger)"/></marker></defs>
      ${ticks.map((t) => `<g>${t.line ? `<line x1="${t.x}" y1="20" x2="${t.x}" y2="${height - 8}" stroke="var(--border)" stroke-width="1"/>` : ""}<text x="${t.x + 3}" y="14" font-size="10" font-family="IBM Plex Mono" fill="var(--text-faint)">${t.label}</text></g>`).join("")}
      ${todayX >= LABEL && todayX <= width ? `<line x1="${todayX}" y1="18" x2="${todayX}" y2="${height - 8}" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="3 3"/><text x="${todayX + 3}" y="${height - 1}" font-size="9.5" font-family="IBM Plex Mono" fill="var(--danger)">today</text>` : ""}
      ${links}${bars}</svg>
    <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:11px;color:var(--text-faint);margin-top:12px">
      ${legend("var(--danger)", "Critical path — slipping these slips the project")}${legend("var(--warn-mark)", "Overdue, but has slack")}${legend("var(--accent)", "On plan, has slack")}${legend("var(--ok)", "Complete")}<span>◆ milestone</span><span>Dashed outline = earliest the dependencies allow</span></div>
    ${faint(`Dates come from a forward and backward pass over the dependency graph — the standard critical-path method — not from reading the bars. Link tasks from any task’s page: <a href="#/projects/${p.id}/tasks">Tasks</a>.`, "margin-top:10px")}
  </div>`;
}

async function documentsTab(p) {
  const { docs } = await api("docs", { projectId: p.id });
  const canUpload = canProject("CREATE", p), canDelete = canProject("DELETE", p);
  const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const total = docs.reduce((s, d) => s + d.size_bytes, 0);
  const CATS = ["Drawing", "3D Model", "Specification", "Inspection Report", "Test Report", "Approval", "Photo", "Meeting Minutes", "Other"];
  return `<div style="display:grid;grid-template-columns:${canUpload ? "1.6fr 1fr" : "1fr"};gap:16px;align-items:start">
    <div class="card panel" style="overflow-x:auto">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px"><h3 style="margin-bottom:0">Documents</h3><span class="tabular" style="font-size:11.5px;color:var(--text-faint)">${plural(docs.length, "file")} · ${size(total)}</span></div>
      <table class="grid"><thead><tr><th>File</th><th>Category</th><th>Size</th><th>Uploaded by</th><th>When</th><th></th></tr></thead><tbody>
      ${docs.map((d) => `<tr><td><a href="/api/doc/${d.id}" style="font-weight:500;text-decoration:none">${esc(d.file_name)}</a>${d.task_name ? `<div style="font-size:11px;color:var(--text-faint)">on task: ${esc(d.task_name)}</div>` : ""}</td>
        <td>${esc(d.category ?? "—")}</td><td class="tabular">${size(d.size_bytes)}</td><td>${esc(d.uploader)}</td><td class="tabular">${fmtDate(String(d.created_at).slice(0, 10))}</td>
        <td style="text-align:right">${canDelete ? `<button type="button" class="btn" style="padding:3px 9px;font-size:11px" data-click="deleteDoc" data-id="${d.id}" data-name="${esc(d.file_name)}">Remove</button>` : ""}</td></tr>`).join("")
        || emptyRow(6, `No documents yet.${canUpload ? " Upload the first one on the right." : ""}`)}</tbody></table>
      ${faint("Files are kept in Netlify’s file storage. Every download re-checks that you may see the project it belongs to, so a copied link is no use to anyone outside it.", "margin-top:10px")}</div>
    ${canUpload ? `<div class="card panel"><h3>Upload a document</h3><form data-form="upload" data-project-id="${p.id}">${banner()}
      <div class="field"><label>File</label><input name="file" type="file" required></div>
      <div class="field"><label>Category</label><select name="category">${options(CATS, "Drawing")}</select></div>
      <button type="submit" class="btn primary" data-busy="Uploading…">Upload</button>
      ${faint("Up to 4 MB per file. Drawings, PDFs, images, Office documents, zips and CAD exports. Put anything larger on the shared drive and note the path in the project description.", "margin-top:10px;margin-bottom:0")}</form></div>` : ""}
  </div>`;
}

async function activityTab(p) {
  const { entries } = await api("activity", { projectId: p.id });
  return `<div class="card panel" style="overflow-x:auto"><h3>Activity log</h3><table class="grid"><thead><tr><th>When</th><th>User</th><th>Entity</th><th>Action</th><th>Field</th><th>Previous</th><th>New</th><th>Reason</th></tr></thead><tbody>
    ${entries.map((e) => `<tr><td class="tabular">${fmtWhen(e.created_at)}</td><td>${esc(e.user_name ?? "—")}</td><td>${esc(e.entity)} <span style="color:var(--text-faint)">${esc(e.entity_id.slice(0, 8))}</span></td>
      <td>${esc(e.action)}</td><td>${esc(e.field ?? "—")}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(e.old_value ?? "—")}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(e.new_value ?? "—")}</td><td>${esc(e.reason ?? "—")}</td></tr>`).join("") || emptyRow(8, "No activity recorded yet.")}
  </tbody></table></div>`;
}

// ----- chat (team room, project discussion, task thread) -----
function chatPanel(scope, title, blurb, height) {
  return `<div class="card panel chat-panel" data-scope='${esc(JSON.stringify(scope))}'><h3>${title}</h3>
    <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 12px">${blurb}</p>
    <div class="chat-list" style="height:${height}px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-alt);padding:12px;display:flex;flex-direction:column;gap:10px"><p style="margin:auto;font-size:12.5px;color:var(--text-faint)">Loading…</p></div>
    <form data-form="chatSend">${banner("error")}<div style="display:flex;gap:8px;margin-top:10px;align-items:flex-end">
      <textarea name="body" rows="2" maxlength="2000" data-chat-input placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)" style="min-height:44px;resize:vertical"></textarea>
      <button type="submit" class="btn primary" data-busy="Sending…">Send</button></div></form>
    <p class="chat-hint" style="font-size:11px;color:var(--text-faint);margin:7px 0 0">Type @ and someone’s User ID (not their name) to notify them — for example @rahul.</p></div>`;
}
const mentionRe = /(?<![\w.%+-])@([a-zA-Z0-9]{1,12})(?![a-zA-Z0-9])/g;
function paintChat(panel, messages) {
  const list = $(".chat-list", panel);
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const ago = (iso) => {
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : fmtWhen(iso);
  };
  list.innerHTML = messages.length
    ? messages.map((m) => {
        const mine = m.author_id === S.me.id;
        const body = esc(m.body).replace(mentionRe, '<strong style="color:var(--accent-strong)">$&</strong>');
        return `<div style="display:flex;flex-direction:column;align-items:${mine ? "flex-end" : "flex-start"}">
          <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:3px">${mine ? "" : `<span class="avatar">${initials(m.author_name)}</span>`}<span style="font-size:11.5px;font-weight:600;color:var(--text-muted)">${mine ? "You" : esc(m.author_name)}</span><span style="font-size:10.5px;color:var(--text-faint)">${ago(m.created_at)}</span></div>
          <div style="max-width:78%;background:${mine ? "var(--accent-soft)" : "var(--surface)"};border:1px solid var(--border);border-radius:10px;padding:8px 11px;font-size:13px;white-space:pre-wrap;word-break:break-word">${body}</div>
          ${mine ? `<button type="button" data-click="deleteMessage" data-id="${m.id}" style="margin-top:2px;font-size:10.5px;color:var(--text-faint);background:none;border:none;cursor:pointer;padding:0">Delete</button>` : ""}</div>`;
      }).join("")
    : '<p style="margin:auto;font-size:12.5px;color:var(--text-faint)">No messages yet — start the conversation.</p>';
  if (atBottom || panel.dataset.first !== "done") list.scrollTop = list.scrollHeight;
  panel.dataset.first = "done";
}
async function refreshChat(panel) {
  try {
    const { messages } = await api("messages", { scope: JSON.parse(panel.dataset.scope) });
    if (panel.isConnected) paintChat(panel, messages);
  } catch (e) {
    $(".chat-list", panel).innerHTML = `<p style="margin:auto;font-size:12.5px;color:var(--danger)">${esc(e.message)}</p>`;
  }
}
function afterRender(main) {
  for (const panel of $$(".chat-panel", main)) {
    refreshChat(panel);
    timers.push(setInterval(() => !document.hidden && refreshChat(panel), 10000));
  }
}

// ----- other screens -----
function myTasksView() {
  const tasks = liveTasks().filter((t) => t.owner_id === S.me.id && isOpen(t)).sort((a, b) => a.target_date.localeCompare(b.target_date));
  return `${header("My Tasks", "Assigned to you", `${plural(tasks.length, "open task")}`)}
  <div style="margin-bottom:14px"><button type="button" class="btn" data-click="exportTasks" data-mine="1">Export CSV</button></div>
  <div class="card panel" style="overflow-x:auto"><table class="grid"><thead><tr><th>Task</th><th>Project</th><th>Target</th><th>Completion</th><th>Status</th><th>Priority</th></tr></thead><tbody>
  ${tasks.map((t) => { const p = byProject.get(t.project_id); return `<tr><td><a href="#/projects/${p.id}/tasks/${t.id}" style="text-decoration:none;font-weight:500">${esc(t.name)}</a></td>
    <td><a href="#/projects/${p.id}/overview" style="text-decoration:none">${esc(p.name)} <span class="proj-id">(${esc(p.number)})</span></a></td><td class="tabular">${fmtDate(t.target_date)}</td>
    <td>${pbar(taskPct(t))}</td><td>${chip(isOverdue(t) ? "DELAYED" : t.status)}</td><td>${chip(t.priority)}</td></tr>`; }).join("") || emptyRow(6, "Nothing open — you're all caught up.")}
  </tbody></table></div>`;
}

function ganttListView() {
  const projects = liveProjects().filter((p) => isOpen(p)).sort((a, b) => a.target_date.localeCompare(b.target_date));
  return `${header("Gantt Chart", "Cross-project timeline", "Pick a project to see its timeline.")}
  <div class="card panel"><table class="grid"><thead><tr><th>Project</th><th></th></tr></thead><tbody>
  ${projects.map((p) => `<tr><td>${esc(p.name)} <span class="proj-id">(${esc(p.number)})</span></td><td><a href="#/projects/${p.id}/gantt" class="btn">View timeline</a></td></tr>`).join("") || emptyRow(2, "No active projects.")}
  </tbody></table></div>`;
}

function templatesView() {
  const templates = S.projects.filter((p) => p.is_template).sort((a, b) => a.name.localeCompare(b.name));
  const canMake = canCreate("PROJECT");
  return `${header("Planning", "Project templates", "The design and development route for a knotted-suture anchor is much the same every time. A template holds that route — the tasks, who does them, how long each takes and what waits on what — so a new project starts as a plan rather than an empty page.")}
  ${templates.length ? "" : `<div class="card panel"><p style="font-size:13px;margin-top:0">No templates yet.</p><p style="font-size:12.5px;color:var(--text-muted);margin-bottom:0">The way to make one is to take a project that went the way it should have and save it as a template: <a href="#/projects">open the project</a>, then use <strong>Save as template</strong> on its Overview tab.</p></div>`}
  <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(340px, 1fr));gap:16px">
  ${templates.map((t) => { const n = tasksOf(t.id).length; return `<div class="card panel"><h3 style="margin-bottom:4px">${esc(t.name)}</h3>
    <div style="font-size:11.5px;color:var(--text-faint)">${plural(n, "task")} · from ${esc(userName(t.pm_id))} · updated ${fmtDate(String(t.updated_at).slice(0, 10))}</div>
    ${t.description ? `<p style="font-size:12.5px;color:var(--text-muted);margin-top:10px;white-space:pre-wrap">${esc(t.description)}</p>` : ""}
    ${canMake ? `<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
      <div style="display:flex;gap:8px"><button type="button" class="btn primary" data-click="toggle" data-target="#use-${t.id}">Start a project from this</button><button type="button" class="btn" data-click="deleteTemplate" data-id="${t.id}" data-name="${esc(t.name)}">Delete template</button></div>
      <form id="use-${t.id}" hidden data-form="fromTemplate" data-template-id="${t.id}" style="margin-top:12px">${banner("error")}
        <div class="field-row"><div class="field"><label>Project name</label><input name="name" required></div><div class="field"><label>Project ID</label><input name="number" required placeholder="e.g. DPM-2026-015"></div></div>
        <div class="field-row"><div class="field"><label>Project manager</label><select name="pmId" required>${userOptions("", "Select")}</select></div><div class="field"><label>Start date</label><input name="startDate" type="date" required value="${S.today}"></div></div>
        <div class="field"><label>Customer / product (optional)</label><input name="customer"></div>
        <button type="submit" class="btn primary" data-busy="Creating…">Create with ${plural(n, "task")}</button>
        ${faint(`Every task in “${esc(t.name)}” is copied with its owner, department, weight, planned effort and dependencies, and the dates are rebased onto the start date above. Nothing about progress is copied: the new project starts at 0%. A task whose owner has since been deactivated is given to the project manager to reassign.`, "margin-top:9px;margin-bottom:0")}
      </form></div>` : '<p style="font-size:12px;color:var(--text-faint);margin-top:10px;margin-bottom:0">You don’t have permission to create projects, so this template is read-only for you.</p>'}</div>`; }).join("")}
  </div>`;
}

function teamChatView() {
  return `${header("Team", "Chat", "One room for the whole team. For anything tied to specific work, use the Discussion tab on that project or the thread on that task instead — it keeps the conversation next to the job it belongs to.")}
  ${chatPanel({}, "Team room", "Everyone with an account can read and post here. Type @ and someone's User ID to notify them.", 520)}`;
}

function reportsView() {
  const projects = liveProjects(), tasks = liveTasks(), open = tasks.filter(isOpen);
  const row = (label, value, sub) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed var(--border);font-size:12.5px"><span>${esc(label)}</span><span class="tabular" style="display:flex;gap:8px;align-items:baseline">${value}${sub ? `<span style="color:var(--text-faint);font-size:11px">${sub}</span>` : ""}</span></div>`;
  const byOwner = new Map();
  for (const t of open) byOwner.set(t.owner_id, (byOwner.get(t.owner_id) || 0) + 1);
  const variances = tasks.filter((t) => t.est_minutes && S.timeTotals[t.id]).map((t) => ({ t, est: t.est_minutes, act: S.timeTotals[t.id] }))
    .sort((a, b) => b.act - b.est - (a.act - a.est)).slice(0, 15);
  const pms = [...new Set(S.projects.map((p) => p.pm_id))];
  return `${header("Reports", "Reports", "Every export below is a CSV that Excel opens directly, and contains exactly the projects you have permission to see — not everything in the database. Templates are excluded from every figure on this page.")}
  <div class="toolbar" style="margin-bottom:16px"><span class="toolbar-label">Export</span>
    <button type="button" class="btn" data-click="exportProjects">Projects</button><button type="button" class="btn" data-click="exportTasks">Tasks</button>
    <button type="button" class="btn" data-click="exportTime">Time log</button><button type="button" class="btn" data-click="exportDelays">Delay analysis</button></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:16px">
    <div class="card panel"><h3>Project report</h3>${row("Total projects", projects.length)}${row("Active", projects.filter((p) => p.status === "ACTIVE").length)}${row("Completed", projects.filter((p) => p.status === "COMPLETED").length)}${row("Delayed", projects.filter((p) => health(p) === "DELAYED").length)}${row("At risk", projects.filter((p) => health(p) === "AT_RISK").length)}</div>
    <div class="card panel"><h3>Task report</h3>${row("Total tasks", tasks.length)}${row("Completed", tasks.filter((t) => t.status === "COMPLETED").length)}${row("Pending", open.length)}${row("Overdue", tasks.filter(isOverdue).length)}</div>
    <div class="card panel"><h3>Tasks by owner (open)</h3>${[...byOwner].map(([id, n]) => row(userName(id), n)).join("") || '<p style="color:var(--text-faint);font-size:12.5px">No open tasks.</p>'}</div>
    <div class="card panel"><h3>Department workload (open tasks)</h3>${(S.settings.departments || []).map((d) => { const ts = open.filter((t) => t.department === d.name); return row(d.name, ts.length, `${ts.filter(isOverdue).length} overdue`); }).join("")}</div>
    <div class="card panel" style="grid-column:1 / -1"><h3>Planned versus actual effort</h3>
      ${variances.length ? `<table class="grid"><thead><tr><th>Task</th><th>Project</th><th>Owner</th><th>Planned</th><th>Actual</th><th>Difference</th><th>% of plan</th></tr></thead><tbody>
        ${variances.map(({ t, est, act }) => `<tr><td><a href="#/projects/${t.project_id}/tasks/${t.id}" style="text-decoration:none;font-weight:500">${esc(t.name)}</a></td><td>${esc(byProject.get(t.project_id).name)}</td><td>${esc(userName(t.owner_id))}</td>
          <td class="tabular">${hours(est)}</td><td class="tabular">${hours(act)}</td><td class="tabular" style="color:${act > est ? "var(--danger)" : "var(--ok)"}">${act > est ? "+" : "−"}${hours(Math.abs(act - est))}</td><td class="tabular">${Math.round((act / est) * 100)}%</td></tr>`).join("")}</tbody></table>`
        : '<p style="color:var(--text-faint);font-size:12.5px;margin:0">Nothing to compare yet. A task appears here once it has both a planned effort (set on the task form) and some logged time. Tasks with no estimate are deliberately left out rather than counted as zero — an unestimated task is unknown, not free.</p>'}
      ${faint("Worst overrun first. This is the report that makes the next estimate better — if a kind of task is consistently 40% over, the plan is wrong, not the people.", "margin-top:10px")}</div>
    <div class="card panel" style="grid-column:1 / -1"><h3>Project Manager report</h3><table class="grid"><thead><tr><th>Project Manager</th><th>Projects</th><th>Active</th><th>Delayed</th><th>At risk</th></tr></thead><tbody>
      ${pms.map((id) => { const ps = S.projects.filter((p) => p.pm_id === id); return `<tr><td>${esc(userName(id))}</td><td class="tabular">${ps.length}</td><td class="tabular">${ps.filter((p) => p.status === "ACTIVE").length}</td><td class="tabular">${ps.filter((p) => health(p) === "DELAYED").length}</td><td class="tabular">${ps.filter((p) => health(p) === "AT_RISK").length}</td></tr>`; }).join("")}</tbody></table></div>
  </div>`;
}

async function notificationsView() {
  const { items } = await api("notifications");
  const LABEL = { TASK_ASSIGNED: "Assigned", TASK_DUE_SOON: "Due soon", TASK_OVERDUE: "Overdue", TASK_COMPLETED: "Completed", MENTIONED: "Mention" };
  const TONES = { TASK_OVERDUE: "danger", TASK_DUE_SOON: "warn", TASK_ASSIGNED: "accent", MENTIONED: "accent", TASK_COMPLETED: "ok" };
  const unread = items.filter((n) => !n.is_read).length;
  return `${header("Notifications", "What needs your attention", `${unread ? `${unread} unread of the last ${items.length}.` : "Nothing unread."} Due-soon and overdue notices are raised once per task per day.`)}
  <div class="toolbar" style="margin-bottom:12px"><button type="button" class="btn" data-click="markAllRead" ${unread ? "" : "disabled"}>Mark all read</button><button type="button" class="btn" data-click="clearRead">Clear read</button></div>
  <div class="card panel">${items.length ? "" : '<p style="color:var(--text-faint);font-size:12.5px;margin:0">No notifications yet. You’ll get one when a task is assigned to you, when something you own is due or overdue, and when someone @mentions your User ID in a discussion.</p>'}
  <div style="display:flex;flex-direction:column">${items.map((n) => `<div style="display:flex;gap:12px;align-items:flex-start;padding:11px 4px;border-bottom:1px solid var(--border);background:${n.is_read ? "transparent" : "var(--pick-bg)"}">
    <span class="chip ${TONES[n.type] ?? "neutral"}" style="margin-top:1px;flex-shrink:0">${LABEL[n.type] ?? esc(n.type)}</span>
    <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:${n.is_read ? 400 : 600}">${n.link ? `<a href="${esc(n.link)}" style="text-decoration:none;color:inherit">${esc(n.message)}</a>` : esc(n.message)}</div>
      <div class="tabular" style="font-size:11px;color:var(--text-faint);margin-top:3px">${fmtWhen(n.created_at)}</div></div>
    ${n.is_read ? "" : `<button type="button" class="btn" style="padding:3px 9px;font-size:11px" data-click="markRead" data-id="${n.id}">Mark read</button>`}</div>`).join("")}</div></div>`;
}

function searchView(r) {
  const q = (r.query.get("q") || "").trim(), ql = q.toLowerCase();
  const people = canAdmin("VIEW");
  const hits = { Projects: [], Tasks: [], People: [] };
  if (q.length >= 2) {
    for (const p of liveProjects()) if ((p.name.toLowerCase().includes(ql) || p.number.toLowerCase().includes(ql)) && canProject("VIEW", p))
      hits.Projects.push([p.name, `${p.number} · ${humanize(p.status)}`, `#/projects/${p.id}/overview`]);
    for (const t of liveTasks()) { const p = byProject.get(t.project_id); if (t.name.toLowerCase().includes(ql) && canProject("VIEW", p)) hits.Tasks.push([t.name, `${p.name} · ${humanize(t.status)}`, `#/projects/${p.id}/tasks/${t.id}`]); }
    if (people) for (const u of S.users) if (u.name.toLowerCase().includes(ql) || u.login_id.toLowerCase().includes(ql)) hits.People.push([u.name, `${u.login_id} · ${u.role}${u.active ? "" : " · deactivated"}`, "#/admin/users"]);
  }
  const count = hits.Projects.length + hits.Tasks.length + hits.People.length;
  return `${header("Search", q ? `Results for “${esc(q)}”` : "Search", !q ? "Type in the box at the top of the screen to find a project, a task, or a person." : q.length < 2 ? "Type at least two characters." : `${plural(count, "result")}. Only things you have permission to open are listed.`)}
  <form data-form="search" style="margin-bottom:16px;max-width:480px"><div style="display:flex;gap:8px"><input type="search" name="q" value="${esc(q)}" placeholder="Project, task or person…"><button type="submit" class="btn primary">Search</button></div></form>
  ${q.length >= 2 && !count ? `<div class="card panel"><p style="margin:0;font-size:13px">Nothing matched. Search looks at project names and numbers, task names${people ? ", and people's names and User IDs" : ""} — not descriptions or discussion messages.</p></div>` : ""}
  ${Object.entries(hits).filter(([, l]) => l.length).map(([k, l]) => `<div class="card panel" style="margin-bottom:16px"><h3>${k} <span style="font-weight:400;color:var(--text-faint)">(${l.length})</span></h3>
    ${l.slice(0, 20).map(([t, s, href]) => `<a href="${href}" style="display:block;padding:9px 0;border-bottom:1px dashed var(--border);text-decoration:none;color:inherit"><div style="font-size:13px;font-weight:600">${esc(t)}</div><div style="font-size:11.5px;color:var(--text-muted)">${esc(s)}</div></a>`).join("")}</div>`).join("")}`;
}

async function recycleView() {
  const { projects, tasks, subtasks } = await api("recycleList");
  const left = (d) => `${Math.max(0, Math.ceil(30 - (Date.now() - new Date(d)) / 864e5))} days`;
  const table = (title, first, second, rows, kind) => rows.length ? `<div class="card panel" style="margin-bottom:16px;overflow-x:auto"><h3>${title}</h3><table class="grid"><thead><tr><th>${first}</th>${second ? `<th>${second}</th>` : ""}<th>Deleted</th><th>Removed in</th><th></th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td style="font-weight:600">${kind === "project" ? `<div class="stack"><span>${esc(x.name)}</span><span class="proj-id">${esc(x.number)}</span></div>` : esc(x.name)}</td>${second ? `<td>${esc(x.parent)}</td>` : ""}
      <td class="tabular">${fmtDate(String(x.deleted_at).slice(0, 10))}</td><td class="tabular">${left(x.deleted_at)}</td><td><button type="button" class="btn" data-click="restore" data-kind="${kind}" data-id="${x.id}">Restore</button></td></tr>`).join("")}</tbody></table></div>` : "";
  const empty = !projects.length && !tasks.length && !subtasks.length;
  return `${header("Workspace", "Recycle bin", "Deleted projects, tasks and subtasks stay here for 30 days and can be put back. Restoring a task also returns its weight to the project’s completion figure.")}
  ${empty ? '<div class="card panel"><p style="color:var(--text-faint);font-size:13px;margin:0">Nothing has been deleted. Anything you delete will appear here.</p></div>' : ""}
  ${table("Projects", "Project", null, projects, "project")}${table("Tasks", "Task", "Project", tasks, "task")}${table("Subtasks", "Subtask", "Task", subtasks, "subtask")}`;
}

function changePasswordForm() {
  return `<form data-form="changePassword">${banner("error")}
    <div class="field"><label>Current password</label><input name="currentPassword" type="password" required maxlength="20" autocomplete="current-password"></div>
    <div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="4" maxlength="20" autocomplete="new-password">${faint("4 to 20 characters.", "margin:4px 0 0")}</div>
    <div class="field"><label>Confirm new password</label><input name="confirmPassword" type="password" required minlength="4" maxlength="20" autocomplete="new-password"></div>
    <button type="submit" class="btn primary" style="width:100%;justify-content:center;padding:10px">Change password</button></form>`;
}
const changePasswordView = () => `${header("Account", "Change password")}<div class="card panel" style="max-width:420px">${changePasswordForm()}</div>`;

// ----- administration -----
function adminView(r, tab, sub) {
  if (!canAdmin("VIEW")) return noAccess("view Administration");
  const TABS = [["users", "Users"], ["roles", "Roles & Permissions"], ["departments", "Departments"], ["designations", "Designations"], ["stages", "Project Stages"], ["business-rules", "Business Rules"]];
  const tabs = `<div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:16px;overflow-x:auto">${TABS.map(([k, l]) => `<a href="#/admin/${k}" style="font-size:12.5px;font-weight:${k === tab ? 700 : 500};color:${k === tab ? "var(--accent)" : "var(--text-muted)"};padding:10px 14px;text-decoration:none;white-space:nowrap">${esc(l)}</a>`).join("")}</div>`;
  let body = "";
  if (tab === "users" && sub === "new") body = newUserView();
  else if (tab === "users") body = usersView();
  else if (tab === "roles") body = rolesView();
  else if (tab === "departments" || tab === "designations") body = listAdminView(tab);
  else if (tab === "stages") body = stagesView();
  else if (tab === "business-rules") body = rulesView();
  return tabs + body;
}

function usersView() {
  if (!canAdmin("MANAGE_USERS")) return noAccess("manage users");
  const sorted = [...S.users].sort((a, b) => a.name.localeCompare(b.name));
  return `${header("Administration", "Users", "Add the people who need access, each with their own User ID and password. Every change here writes to the audit trail like any other edit.")}
  <div style="margin-bottom:16px"><a href="#/admin/users/new" class="btn primary">+ Create user</a></div>
  <div class="card panel" style="overflow-x:auto"><table class="grid"><thead><tr><th>Name</th><th>User ID</th><th>Department</th><th>Designation</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
  ${sorted.map((u) => { const master = u.id === S.settings.masterUserId, self = u.id === S.me.id; return `<tr><td>${esc(u.name)}${master ? '<span class="chip accent" style="margin-left:8px;font-size:10.5px">Master</span>' : ""}</td>
    <td class="tabular">${esc(u.login_id)}</td><td>${esc(u.department ?? "—")}</td><td>${esc(u.designation ?? "—")}</td><td>${esc(u.role)}</td>
    <td>${chip(u.active ? "ACTIVE" : "CANCELLED", u.active ? "Active" : "Deactivated")}</td>
    <td><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      ${!self && !master ? `<button type="button" class="btn" style="font-size:11.5px;padding:5px 9px" data-click="setUserActive" data-id="${u.id}" data-active="${u.active ? "" : "1"}">${u.active ? "Deactivate" : "Reactivate"}</button>` : ""}
      <form data-form="setUserPassword" data-user-id="${u.id}" style="display:flex;gap:6px;align-items:center">${banner("error")}<input name="password" placeholder="New password" minlength="4" maxlength="20" autocomplete="off" style="width:130px;font-size:11.5px;padding:5px 8px" required><button type="submit" class="btn" style="font-size:11.5px;padding:5px 9px">Set password</button></form>
    </div></td></tr>`; }).join("")}
  </tbody></table></div>`;
}

function newUserView() {
  if (!canAdmin("MANAGE_USERS")) return noAccess("manage users");
  return `${header("Administration", "Create user")}<div class="card panel" style="max-width:640px"><form data-form="createUser">${banner("error")}
    <div class="field"><label>Full name</label><input name="name" required maxlength="200"></div>
    <div class="field-row"><div class="field"><label>User ID</label><input name="loginId" required maxlength="12" pattern="[a-zA-Z0-9]+" autocomplete="off">${faint("Letters and numbers only, up to 12 characters. This is what they sign in with.", "margin:4px 0 0")}</div>
      <div class="field"><label>Password</label><input name="password" required minlength="4" maxlength="20" autocomplete="off">${faint("4 to 20 characters. Shown as you type so you can pass it on — they can change it later.", "margin:4px 0 0")}</div></div>
    <div class="field"><label>Email (optional)</label><input name="email" type="email">${faint("Leave this blank if they don’t have one — it isn’t used to sign in, only the User ID is.", "margin:4px 0 0")}</div>
    <div class="field-row"><div class="field"><label>Department</label><select name="department">${options(activeList("departments"), "", "—")}</select></div>
      <div class="field"><label>Designation</label><select name="designation">${options(activeList("designations"), "", "—")}</select></div></div>
    <div class="field"><label>Role</label><select name="role" required><option value="" disabled selected>Select a role</option>${options(Object.keys(S.settings.roles || {}).sort())}</select>
      ${faint("The role decides what they can see and do — pick Administrator only for someone who should have every permission, like the master account.", "margin:4px 0 0")}</div>
    <button type="submit" class="btn primary" data-busy="Creating…">Create user</button></form></div>`;
}

function rolesView() {
  const roles = Object.entries(S.settings.roles || {}).sort(([a], [b]) => a.localeCompare(b));
  const M = [["PROJECT", "Project level", ["VIEW", "CREATE", "EDIT", "DELETE", "SHARE", "EXPORT"]], ["TASK", "Task level", ["VIEW", "CREATE", "EDIT", "DELETE", "ASSIGN", "APPROVE"]],
    ["DOCUMENT", "Document level", ["VIEW", "CREATE", "DELETE", "SHARE", "EXPORT"]], ["ADMIN", "Administrative level", ["VIEW", "EDIT", "MANAGE_USERS"]]];
  const cell = "border:1px solid var(--border);padding:8px 10px";
  return `${header("Administration", "Roles &amp; permissions", "A new role starts with every box unchecked — least privilege by default. This matrix manages org-wide (all-scope) grants; the “own project”, “own task” and “department” grants that make a Project Manager’s or a department role’s day-to-day work are seeded correctly and aren’t independently editable here.")}
  <div class="card panel" style="max-width:480px;margin-bottom:16px"><form data-form="createRole" style="display:flex;gap:8px">${banner("error")}<input name="name" placeholder="New role name" required><button type="submit" class="btn primary">Add role</button></form></div>
  ${M.map(([res, title, acts]) => `<div class="card panel" style="margin-bottom:16px;overflow-x:auto"><h3>${title}</h3><table class="matrix" style="width:100%;font-size:12px;border-collapse:collapse">
    <thead><tr><th style="${cell};text-align:left">Role</th>${acts.map((a) => `<th style="${cell}">${a}</th>`).join("")}</tr></thead><tbody>
    ${roles.map(([name, grants]) => `<tr><td style="${cell};font-weight:500">${esc(name)}</td>${acts.map((a) => `<td style="${cell};text-align:center"><input type="checkbox" style="width:15px;height:15px" data-change="toggleGrant" data-role="${esc(name)}" data-resource="${res}" data-act="${a}" ${grants.includes(`${res}:${a}:ALL`) ? "checked" : ""}></td>`).join("")}</tr>`).join("")}
  </tbody></table></div>`).join("")}`;
}

function listAdminView(list) {
  const title = list === "departments" ? "Departments" : "Designations";
  return `${header("Administration", title)}
  <div class="card panel" style="max-width:480px;margin-bottom:16px"><form data-form="addListItem" data-list="${list}" style="display:flex;gap:8px">${banner("error")}<input name="name" placeholder="New ${list === "departments" ? "department" : "designation"} name" required><button type="submit" class="btn primary">Add</button></form></div>
  <div class="card panel"><table class="grid"><thead><tr><th>Name</th><th>Status</th><th></th></tr></thead><tbody>
  ${[...(S.settings[list] || [])].sort((a, b) => a.name.localeCompare(b.name)).map((d) => `<tr><td>${esc(d.name)}</td><td>${chip(d.active ? "ACTIVE" : "CANCELLED", d.active ? "Active" : "Deactivated")}</td>
    <td><button type="button" class="btn" style="font-size:11.5px;padding:5px 9px" data-click="toggleListItem" data-list="${list}" data-name="${esc(d.name)}">${d.active ? "Deactivate" : "Reactivate"}</button></td></tr>`).join("")}
  </tbody></table></div>`;
}

function stagesView() {
  const stages = [...(S.settings.stages || [])].sort((a, b) => a.seq - b.seq);
  return `${header("Administration", "Project stages", "The master stage sequence every new project follows. Reordering here doesn't rewrite the stage of projects already in flight.")}
  <div class="card panel" style="max-width:480px;margin-bottom:16px"><form data-form="addStage" style="display:flex;gap:8px">${banner("error")}<input name="name" placeholder="New stage name" required><button type="submit" class="btn primary">Add stage</button></form></div>
  <div class="card panel"><div style="display:flex;flex-direction:column;gap:6px">${stages.map((s) => `<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;opacity:${s.active ? 1 : 0.5}">
    <input type="number" value="${s.seq}" style="width:56px" data-change="stageSeq" data-name="${esc(s.name)}"><span style="flex:1">${esc(s.name)}</span>
    <button type="button" class="btn" style="font-size:11px;padding:4px 8px" data-click="toggleStage" data-name="${esc(s.name)}">${s.active ? "Deactivate" : "Reactivate"}</button></div>`).join("")}</div></div>`;
}

function rulesView() {
  const r = rules();
  return `${header("Administration", "Business rules", "These thresholds drive project health and the overdue flag — changing them here is a data change, not a code change.")}
  <div class="card panel" style="max-width:480px"><form data-form="saveRules">${banner("error")}
    <div class="field"><label>At-risk threshold (days before target date)</label><input name="atRiskThresholdDays" type="number" min="0" value="${r.atRiskThresholdDays}"></div>
    <div class="field"><label>Overdue grace period (days)</label><input name="overdueGraceDays" type="number" min="0" value="${r.overdueGraceDays}"></div>
    <div class="field"><label>Default task weight</label><input name="defaultTaskWeight" type="number" min="0.01" max="9999" step="any" value="${r.defaultTaskWeight}"></div>
    <button type="submit" class="btn primary">Save</button></form></div>`;
}

// ----- sign-in screens -----
function authScreen(kind, note) {
  timers.forEach(clearInterval);
  const card = (title, sub, body) => `<div class="auth-wrap"><div class="card auth-card"><div class="brand-mark" style="width:42px;height:42px;border-radius:11px;font-size:16px;margin-bottom:16px">DP</div>
    <h3 style="font-size:16px;margin-bottom:4px">${title}</h3><p style="font-size:12px;color:var(--text-muted);margin:0 0 18px">${sub}</p>${body}</div></div>`;
  const full = 'class="btn primary" style="width:100%;justify-content:center;padding:10px"';
  if (kind === "setup")
    app.innerHTML = card("Create the master account", "This is the first sign-in for this site. The account you create here has every permission.", `<form data-form="setup">${banner("error")}
      <div class="field"><label>User ID</label><input name="loginId" required maxlength="12" pattern="[a-zA-Z0-9]+" autocomplete="username" autofocus>${faint("Letters and numbers only, up to 12 characters.", "margin:4px 0 0")}</div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="4" maxlength="20" autocomplete="new-password">${faint("4 to 20 characters.", "margin:4px 0 0")}</div>
      <div class="field"><label>Confirm password</label><input name="confirmPassword" type="password" required minlength="4" maxlength="20" autocomplete="new-password"></div>
      <div class="field"><label>Display name (optional)</label><input name="name" maxlength="200" placeholder="Shown in the header and on records"></div>
      <button type="submit" ${full}>Create master account</button></form>`);
  else if (kind === "login")
    app.innerHTML = card("Sign in", "Use your User ID and password.", `${note ? `<div class="form-banner success" style="margin-bottom:14px">${esc(note)}</div>` : ""}<form data-form="login">${banner("error")}
      <div class="field"><label>User ID</label><input name="loginId" required maxlength="12" autocomplete="username" autofocus></div>
      <div class="field"><label>Password</label><input name="password" type="password" required maxlength="20" autocomplete="current-password"></div>
      <button type="submit" ${full} data-busy="Signing in…">Sign in</button></form>
      ${faint("Forgotten your password? Ask the master account holder to set a new one for you.", "margin-top:14px")}`);
  else app.innerHTML = card("Change your password", "Choose a new password before you continue.", changePasswordForm());
}

// ---------- CSV exports (built in the browser from data you can already see) ----------
function downloadCsv(base, headers, rows) {
  const cell = (v) => { const t = v == null ? "" : String(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const safe = (v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v);
  const csv = "\ufeff" + [headers, ...rows.map((r) => headers.map((h) => safe(r[h])))].map((r) => r.map(cell).join(",")).join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: `${base}-${S.today}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const viewable = () => liveProjects().filter((p) => canProject("VIEW", p));
const EXPORTS = {
  projects() {
    const H = ["Project Number", "Project Name", "Customer / Product", "Project Manager", "Status", "Health", "Priority", "Completion %", "Start Date", "Target Completion", "Actual Completion", "Total Tasks", "Open Tasks", "Overdue Tasks", "Remarks"];
    downloadCsv("projects", H, viewable().sort((a, b) => a.number.localeCompare(b.number)).map((p) => {
      const ts = tasksOf(p.id);
      return { "Project Number": p.number, "Project Name": p.name, "Customer / Product": p.customer, "Project Manager": userName(p.pm_id), Status: p.status, Health: health(p), Priority: p.priority,
        "Completion %": projectPct(p), "Start Date": p.start_date, "Target Completion": p.target_date, "Actual Completion": p.actual_date, "Total Tasks": ts.length,
        "Open Tasks": ts.filter(isOpen).length, "Overdue Tasks": ts.filter(isOverdue).length, Remarks: p.remarks };
    }));
  },
  tasks({ project, mine }) {
    const ids = new Set(viewable().filter((p) => !project || p.id === project).map((p) => p.id));
    const H = ["Project Number", "Project", "Task", "Owner", "Department", "Status", "Priority", "Milestone", "Start Date", "Target Date", "Actual Completion", "Completion %", "Weight", "Subtasks", "Planned Effort", "Logged Effort", "Remarks"];
    downloadCsv(mine ? "my-tasks" : project ? "project-tasks" : "tasks", H, liveTasks().filter((t) => ids.has(t.project_id) && (!mine || t.owner_id === S.me.id)).map((t) => {
      const p = byProject.get(t.project_id);
      return { "Project Number": p.number, Project: p.name, Task: t.name, Owner: userName(t.owner_id), Department: t.department, Status: isOverdue(t) ? "OVERDUE" : t.status, Priority: t.priority,
        Milestone: t.is_milestone ? "Yes" : "No", "Start Date": t.start_date, "Target Date": t.target_date, "Actual Completion": t.actual_date, "Completion %": taskPct(t), Weight: t.weight,
        Subtasks: subsOf(t.id).length, "Planned Effort": t.est_minutes ? hours(t.est_minutes) : "", "Logged Effort": hours(S.timeTotals[t.id] || 0), Remarks: t.remarks };
    }));
  },
  async time() {
    const { rows } = await api("timeLog");
    downloadCsv("time-log", ["Date", "Project Number", "Project", "Task", "Department", "Person", "User ID", "Hours", "Minutes", "Note"], rows.map((e) => ({
      Date: e.spent_on, "Project Number": e.project_number, Project: e.project_name, Task: e.task_name, Department: e.department, Person: e.user_name, "User ID": e.login_id,
      Hours: round2(e.minutes / 60), Minutes: e.minutes, Note: e.note })));
  },
  async delays() {
    const { rows } = await api("delayLog");
    downloadCsv("delay-analysis", ["Project Number", "Project", "Task", "Field", "Original Date", "Revised Date", "Slip (days)", "Reason", "Changed By", "Changed On"], rows.map((e) => ({
      "Project Number": e.project_number, Project: e.project_name, Task: e.task_name, Field: e.field, "Original Date": e.old_value, "Revised Date": e.new_value,
      "Slip (days)": /^\d{4}-/.test(e.old_value || "") && /^\d{4}-/.test(e.new_value || "") ? dayDiff(e.old_value.slice(0, 10), e.new_value.slice(0, 10)) : "",
      Reason: e.reason, "Changed By": e.user_name, "Changed On": e.created_at })));
  },
};

// ---------- form submissions ----------
function formData(form) {
  const o = { ...form.dataset };
  for (const [k, v] of new FormData(form)) {
    if (v instanceof File) continue;
    if (k.endsWith("[]")) (o[k.slice(0, -2)] ||= []).push(v);
    else o[k] = v;
  }
  for (const c of $$('input[type="checkbox"][name]', form)) if (!c.name.endsWith("[]")) o[c.name] = c.checked;
  return o;
}
const FORMS = {
  async setup(d) { await api("setup", d); authScreen("login", "Master account created. Sign in below with the User ID and password you just chose."); },
  async login(d) { await api("login", d); await boot(); },
  async changePassword(d) { await api("changePassword", d); if (S) await reload("Password changed."); else { location.hash = "#/dashboard"; await boot(); } },
  filter(_d, form) {
    const qs = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) qs.set(k, v);
    location.hash = form.dataset.base + (qs.toString() ? "?" + qs : "");
  },
  search(d) { location.hash = "#/search?q=" + encodeURIComponent(d.q || ""); },
  async createProject(d) { const { id } = await api("createProject", d); await reload(null, `#/projects/${id}/overview`); },
  async projectStatus(d) { await api("updateProjectStatus", d); await reload("Status saved."); },
  async projectDates(d) { const r = await api("updateProjectDates", d); await reload(r.message); },
  async saveTemplate(d) { const r = await api("saveTemplate", d); await reload(r.message); },
  async fromTemplate(d) { const { id } = await api("fromTemplate", d); await reload(null, `#/projects/${id}/overview`); },
  async createTask(d) { await api("createTask", d); await reload(null, `#/projects/${d.projectId}/tasks`); },
  async updateTask(d) { await api("updateTask", d); await reload("Task saved."); },
  async bulk(d) { const r = await api("bulkUpdate", d); await reload(r.message); },
  async createSubtask(d) { await api("createSubtask", d); await reload(); },
  async updateSubtask(d) { await api("updateSubtask", d); await reload(); },
  async addDep(d) { const r = await api("addDep", d); await reload(r.message); },
  async logTime(d) { const r = await api("logTime", d); await reload(r.message); },
  async saveView(d) { const r = await api("saveView", { ...d, scope: "project-tasks" }); await reload(r.message); },
  async chatSend(d, form) {
    const panel = form.closest(".chat-panel");
    const { messages } = await api("postMessage", { scope: JSON.parse(panel.dataset.scope), body: d.body });
    form.reset();
    $(".chat-hint", panel).textContent = "Type @ and someone’s User ID (not their name) to notify them — for example @rahul.";
    paintChat(panel, messages);
  },
  async upload(d, form) {
    const file = $('input[type="file"]', form).files[0];
    if (!file) throw new Error("Choose a file to upload.");
    if (file.size > 4 * 1024 * 1024) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 4 MB — put larger files on the shared drive and link them in the description.`);
    const res = await fetch(`/api/upload?project=${encodeURIComponent(d.projectId)}&category=${encodeURIComponent(d.category || "")}`, {
      method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
    });
    const out = await res.json().catch(() => ({ error: "Upload failed." }));
    if (!res.ok || out.error) throw new Error(out.error || "Upload failed.");
    flash = { text: out.message };
    await render();
  },
  async createUser(d) { const r = await api("createUser", d); await reload(`Created ${r.loginId}. Give them that User ID and the password you set — they can change the password themselves once they’re signed in.`, "#/admin/users"); },
  async setUserPassword(d) { const r = await api("setUserPassword", d); await reload(r.message); },
  async createRole(d) { await api("createRole", d); await reload(); },
  async addListItem(d) { await api("addListItem", d); await reload(); },
  async addStage(d) { await api("addStage", d); await reload(); },
  async saveRules(d) { const r = await api("saveRules", d); await reload(r.message); },
};

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const msg = $("[data-banner]", form);
  if (msg) msg.hidden = true;
  const btn = $('button[type="submit"]', form);
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = btn.dataset.busy || "Saving…"; }
  try {
    await FORMS[form.dataset.form](formData(form), form);
  } catch (err) {
    if (msg && msg.isConnected) { msg.textContent = err.message; msg.className = "form-banner error"; msg.hidden = false; }
    else alert(err.message);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
});

// ---------- buttons ----------
const confirmThen = (text, fn) => (confirm(text) ? fn() : null);
const CLICKS = {
  toggle: (d) => { const el = $(d.target); if (el) el.hidden = !el.hidden; },
  signOut: async () => { await api("logout"); S = null; authScreen("login"); location.hash = ""; },
  deleteTask: (d) => confirmThen(`Delete "${d.name}"${d.subtasks ? " and its subtasks" : ""}? It can be restored from the Recycle Bin.`, async () => {
    const t = byTask.get(d.id);
    await api("deleteTask", { taskId: d.id });
    await reload(null, `#/projects/${t.project_id}/tasks`);
  }),
  deleteSubtask: (d) => confirmThen(`Delete subtask "${d.name}"? It can be restored from the Recycle Bin.`, async () => { await api("deleteSubtask", { subtaskId: d.id }); await reload(); }),
  moveTask: async (d) => { await api("moveTask", { taskId: d.id, status: d.status }); await reload(); },
  removeDep: async (d) => { await api("removeDep", { taskId: d.task, depId: d.id }); await reload(); },
  deleteTime: async (d) => { await api("deleteTime", { entryId: d.id }); await reload(); },
  deleteDoc: (d) => confirmThen(`Remove "${d.name}"?`, async () => { await api("deleteDoc", { docId: d.id }); await render(); }),
  deleteTemplate: (d) => confirmThen(`Delete the template "${d.name}"? It can be restored from the Recycle Bin.`, async () => { await api("deleteTemplate", { templateId: d.id }); await reload(); }),
  deleteView: async (d) => { await api("deleteView", { viewId: d.id }); await reload(); },
  deleteMessage: async (d, el) => {
    const panel = el.closest(".chat-panel");
    const { messages } = await api("deleteMessage", { messageId: d.id, scope: JSON.parse(panel.dataset.scope) });
    paintChat(panel, messages);
  },
  markRead: async (d) => { await api("markRead", { id: d.id }); await reload(); },
  markAllRead: async () => { await api("markAllRead"); await reload(); },
  clearRead: async () => { await api("clearRead"); await reload(); },
  restore: async (d) => { const r = await api("restore", { kind: d.kind, id: d.id }); await reload(r.message); },
  setUserActive: async (d) => { await api("setUserActive", { userId: d.id, active: !!d.active }); await reload(); },
  toggleListItem: async (d) => { await api("toggleListItem", { list: d.list, name: d.name }); await reload(); },
  toggleStage: async (d) => { await api("updateStage", { name: d.name, toggle: true }); await reload(); },
  exportProjects: () => EXPORTS.projects(),
  exportTasks: (d) => EXPORTS.tasks(d),
  exportTime: () => EXPORTS.time(),
  exportDelays: () => EXPORTS.delays(),
};
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-click]");
  if (!el || el.disabled) return;
  e.preventDefault();
  try {
    await CLICKS[el.dataset.click]({ ...el.dataset }, el);
  } catch (err) {
    alert(err.message);
  }
});

// ---------- checkboxes, inputs ----------
function updateBulkBar() {
  const n = $$('input[name="taskIds[]"]:checked').length;
  const bar = $("#bulk-bar");
  if (!bar) return;
  bar.style.opacity = n ? 1 : 0.55;
  $("#bulk-title").textContent = n ? `Change ${plural(n, "selected task")}` : "Tick tasks above to change several at once";
  $("#bulk-apply").disabled = !n;
  $$('input[name="taskIds[]"]').forEach((c) => (c.closest("tr").style.background = c.checked ? "var(--pick-bg)" : ""));
}
const CHANGES = {
  pickRow: updateBulkBar,
  pickAll: (_d, el) => { $$('input[name="taskIds[]"]').forEach((c) => (c.checked = el.checked)); updateBulkBar(); },
  toggleGrant: async (d, el) => { el.disabled = true; try { await api("toggleGrant", { role: d.role, resource: d.resource, act: d.act, grant: el.checked }); S = await api("load"); index(); } finally { el.disabled = false; } },
  stageSeq: async (d, el) => { await api("updateStage", { name: d.name, seq: el.value }); await reload(); },
};
document.addEventListener("change", async (e) => {
  const el = e.target.closest("[data-change]");
  if (!el) return;
  try {
    await CHANGES[el.dataset.change]({ ...el.dataset }, el);
  } catch (err) {
    alert(err.message);
  }
});
document.addEventListener("input", (e) => {
  if (!e.target.matches("[data-chat-input]")) return;
  const handles = [...new Set([...e.target.value.matchAll(mentionRe)].map((m) => "@" + m[1].toLowerCase()))];
  e.target.closest(".chat-panel").querySelector(".chat-hint").innerHTML = handles.length
    ? `Will notify: <strong>${esc(handles.join(", "))}</strong> — anyone named who can’t see this conversation is skipped.`
    : "Type @ and someone’s User ID (not their name) to notify them — for example @rahul.";
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.matches("[data-chat-input]")) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

// ---------- start ----------
window.addEventListener("hashchange", () => S && render());
async function boot() {
  try {
    const s = await api("session");
    if (s.setupNeeded) return authScreen("setup");
    if (!s.me) return authScreen("login");
    if (s.me.mustChangePassword) { S = null; return authScreen("change"); }
    await reload();
  } catch (e) {
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><div class="form-banner error">${esc(e.message)}</div><button class="btn" onclick="location.reload()">Try again</button></div></div>`;
  }
}
boot();
