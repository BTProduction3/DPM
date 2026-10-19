// DPM backend — one file. The browser sends POST /api {action, ...} and gets JSON back.
// Also: POST /api/upload (document upload) and GET /api/doc/<id> (document download).
import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";
const COOKIE = "dpm";
const SESSION_DAYS = 30;
const MAX_FILE = 4 * 1024 * 1024;
const RECYCLE_DAYS = 30;
const OPEN = ["COMPLETED", "CANCELLED"];
const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED", "DELAYED"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PROJECT_STATUSES = ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"];
const DEP_TYPES = ["FINISH_TO_START", "START_TO_START", "FINISH_TO_FINISH"];
const STALE = "Someone else changed this since you opened it. Reload the page and make your change again.";

// ---------- small helpers ----------
let db;
const q = async (text, params = []) => (await (db ??= getDatabase()).pool.query(text, params)).rows;
const one = async (text, params) => (await q(text, params))[0] ?? null;
const newId = () => crypto.randomUUID();
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (d, n) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

class Fail extends Error {}
const fail = (m) => {
  throw new Fail(m);
};
const str = (v, max = 4000) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const need = (v, msg, max = 200) => str(v, max) ?? fail(msg);
const date = (v, msg) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? v : fail(msg));
const num = (v, min, max, msg, def) => {
  if (v === "" || v == null) return def !== undefined ? def : fail(msg);
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fail(msg);
};
const oneOf = (v, list, msg) => (list.includes(v) ? v : fail(msg));
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// ---------- settings ----------
async function loadSettings() {
  const rows = await q("select key, value from settings");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
const setSetting = (key, value) =>
  q("insert into settings(key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value", [
    key,
    JSON.stringify(value),
  ]);
async function secretOf(S) {
  if (S.secret) return S.secret;
  await q("insert into settings(key, value) values ('secret', $1::jsonb) on conflict do nothing", [
    JSON.stringify(crypto.randomBytes(32).toString("hex")),
  ]);
  return (await one("select value from settings where key = 'secret'")).value;
}

// ---------- passwords & sessions ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPw(pw, stored) {
  const [v, s, k] = String(stored).split("$");
  if (v !== "s1" || !s || !k) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(s, "hex"), 32);
  const want = Buffer.from(k, "hex");
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}
const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url");
// The signature includes the password hash, so changing a password signs out every old session.
function sessionCookie(secret, user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = `${user.id}.${exp}.${sign(secret, `${user.id}.${exp}.${user.password_hash}`)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function currentUser(req, S, secret) {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [uid, exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  const u = await one("select * from users where id = $1", [uid]);
  if (!u || !u.active) return null;
  const want = sign(secret, `${uid}.${exp}.${u.password_hash}`);
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  return {
    id: u.id,
    loginId: u.login_id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department,
    designation: u.designation,
    mustChangePassword: u.must_change_password,
    isMaster: S.masterUserId === u.id,
    grants: (S.roles || {})[u.role] || [],
  };
}

// ---------- permissions (same rules as before, read from the roles setting) ----------
const has = (me, res, act, scope) => me.grants.includes(`${res}:${act}:${scope}`);
const canAdmin = (me, act) => has(me, "ADMIN", act, "ALL");
const canCreate = (me, res) => has(me, res, "CREATE", "ALL");
async function canProject(me, act, p) {
  if (has(me, "PROJECT", act, "ALL")) return true;
  if (p.pm_id === me.id && has(me, "PROJECT", act, "OWN")) return true;
  if (act === "VIEW" && me.department && has(me, "PROJECT", "VIEW", "DEPARTMENT")) {
    const hit = await one("select 1 from tasks where project_id = $1 and department = $2 and deleted_at is null limit 1", [
      p.id,
      me.department,
    ]);
    if (hit) return true;
  }
  return false;
}
function canTask(me, act, t, p) {
  if (has(me, "TASK", act, "ALL")) return true;
  if (p.pm_id === me.id && has(me, "TASK", act, "OWN")) return true;
  if (t.owner_id === me.id && has(me, "TASK", act, "OWN")) return true;
  if (t.department && t.department === me.department && has(me, "TASK", act, "DEPARTMENT")) return true;
  return false;
}
const deny = (ok, msg) => ok || fail(msg);

// ---------- shared record helpers ----------
const getProject = async (id) =>
  (await one("select * from projects where id = $1 and deleted_at is null", [id])) ?? fail("Project not found.");
async function getTask(id) {
  const t = (await one("select * from tasks where id = $1 and deleted_at is null", [id])) ?? fail("Task not found.");
  return { t, p: await getProject(t.project_id) };
}
const log = (me, e) =>
  q(
    `insert into activity (id, project_id, task_id, user_id, entity, entity_id, action, field, old_value, new_value, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [newId(), e.projectId ?? null, e.taskId ?? null, me.id, e.entity, e.entityId, e.action, e.field ?? null,
      e.oldValue ?? null, e.newValue ?? null, e.reason ?? null],
  );
async function notify(userId, type, message, link, actorId) {
  if (!userId || userId === actorId) return;
  await q("insert into notifications (id, user_id, type, message, link) values ($1,$2,$3,$4,$5)", [
    newId(), userId, type, message, link ?? null,
  ]);
}
const taskLink = (pid, tid) => `#/projects/${pid}/tasks/${tid}`;

// Due-soon and overdue notices for the person loading the app, once per task per day. No cron needed.
async function raiseDueNotices(me, S) {
  const t0 = today();
  const grace = Number(S.rules?.overdueGraceDays ?? 0);
  const since = `${t0} 00:00`;
  const base = `from tasks t join projects p on p.id = t.project_id
    where t.owner_id = $1 and t.deleted_at is null and p.deleted_at is null and not p.is_template
      and t.status not in ('COMPLETED','CANCELLED')`;
  const notYet = (type) => `and not exists (select 1 from notifications n where n.user_id = $1 and n.type = '${type}'
      and n.link = '#/projects/' || t.project_id || '/tasks/' || t.id and n.created_at >= ($3::timestamp at time zone '${TZ}'))`;
  await q(
    `insert into notifications (id, user_id, type, message, link)
     select gen_random_uuid()::text, $1, 'TASK_OVERDUE', '"' || t.name || '" is overdue.', '#/projects/' || t.project_id || '/tasks/' || t.id
     ${base} and t.target_date < $2 ${notYet("TASK_OVERDUE")}`,
    [me.id, addDays(t0, -grace), since],
  );
  await q(
    `insert into notifications (id, user_id, type, message, link)
     select gen_random_uuid()::text, $1, 'TASK_DUE_SOON', '"' || t.name || '" is due soon.', '#/projects/' || t.project_id || '/tasks/' || t.id
     ${base} and t.target_date >= $2 and t.target_date <= $4 ${notYet("TASK_DUE_SOON")}`,
    [me.id, t0, since, addDays(t0, 3)],
  );
}

// ---------- public actions (no sign-in needed) ----------
const PUBLIC = {
  async session(_b, { me }) {
    const anyone = await one("select 1 from users limit 1");
    return { me, setupNeeded: !anyone };
  },

  async setup(b, { S }) {
    if (await one("select 1 from users limit 1")) fail("Setup is already done. Sign in instead.");
    const loginId = need(b.loginId, "User ID is required", 12);
    if (!/^[a-zA-Z0-9]{1,12}$/.test(loginId)) fail("User ID can only contain letters and numbers — up to 12.");
    checkNewPassword(b.password, b.confirmPassword);
    const id = newId();
    await q("insert into users (id, login_id, name, password_hash, role) values ($1,$2,$3,$4,'Administrator')", [
      id, loginId, str(b.name, 200) || loginId, hashPw(b.password),
    ]);
    await setSetting("masterUserId", id);
    return { ok: true };
  },

  async login(b, { secret }) {
    const loginId = need(b.loginId, "Enter your User ID", 64);
    if (!b.password) fail("Enter your password");
    const u = await one("select * from users where lower(login_id) = lower($1)", [loginId]);
    const wrong = "That User ID and password don't match.";
    if (!u) fail(wrong);
    if (u.locked_until && new Date(u.locked_until) > new Date())
      fail("Too many sign-in attempts. Wait 15 minutes and try again, or ask an administrator to set a new password for you.");
    if (!checkPw(b.password, u.password_hash)) {
      const fails = u.failed_logins + 1;
      await q("update users set failed_logins = $2, locked_until = $3 where id = $1", [
        u.id, fails >= 8 ? 0 : fails, fails >= 8 ? new Date(Date.now() + 15 * 60000) : null,
      ]);
      fail(wrong);
    }
    if (!u.active) fail("This account has been deactivated. Ask an administrator.");
    await q("update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1", [u.id]);
    return { ok: true, __cookie: sessionCookie(secret, u) };
  },

  async logout() {
    return { ok: true, __cookie: clearCookie };
  },
};

function checkNewPassword(pw, confirm) {
  const p = String(pw ?? "");
  if (p.length < 4 || p.length > 20) fail("Password must be 4 to 20 characters.");
  if (confirm !== undefined && confirm !== p) fail("Passwords do not match.");
}

// ---------- signed-in actions ----------
const ACTIONS = {
  // Everything the screens need, in one call. Calculations (completion, health, overdue) happen in the browser.
  async load(_b, { me, S }) {
    await raiseDueNotices(me, S);
    const [users, projects, tasks, subtasks, time, unread] = await Promise.all([
      q("select id, login_id, name, email, role, department, designation, active from users order by name"),
      q("select * from projects where deleted_at is null order by target_date"),
      q(`select t.* from tasks t join projects p on p.id = t.project_id
         where t.deleted_at is null and p.deleted_at is null order by t.start_date`),
      q(`select s.* from subtasks s join tasks t on t.id = s.task_id join projects p on p.id = t.project_id
         where s.deleted_at is null and t.deleted_at is null and p.deleted_at is null order by s.start_date`),
      q("select task_id, sum(minutes)::int as minutes from time_entries group by task_id"),
      one("select count(*)::int as n from notifications where user_id = $1 and not is_read", [me.id]),
    ]);
    const { secret, ...settings } = S;
    settings.views = (S.views || []).filter((v) => v.ownerId === me.id || v.shared);
    return {
      me, users, projects, tasks, subtasks, settings, today: today(),
      timeTotals: Object.fromEntries(time.map((r) => [r.task_id, r.minutes])),
      unread: unread.n,
    };
  },

  async changePassword(b, { me, secret }) {
    const u = await one("select * from users where id = $1", [me.id]);
    if (!checkPw(b.currentPassword, u.password_hash)) fail("Your current password isn't right.");
    checkNewPassword(b.newPassword, b.confirmPassword);
    const hash = hashPw(b.newPassword);
    await q("update users set password_hash = $2, must_change_password = false where id = $1", [me.id, hash]);
    return { ok: true, __cookie: sessionCookie(secret, { ...u, password_hash: hash }) };
  },

  // ----- projects -----
  async createProject(b, { me, S }) {
    deny(canCreate(me, "PROJECT"), "You don't have permission to create projects.");
    const start = date(b.startDate, "Start date is required");
    const target = date(b.targetDate, "Target completion date is required");
    if (target < start) fail("Target completion date must be on or after the start date");
    const number = need(b.number, "Project ID is required", 50);
    if (await one("select 1 from projects where number = $1", [number])) fail("A project with this Project ID already exists.");
    const id = newId();
    await q(
      `insert into projects (id, number, name, description, customer, pm_id, start_date, target_date, priority, status, stage, remarks)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, number, need(b.name, "Project name is required"), str(b.description), str(b.customer, 200),
        need(b.pmId, "Project Manager is required"), start, target, oneOf(b.priority, PRIORITIES, "Choose a priority"),
        oneOf(b.status, PROJECT_STATUSES, "Choose a status"), firstStage(S), str(b.remarks)],
    );
    await log(me, { projectId: id, entity: "Project", entityId: id, action: "CREATED" });
    return { ok: true, id };
  },

  async updateProjectStatus(b, { me }) {
    const p = await getProject(b.projectId);
    deny(await canProject(me, "EDIT", p), "You don't have permission to change this project.");
    const status = oneOf(b.status, PROJECT_STATUSES, "Choose a status");
    if (status === p.status) return { ok: true };
    const r = await q(
      `update projects set status = $2, actual_date = $3, version = version + 1, updated_at = now()
       where id = $1 and version = $4 returning id`,
      [p.id, status, status === "COMPLETED" ? today() : p.actual_date, Number(b.version)],
    );
    if (!r.length) fail(STALE);
    await log(me, { projectId: p.id, entity: "Project", entityId: p.id, action: "STATUS_CHANGED", field: "status", oldValue: p.status, newValue: status });
    return { ok: true };
  },

  async updateProjectDates(b, { me }) {
    const p = await getProject(b.projectId);
    deny(canAdmin(me, "EDIT"), "Only Administrators can change this project's dates.");
    const start = date(b.startDate, "Start date is required");
    const target = date(b.targetDate, "Target completion date is required");
    if (target < start) fail("Target completion date must be on or after the start date");
    if (start === p.start_date && target === p.target_date) return { message: "No changes to save." };
    const r = await q(
      "update projects set start_date = $2, target_date = $3, version = version + 1, updated_at = now() where id = $1 and version = $4 returning id",
      [p.id, start, target, Number(b.version)],
    );
    if (!r.length) fail(STALE);
    const reason = str(b.reason, 1000);
    if (start !== p.start_date)
      await log(me, { projectId: p.id, entity: "Project", entityId: p.id, action: "DATE_CHANGED", field: "startDate", oldValue: p.start_date, newValue: start, reason });
    if (target !== p.target_date)
      await log(me, { projectId: p.id, entity: "Project", entityId: p.id, action: "DATE_CHANGED", field: "targetCompletionDate", oldValue: p.target_date, newValue: target, reason });
    return { message: "Project dates saved." };
  },

  async saveTemplate(b, { me }) {
    const p = await getProject(b.projectId);
    deny(await canProject(me, "VIEW", p), "Project not found.");
    deny(canCreate(me, "PROJECT"), "You don't have permission to create templates.");
    const name = need(b.name, "Give the template a name.");
    const number = need(b.number, "Give the template an ID.", 50);
    if (await one("select 1 from projects where number = $1", [number])) fail("That template ID is already in use.");
    const tasks = await q("select * from tasks where project_id = $1 and deleted_at is null order by start_date", [p.id]);
    if (tasks.length > 300) fail("A template can hold at most 300 tasks.");
    const id = newId();
    await q(
      `insert into projects (id, number, name, description, pm_id, start_date, target_date, priority, status, remarks, is_template)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'PLANNED',$9,true)`,
      [id, number, name, p.description, p.pm_id, p.start_date, p.target_date, p.priority, p.remarks],
    );
    await copyTasks(tasks, id, (t) => ({ owner: t.owner_id, start: t.start_date, target: t.target_date }));
    await log(me, { projectId: id, entity: "Project", entityId: id, action: "CREATED", field: "template", newValue: `template from ${p.name}` });
    return { message: `Saved as the template “${name}”.` };
  },

  async fromTemplate(b, { me, S }) {
    deny(canCreate(me, "PROJECT"), "You don't have permission to create projects.");
    const tpl = (await one("select * from projects where id = $1 and is_template and deleted_at is null", [b.templateId])) ??
      fail("That template no longer exists.");
    const name = need(b.name, "Give the project a name.");
    const number = need(b.number, "Give the project an ID.", 50);
    const pmId = need(b.pmId, "Choose a project manager.");
    const start = date(b.startDate, "Choose a start date.");
    if (await one("select 1 from projects where number = $1", [number])) fail("A project with this Project ID already exists.");
    const tasks = await q("select * from tasks where project_id = $1 and deleted_at is null order by start_date", [tpl.id]);
    const activeIds = new Set((await q("select id from users where active")).map((u) => u.id));
    const shift = dayDiff(tpl.start_date, start);
    const id = newId();
    await q(
      `insert into projects (id, number, name, description, customer, pm_id, start_date, target_date, priority, status, stage, remarks)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PLANNED',$10,$11)`,
      [id, number, name, tpl.description, str(b.customer, 200), pmId, start,
        addDays(start, Math.max(1, dayDiff(tpl.start_date, tpl.target_date))), tpl.priority, firstStage(S), tpl.remarks],
    );
    await copyTasks(tasks, id, (t) => {
      const s = addDays(t.start_date, shift);
      return { owner: activeIds.has(t.owner_id) ? t.owner_id : pmId, start: s, target: addDays(s, Math.max(1, dayDiff(t.start_date, t.target_date))) };
    });
    await log(me, { projectId: id, entity: "Project", entityId: id, action: "CREATED", field: "fromTemplate", newValue: tpl.name });
    return { ok: true, id };
  },

  async deleteTemplate(b, { me }) {
    deny(canCreate(me, "PROJECT"), "You don't have permission to delete templates.");
    await q("update projects set deleted_at = now() where id = $1 and is_template", [b.templateId]);
    await log(me, { projectId: b.templateId, entity: "Project", entityId: b.templateId, action: "DELETED" });
    return { ok: true };
  },

  // ----- tasks -----
  async createTask(b, { me }) {
    const p = await getProject(b.projectId);
    deny(await canProject(me, "EDIT", p), "You don't have permission to add tasks to this project.");
    const v = taskFields(b);
    const id = newId();
    await q(
      `insert into tasks (id, project_id, name, description, owner_id, department, start_date, target_date, status, priority,
         completion, weight, is_milestone, est_minutes, remarks, actual_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, p.id, v.name, v.description, v.owner, v.department, v.start, v.target, v.status, v.priority, v.completion,
        v.weight, v.milestone, v.est, v.remarks, v.status === "COMPLETED" ? today() : null],
    );
    await log(me, { projectId: p.id, taskId: id, entity: "Task", entityId: id, action: "CREATED" });
    await notify(v.owner, "TASK_ASSIGNED", `You were assigned "${v.name}" on ${p.name}.`, taskLink(p.id, id), me.id);
    return { ok: true, id };
  },

  async updateTask(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(canTask(me, "EDIT", t, p), "You don't have permission to edit this task.");
    const v = taskFields(b);
    const hasSubs = !!(await one("select 1 from subtasks where task_id = $1 and deleted_at is null limit 1", [t.id]));
    const completion = hasSubs ? t.completion : v.completion;
    const r = await q(
      `update tasks set name=$2, description=$3, owner_id=$4, department=$5, start_date=$6, target_date=$7, status=$8,
         priority=$9, completion=$10, weight=$11, is_milestone=$12, est_minutes=$13, remarks=$14, actual_date=$15,
         version = version + 1, updated_at = now()
       where id = $1 and version = $16 returning id`,
      [t.id, v.name, v.description, v.owner, v.department, v.start, v.target, v.status, v.priority, completion, v.weight,
        v.milestone, v.est, v.remarks, v.status === "COMPLETED" ? t.actual_date || today() : null, Number(b.version)],
    );
    if (!r.length) fail(STALE);
    const base = { projectId: p.id, taskId: t.id, entity: "Task", entityId: t.id };
    if (t.status !== v.status) await log(me, { ...base, action: "STATUS_CHANGED", field: "status", oldValue: t.status, newValue: v.status });
    if (t.target_date !== v.target)
      await log(me, { ...base, action: "DATE_CHANGED", field: "targetDate", oldValue: t.target_date, newValue: v.target, reason: str(b.delayReason, 1000) });
    if (!hasSubs && t.completion !== v.completion)
      await log(me, { ...base, action: "COMPLETION_CHANGED", field: "completionPercent", oldValue: String(t.completion), newValue: String(v.completion) });
    if (t.owner_id !== v.owner) {
      await log(me, { ...base, action: "REASSIGNED", field: "ownerId", oldValue: t.owner_id, newValue: v.owner });
      await notify(v.owner, "TASK_ASSIGNED", `"${v.name}" was assigned to you.`, taskLink(p.id, t.id), me.id);
    }
    return { ok: true };
  },

  async deleteTask(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(canTask(me, "DELETE", t, p), "You don't have permission to delete this task.");
    await q("update tasks set deleted_at = now() where id = $1", [t.id]);
    await log(me, { projectId: p.id, entity: "Task", entityId: t.id, action: "DELETED" });
    return { ok: true };
  },

  async moveTask(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(canTask(me, "EDIT", t, p), "You don't have permission to move this task.");
    const status = oneOf(b.status, ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED"], "Unknown column.");
    if (status === t.status) return { ok: true };
    const hasSubs = !!(await one("select 1 from subtasks where task_id = $1 and deleted_at is null limit 1", [t.id]));
    await q("update tasks set status=$2, completion=$3, actual_date=$4, version = version + 1, updated_at = now() where id = $1", [
      t.id, status, status === "COMPLETED" && !hasSubs ? 100 : t.completion, status === "COMPLETED" ? t.actual_date || today() : null,
    ]);
    await log(me, { projectId: p.id, taskId: t.id, entity: "Task", entityId: t.id, action: "STATUS_CHANGED", field: "status", oldValue: t.status, newValue: status });
    return { ok: true };
  },

  async bulkUpdate(b, { me }) {
    const p = await getProject(b.projectId);
    const ids = (b.taskIds || []).filter(Boolean);
    if (!ids.length) fail("Tick the tasks you want to change first.");
    if (ids.length > 200) fail("That's more than 200 tasks at once. Narrow the filter first.");
    const status = STATUSES.includes(b.status) ? b.status : null;
    const priority = PRIORITIES.includes(b.priority) ? b.priority : null;
    const owner = str(b.ownerId);
    const dept = str(b.department);
    const shift = num(b.shiftDays, -365, 365, "Shift dates by a whole number of days between -365 and 365.", 0);
    if (!Number.isInteger(shift)) fail("Shift dates by a whole number of days between -365 and 365.");
    if (!status && !priority && !owner && !dept && !shift) fail("Choose at least one thing to change.");
    const tasks = await q("select * from tasks where id = any($1) and project_id = $2 and deleted_at is null", [ids, p.id]);
    let changed = 0, refused = 0;
    for (const t of tasks) {
      if (!canTask(me, "EDIT", t, p)) { refused++; continue; }
      const n = {
        status: status ?? t.status,
        actual: status ? (status === "COMPLETED" ? t.actual_date || today() : null) : t.actual_date,
        priority: priority ?? t.priority,
        owner: owner ?? t.owner_id,
        dept: dept ? (dept === "none" ? null : dept) : t.department,
        start: addDays(t.start_date, shift),
        target: addDays(t.target_date, shift),
      };
      await q(
        `update tasks set status=$2, actual_date=$3, priority=$4, owner_id=$5, department=$6, start_date=$7, target_date=$8,
           version = version + 1, updated_at = now() where id = $1`,
        [t.id, n.status, n.actual, n.priority, n.owner, n.dept, n.start, n.target],
      );
      changed++;
      const base = { projectId: p.id, taskId: t.id, entity: "Task", entityId: t.id };
      if (status && t.status !== status) await log(me, { ...base, action: "STATUS_CHANGED", field: "status", oldValue: t.status, newValue: status });
      if (shift) await log(me, { ...base, action: "DATE_CHANGED", field: "targetDate", oldValue: t.target_date, newValue: n.target, reason: str(b.shiftReason, 1000) || "Bulk date shift" });
      if (owner && t.owner_id !== owner) {
        await log(me, { ...base, action: "REASSIGNED", field: "ownerId", oldValue: t.owner_id, newValue: owner });
        await notify(owner, "TASK_ASSIGNED", `"${t.name}" was assigned to you.`, taskLink(p.id, t.id), me.id);
      }
    }
    const notes = [];
    if (refused) notes.push(`${refused} left alone — you don't have permission to edit ${refused === 1 ? "it" : "them"}`);
    if (ids.length - tasks.length) notes.push(`${ids.length - tasks.length} no longer exist`);
    return { message: `${changed} task${changed === 1 ? "" : "s"} updated${notes.length ? ` (${notes.join("; ")})` : ""}.` };
  },

  // ----- subtasks -----
  async createSubtask(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(canTask(me, "EDIT", t, p), "You don't have permission to add subtasks here.");
    const start = date(b.startDate, "Start date is required");
    const target = date(b.targetDate, "Target date is required");
    if (target < start) fail("Target date must be on or after the start date");
    const status = oneOf(b.status, STATUSES, "Choose a valid status.");
    const id = newId();
    await q(
      `insert into subtasks (id, task_id, name, owner_id, start_date, target_date, status, completion, weight, remarks, actual_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, t.id, need(b.name, "Subtask name is required"), need(b.ownerId, "Owner is required"), start, target, status,
        num(b.completion, 0, 100, "Completion must be between 0 and 100.", 0), num(b.weight, 0.01, 9999, "Weight must be 0.01 to 9999.", 1),
        str(b.remarks), status === "COMPLETED" ? today() : null],
    );
    await log(me, { projectId: p.id, taskId: t.id, entity: "Subtask", entityId: id, action: "CREATED" });
    return { ok: true };
  },

  async updateSubtask(b, { me }) {
    const s = (await one("select * from subtasks where id = $1 and deleted_at is null", [b.subtaskId])) ?? fail("Subtask not found.");
    const { t, p } = await getTask(s.task_id);
    const canEdit = canTask(me, "EDIT", t, p);
    deny(canEdit || s.owner_id === me.id, "You don't have permission to update this subtask.");
    const status = oneOf(b.status, STATUSES, "Choose a valid status.");
    const completion = num(b.completion, 0, 100, "Completion must be between 0 and 100.");
    let start = s.start_date, target = s.target_date;
    if (canEdit && b.startDate && b.targetDate) {
      start = date(b.startDate, "Enter valid start and target dates.");
      target = date(b.targetDate, "Enter valid start and target dates.");
      if (target < start) fail("Target date must be on or after the start date");
    }
    const r = await q(
      `update subtasks set status=$2, completion=$3, actual_date=$4, start_date=$5, target_date=$6, version = version + 1
       where id = $1 and version = $7 returning id`,
      [s.id, status, completion, status === "COMPLETED" ? s.actual_date || today() : null, start, target, Number(b.version)],
    );
    if (!r.length) fail(STALE);
    const base = { projectId: p.id, taskId: t.id, entity: "Subtask", entityId: s.id };
    if (start !== s.start_date) await log(me, { ...base, action: "DATE_CHANGED", field: "startDate", oldValue: s.start_date, newValue: start });
    if (target !== s.target_date) await log(me, { ...base, action: "DATE_CHANGED", field: "targetDate", oldValue: s.target_date, newValue: target });
    if (status !== s.status) await log(me, { ...base, action: "STATUS_CHANGED", field: "status", oldValue: s.status, newValue: status });
    return { ok: true };
  },

  async deleteSubtask(b, { me }) {
    const s = (await one("select * from subtasks where id = $1 and deleted_at is null", [b.subtaskId])) ?? fail("Subtask not found.");
    const { t, p } = await getTask(s.task_id);
    deny(canTask(me, "DELETE", t, p), "You don't have permission to delete this subtask.");
    await q("update subtasks set deleted_at = now() where id = $1", [s.id]);
    await log(me, { projectId: p.id, taskId: t.id, entity: "Subtask", entityId: s.id, action: "DELETED" });
    return { ok: true };
  },

  // ----- dependencies (stored on the waiting task) -----
  async addDep(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(await canProject(me, "EDIT", p), "You don't have permission to change this project's plan.");
    const predId = need(b.predecessorId, "Choose the task this one waits on.");
    if (predId === t.id) fail("A task can't wait on itself.");
    const lag = num(b.lagDays, -365, 365, "Lag must be a number of days between -365 and 365.", 0);
    const type = oneOf(b.type, DEP_TYPES, "Choose a link type.");
    const all = await q("select id, name, deps from tasks where project_id = $1 and deleted_at is null", [p.id]);
    const pred = all.find((x) => x.id === predId) ?? fail("That task isn't in this project.");
    if (t.deps.some((d) => d.pred === predId)) fail("Those tasks are already linked.");
    const edges = all.flatMap((x) => x.deps.map((d) => [d.pred, x.id]));
    if (reaches(edges, t.id, predId))
      fail(`Linking these would make the plan circular — "${pred.name}" already depends on this task, directly or through others.`);
    const deps = [...t.deps, { id: newId(), pred: predId, type, lag: Math.round(lag) }];
    await q("update tasks set deps = $2::jsonb, updated_at = now() where id = $1", [t.id, JSON.stringify(deps)]);
    await log(me, { projectId: p.id, taskId: t.id, entity: "Task", entityId: t.id, action: "UPDATED", field: "dependency", newValue: `waits on ${pred.name}` });
    return { message: `Now waits on "${pred.name}".` };
  },

  async removeDep(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(await canProject(me, "EDIT", p), "You don't have permission to change this project's plan.");
    const deps = t.deps.filter((d) => d.id !== b.depId);
    await q("update tasks set deps = $2::jsonb, updated_at = now() where id = $1", [t.id, JSON.stringify(deps)]);
    return { ok: true };
  },

  // ----- time -----
  async timeEntries(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(canTask(me, "VIEW", t, p) || (await canProject(me, "VIEW", p)), "Task not found.");
    return {
      entries: await q(
        `select e.*, u.name as user_name from time_entries e join users u on u.id = e.user_id
         where e.task_id = $1 order by e.spent_on desc, e.created_at desc limit 200`,
        [t.id],
      ),
    };
  },

  async logTime(b, { me }) {
    const { t, p } = await getTask(b.taskId);
    deny(canTask(me, "EDIT", t, p) || t.owner_id === me.id, "You don't have permission to log time against this task.");
    const minutes = parseDuration(String(b.duration ?? ""));
    if (!minutes || minutes <= 0) fail('Enter the time as hours ("1.5"), hours and minutes ("1:30") or minutes ("90m").');
    if (minutes > 1440) fail("A single entry can't be longer than 24 hours. Split it across the days it was worked.");
    const spentOn = b.spentOn ? date(b.spentOn, "That date isn't valid.") : today();
    if (spentOn > today()) fail("That date is in the future — check the day you meant.");
    await q("insert into time_entries (id, task_id, user_id, minutes, spent_on, note) values ($1,$2,$3,$4,$5,$6)", [
      newId(), t.id, me.id, minutes, spentOn, str(b.note, 500),
    ]);
    return { message: "Logged." };
  },

  async deleteTime(b, { me }) {
    await q("delete from time_entries where id = $1 and user_id = $2", [b.entryId, me.id]);
    return { ok: true };
  },

  // ----- documents (files live in Netlify Blobs) -----
  async docs(b, { me }) {
    const p = await getProject(b.projectId);
    deny(await canProject(me, "VIEW", p), "Project not found.");
    return {
      docs: await q(
        `select d.*, u.name as uploader, t.name as task_name from documents d
         join users u on u.id = d.uploaded_by left join tasks t on t.id = d.task_id
         where d.project_id = $1 order by d.created_at desc`,
        [p.id],
      ),
    };
  },

  async deleteDoc(b, { me }) {
    const d = (await one("select * from documents where id = $1", [b.docId])) ?? fail("Document not found.");
    const p = await getProject(d.project_id);
    deny(await canProject(me, "DELETE", p), "You don't have permission to remove documents here.");
    await q("delete from documents where id = $1", [d.id]);
    await getStore("documents").delete(d.id);
    await log(me, { projectId: p.id, entity: "Document", entityId: d.id, action: "DELETED", oldValue: d.file_name });
    return { ok: true };
  },

  // ----- activity / exports that need history -----
  async activity(b, { me }) {
    const p = await getProject(b.projectId);
    deny(await canProject(me, "VIEW", p), "Project not found.");
    return {
      entries: await q(
        `select a.*, u.name as user_name from activity a left join users u on u.id = a.user_id
         where a.project_id = $1 order by a.created_at desc limit 200`,
        [p.id],
      ),
    };
  },

  async delayLog(b, { me }) {
    const ids = await viewableProjectIds(me, b.projectIds);
    return {
      rows: await q(
        `select a.*, u.name as user_name, p.name as project_name, p.number as project_number, t.name as task_name
         from activity a join users u on u.id = a.user_id join projects p on p.id = a.project_id left join tasks t on t.id = a.task_id
         where a.action = 'DATE_CHANGED' and a.project_id = any($1) order by a.created_at desc limit 5000`,
        [ids],
      ),
    };
  },

  async timeLog(b, { me }) {
    const ids = await viewableProjectIds(me, b.projectIds);
    return {
      rows: await q(
        `select e.*, u.name as user_name, u.login_id, t.name as task_name, t.department, p.name as project_name, p.number as project_number
         from time_entries e join users u on u.id = e.user_id join tasks t on t.id = e.task_id join projects p on p.id = t.project_id
         where t.deleted_at is null and p.id = any($1) order by e.spent_on desc, e.created_at desc limit 10000`,
        [ids],
      ),
    };
  },

  // ----- chat -----
  async messages(b, { me }) {
    await chatAccess(me, b.scope);
    return { messages: await listMessages(b.scope) };
  },

  async postMessage(b, { me }) {
    const body = str(b.body, 5000) ?? fail("Type a message first.");
    if (body.length > 2000) fail("Messages can be at most 2000 characters.");
    const link = await chatAccess(me, b.scope);
    const s = b.scope || {};
    await q("insert into messages (id, project_id, task_id, author_id, body) values ($1,$2,$3,$4,$5)", [
      newId(), s.projectId ?? null, s.taskId ?? null, me.id, body,
    ]);
    const handles = [...new Set([...body.matchAll(/(?<![\w.%+-])@([a-zA-Z0-9]{1,12})(?![a-zA-Z0-9])/g)].map((m) => m[1].toLowerCase()))];
    if (handles.length) {
      const S = await loadSettings();
      const people = await q("select * from users where lower(login_id) = any($1) and active", [handles]);
      const preview = body.replace(/\s+/g, " ").slice(0, 90);
      for (const u of people) {
        const them = { id: u.id, department: u.department, grants: (S.roles || {})[u.role] || [] };
        const ok = await chatAccess(them, b.scope).then(() => true, () => false);
        if (ok) await notify(u.id, "MENTIONED", `${me.name} mentioned you: "${preview}"`, link, me.id);
      }
    }
    return { messages: await listMessages(b.scope) };
  },

  async deleteMessage(b, { me }) {
    const m = (await one("select * from messages where id = $1", [b.messageId])) ?? fail("Message not found.");
    deny(m.author_id === me.id || canAdmin(me, "DELETE"), "That message can only be removed by whoever wrote it.");
    await q("delete from messages where id = $1", [m.id]);
    return { messages: await listMessages(b.scope) };
  },

  // ----- notifications -----
  async notifications(_b, { me }) {
    return { items: await q("select * from notifications where user_id = $1 order by created_at desc limit 100", [me.id]) };
  },
  async markRead(b, { me }) {
    await q("update notifications set is_read = true where id = $1 and user_id = $2", [b.id, me.id]);
    return { ok: true };
  },
  async markAllRead(_b, { me }) {
    await q("update notifications set is_read = true where user_id = $1", [me.id]);
    return { ok: true };
  },
  async clearRead(_b, { me }) {
    await q("delete from notifications where user_id = $1 and is_read", [me.id]);
    return { ok: true };
  },

  // ----- saved views (kept in settings) -----
  async saveView(b, { me, S }) {
    const name = need(b.name, "Give the view a name.", 100);
    if (name.length > 40) fail("Keep the name under 40 characters.");
    const views = S.views || [];
    const mine = views.filter((v) => v.ownerId === me.id);
    const existing = mine.find((v) => v.scope === b.scope && v.name === name);
    if (!existing && mine.length >= 30) fail("You already have 30 saved views. Delete one first.");
    const view = { id: existing?.id || newId(), name, scope: String(b.scope), query: String(b.query || "").slice(0, 1000), ownerId: me.id, ownerName: me.name, shared: !!b.shared };
    await setSetting("views", [...views.filter((v) => v.id !== view.id), view]);
    return { message: "View saved." };
  },
  async deleteView(b, { me, S }) {
    await setSetting("views", (S.views || []).filter((v) => !(v.id === b.viewId && v.ownerId === me.id)));
    return { ok: true };
  },

  // ----- recycle bin -----
  async recycleList() {
    const cutoff = `now() - interval '${RECYCLE_DAYS} days'`;
    await q(`delete from subtasks where deleted_at < ${cutoff}`);
    await q(`delete from tasks where deleted_at < ${cutoff}`);
    await q(`delete from projects where deleted_at < ${cutoff}`);
    const [projects, tasks, subtasks] = await Promise.all([
      q("select id, name, number, deleted_at from projects where deleted_at is not null order by deleted_at desc limit 100"),
      q(`select t.id, t.name, t.deleted_at, p.name as parent from tasks t join projects p on p.id = t.project_id
         where t.deleted_at is not null order by t.deleted_at desc limit 100`),
      q(`select s.id, s.name, s.deleted_at, t.name as parent from subtasks s join tasks t on t.id = s.task_id
         where s.deleted_at is not null order by s.deleted_at desc limit 100`),
    ]);
    return { projects, tasks, subtasks };
  },

  async restore(b, { me }) {
    if (b.kind === "project") {
      const p = (await one("select * from projects where id = $1", [b.id])) ?? fail("That project isn't in the recycle bin.");
      deny(await canProject(me, "DELETE", p), "You don't have permission to restore this project.");
      await q("update projects set deleted_at = null where id = $1", [p.id]);
      await log(me, { projectId: p.id, entity: "Project", entityId: p.id, action: "UPDATED", field: "deletedAt", reason: "Restored from recycle bin" });
      return { message: `Restored "${p.name}".` };
    }
    if (b.kind === "task") {
      const t = (await one("select * from tasks where id = $1", [b.id])) ?? fail("That task isn't in the recycle bin.");
      const p = (await one("select * from projects where id = $1", [t.project_id])) ?? fail("That task's project no longer exists.");
      deny(canTask(me, "DELETE", t, p), "You don't have permission to restore this task.");
      await q("update tasks set deleted_at = null where id = $1", [t.id]);
      await log(me, { projectId: p.id, taskId: t.id, entity: "Task", entityId: t.id, action: "UPDATED", field: "deletedAt", reason: "Restored from recycle bin" });
      return { message: `Restored "${t.name}".` };
    }
    const s = (await one("select * from subtasks where id = $1", [b.id])) ?? fail("That subtask isn't in the recycle bin.");
    const t = (await one("select * from tasks where id = $1", [s.task_id])) ?? fail("That subtask's task no longer exists.");
    const p = (await one("select * from projects where id = $1", [t.project_id])) ?? fail("That subtask's task no longer exists.");
    deny(canTask(me, "DELETE", t, p), "You don't have permission to restore this subtask.");
    await q("update subtasks set deleted_at = null where id = $1", [s.id]);
    return { message: `Restored "${s.name}".` };
  },

  // ----- administration -----
  async createUser(b, { me, S }) {
    deny(canAdmin(me, "MANAGE_USERS"), "You don't have permission to manage users.");
    const loginId = need(b.loginId, "User ID is required", 12);
    if (!/^[a-zA-Z0-9]{1,12}$/.test(loginId)) fail("User ID can only contain letters and numbers — no spaces or symbols");
    checkNewPassword(b.password);
    const email = str(b.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email address");
    const role = need(b.role, "Role is required");
    if (!(S.roles || {})[role]) fail("Choose a role.");
    if (await one("select 1 from users where lower(login_id) = lower($1)", [loginId])) fail("That User ID is already taken. Choose another.");
    if (email && (await one("select 1 from users where lower(email) = lower($1)", [email]))) fail("That email address is already in use.");
    const id = newId();
    await q(
      "insert into users (id, login_id, name, email, password_hash, role, department, designation) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, loginId, need(b.name, "Name is required"), email, hashPw(b.password), role, str(b.department), str(b.designation)],
    );
    await log(me, { entity: "User", entityId: id, action: "CREATED" });
    return { ok: true, loginId };
  },

  async setUserActive(b, { me, S }) {
    deny(canAdmin(me, "MANAGE_USERS"), "You don't have permission to manage users.");
    if (b.userId === me.id || b.userId === S.masterUserId) fail("That account can't be deactivated.");
    await q("update users set active = $2 where id = $1", [b.userId, !!b.active]);
    await log(me, { entity: "User", entityId: b.userId, action: "STATUS_CHANGED", field: "isActive", newValue: String(!!b.active) });
    return { ok: true };
  },

  async setUserPassword(b, { me }) {
    deny(canAdmin(me, "MANAGE_USERS"), "Not permitted.");
    checkNewPassword(b.password);
    await q("update users set password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = null where id = $1", [
      b.userId, hashPw(b.password),
    ]);
    await log(me, { entity: "User", entityId: b.userId, action: "UPDATED", field: "passwordHash", reason: "Set by an administrator" });
    return { message: "Password updated." };
  },

  async addListItem(b, { me, S }) {
    deny(canAdmin(me, "MANAGE_USERS"), "Not permitted.");
    const list = oneOf(b.list, ["departments", "designations"], "Unknown list.");
    const name = need(b.name, "Enter a name.");
    if ((S[list] || []).some((x) => x.name.toLowerCase() === name.toLowerCase())) fail("That name already exists.");
    await setSetting(list, [...(S[list] || []), { name, active: true }]);
    return { ok: true };
  },
  async toggleListItem(b, { me, S }) {
    deny(canAdmin(me, "MANAGE_USERS"), "Not permitted.");
    const list = oneOf(b.list, ["departments", "designations"], "Unknown list.");
    await setSetting(list, (S[list] || []).map((x) => (x.name === b.name ? { ...x, active: !x.active } : x)));
    return { ok: true };
  },

  async addStage(b, { me, S }) {
    deny(canAdmin(me, "MANAGE_USERS"), "Not permitted.");
    const stages = S.stages || [];
    const name = need(b.name, "Enter a stage name.");
    if (stages.some((s) => s.name === name)) fail("That stage already exists.");
    await setSetting("stages", [...stages, { name, seq: Math.max(0, ...stages.map((s) => s.seq)) + 1, active: true }]);
    return { ok: true };
  },
  async updateStage(b, { me, S }) {
    deny(canAdmin(me, "MANAGE_USERS"), "Not permitted.");
    await setSetting(
      "stages",
      (S.stages || []).map((s) =>
        s.name !== b.name ? s : { ...s, seq: b.seq !== undefined ? Number(b.seq) || s.seq : s.seq, active: b.toggle ? !s.active : s.active },
      ),
    );
    return { ok: true };
  },

  async saveRules(b, { me }) {
    deny(canAdmin(me, "EDIT"), "Not permitted.");
    await setSetting("rules", {
      atRiskThresholdDays: num(b.atRiskThresholdDays, 0, 365, "At-risk threshold must be 0–365 days."),
      overdueGraceDays: num(b.overdueGraceDays, 0, 365, "Grace period must be 0–365 days."),
      defaultTaskWeight: num(b.defaultTaskWeight, 0.01, 9999, "Default weight must be 0.01–9999."),
    });
    return { message: "Business rules saved." };
  },

  async createRole(b, { me, S }) {
    deny(canAdmin(me, "EDIT"), "Not permitted.");
    const name = need(b.name, "Enter a role name.");
    if ((S.roles || {})[name]) fail("That role already exists.");
    await setSetting("roles", { ...(S.roles || {}), [name]: [] });
    return { ok: true };
  },
  async toggleGrant(b, { me, S }) {
    deny(canAdmin(me, "EDIT"), "Not permitted.");
    const roles = { ...(S.roles || {}) };
    const key = `${b.resource}:${b.act}:ALL`;
    const list = new Set(roles[b.role] ?? fail("Unknown role."));
    b.grant ? list.add(key) : list.delete(key);
    roles[b.role] = [...list];
    await setSetting("roles", roles);
    return { ok: true };
  },
};

// ---------- helpers used by the actions above ----------
const firstStage = (S) =>
  (S.stages || []).filter((s) => s.active).sort((a, b) => a.seq - b.seq)[0]?.name ?? null;

function taskFields(b) {
  const start = date(b.startDate, "Start date is required");
  const target = date(b.targetDate, "Target date is required");
  if (target < start) fail("Target date must be on or after the start date");
  const est = b.estimatedHours === "" || b.estimatedHours == null ? null : Math.round(num(b.estimatedHours, 0, 10000, "Planned effort must be 0–10000 hours.") * 60);
  return {
    name: need(b.name, "Task name is required"),
    description: str(b.description),
    owner: need(b.ownerId, "Task owner is required"),
    department: str(b.department),
    start, target,
    status: oneOf(b.status, STATUSES, "Choose a status"),
    priority: oneOf(b.priority, PRIORITIES, "Choose a priority"),
    completion: num(b.completion, 0, 100, "Completion must be between 0 and 100.", 0),
    weight: num(b.weight, 0.01, 9999, "Weight must be between 0.01 and 9999.", 1),
    milestone: b.isMilestone === true || b.isMilestone === "on",
    est,
    remarks: str(b.remarks),
  };
}

async function copyTasks(tasks, projectId, place) {
  const map = new Map(tasks.map((t) => [t.id, newId()]));
  for (const t of tasks) {
    const { owner, start, target } = place(t);
    const deps = t.deps.filter((d) => map.has(d.pred)).map((d) => ({ ...d, id: newId(), pred: map.get(d.pred) }));
    await q(
      `insert into tasks (id, project_id, name, description, owner_id, department, start_date, target_date, priority, weight,
         is_milestone, est_minutes, remarks, deps)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [map.get(t.id), projectId, t.name, t.description, owner, t.department, start, target, t.priority, t.weight,
        t.is_milestone, t.est_minutes, t.remarks, JSON.stringify(deps)],
    );
  }
}

// Would adding pred -> succ close a loop? True if succ can already reach pred.
function reaches(edges, from, to) {
  const next = new Map();
  for (const [a, b] of edges) next.set(a, [...(next.get(a) || []), b]);
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) || []));
  }
  return false;
}

function parseDuration(raw) {
  const text = raw.trim().toLowerCase();
  let m;
  if ((m = /^(\d{1,3}):([0-5]?\d)$/.exec(text))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d{1,5}(?:\.\d+)?)\s*(?:m|min|mins|minutes)$/.exec(text))) return Math.round(Number(m[1]));
  if ((m = /^(\d{1,4}(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)?$/.exec(text))) return Math.round(Number(m[1]) * 60);
  return null;
}

async function viewableProjectIds(me, only) {
  const projects = await q("select id, pm_id from projects where deleted_at is null and not is_template");
  const out = [];
  for (const p of projects) {
    if (only?.length && !only.includes(p.id)) continue;
    if (await canProject(me, "VIEW", p)) out.push(p.id);
  }
  return out;
}

// Returns the notification link for the scope, or throws if this person can't see it.
async function chatAccess(me, scope = {}) {
  if (scope.taskId) {
    const { t, p } = await getTask(scope.taskId);
    deny(canTask(me, "VIEW", t, p) || (await canProject(me, "VIEW", p)), "You don't have access to this conversation.");
    return taskLink(p.id, t.id);
  }
  if (scope.projectId) {
    const p = await getProject(scope.projectId);
    deny(await canProject(me, "VIEW", p), "You don't have access to this conversation.");
    return `#/projects/${p.id}/discussion`;
  }
  return "#/chat";
}
const listMessages = (scope = {}) =>
  q(
    `select m.id, m.body, m.created_at, m.author_id, u.name as author_name from messages m join users u on u.id = m.author_id
     where ${scope.taskId ? "m.task_id = $1" : scope.projectId ? "m.project_id = $1 and m.task_id is null" : "m.project_id is null and m.task_id is null and $1::text is null"}
     order by m.created_at asc limit 200`,
    [scope.taskId || scope.projectId || null],
  );

// ---------- file upload / download ----------
async function upload(req, url, me) {
  if (!me) return json({ error: "Sign in first." }, 401);
  const p = await getProject(url.searchParams.get("project"));
  deny(await canProject(me, "CREATE", p), "You don't have permission to add documents to this project.");
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) fail("That file is empty.");
  if (bytes.byteLength > MAX_FILE) fail(`That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB. The limit is 4 MB — put larger files on the shared drive and link them in the description.`);
  const name = decodeURIComponent(req.headers.get("x-file-name") || "file").slice(0, 200);
  const mime = req.headers.get("content-type") || "application/octet-stream";
  const id = newId();
  await getStore("documents").set(id, bytes);
  await q("insert into documents (id, project_id, file_name, mime, size_bytes, category, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)", [
    id, p.id, name, mime, bytes.byteLength, str(url.searchParams.get("category"), 50), me.id,
  ]);
  await log(me, { projectId: p.id, entity: "Document", entityId: id, action: "FILE_UPLOADED", newValue: name });
  return json({ message: `Uploaded "${name}".` });
}

async function download(url, me) {
  if (!me) return new Response("Sign in first.", { status: 401 });
  const d = await one("select * from documents where id = $1", [url.pathname.split("/").pop()]);
  if (!d) return new Response("Not found.", { status: 404 });
  const p = await getProject(d.project_id);
  if (!(await canProject(me, "VIEW", p))) return new Response("Not found.", { status: 404 });
  const data = await getStore("documents").get(d.id, { type: "arrayBuffer" });
  if (!data) return new Response("The file is missing from storage.", { status: 404 });
  return new Response(data, {
    headers: {
      "content-type": d.mime,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(d.file_name)}`,
    },
  });
}

// ---------- entry point ----------
export default async (req) => {
  const url = new URL(req.url);
  try {
    const S = await loadSettings();
    const secret = await secretOf(S);
    const me = await currentUser(req, S, secret);
    if (url.pathname === "/api/upload" && req.method === "POST") return await upload(req, url, me);
    if (url.pathname.startsWith("/api/doc/")) return await download(url, me);
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);

    const body = await req.json().catch(() => ({}));
    const ctx = { S, secret, me };
    let result;
    if (PUBLIC[body.action]) result = await PUBLIC[body.action](body, ctx);
    else if (!me) return json({ error: "Your session has ended. Sign in again.", signedOut: true }, 401);
    else if (me.mustChangePassword && body.action !== "changePassword") return json({ error: "Change your password first.", mustChange: true }, 403);
    else if (ACTIONS[body.action]) result = await ACTIONS[body.action](body, ctx);
    else return json({ error: "Unknown action." }, 400);

    const { __cookie, ...data } = result ?? { ok: true };
    return json(data, 200, __cookie ? { "set-cookie": __cookie } : {});
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong on the server. Try again in a moment." }, 500);
  }
};

export const config = { path: ["/api", "/api/*"] };
