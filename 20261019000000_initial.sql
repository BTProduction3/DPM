-- DPM app: the whole database. Netlify applies this file automatically on deploy.
-- Dates are stored as text 'YYYY-MM-DD' so they never shift with time zones.

create table settings (
  key   text primary key,
  value jsonb not null
);

create table users (
  id                   text primary key,
  login_id             text not null unique,
  name                 text not null,
  email                text,
  password_hash        text not null,
  role                 text not null,
  department           text,
  designation          text,
  active               boolean not null default true,
  must_change_password boolean not null default false,
  failed_logins        int not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now()
);

create table projects (
  id          text primary key,
  number      text not null unique,
  name        text not null,
  description text,
  customer    text,
  pm_id       text not null references users(id),
  start_date  text not null,
  target_date text not null,
  actual_date text,
  priority    text not null default 'MEDIUM',
  status      text not null default 'PLANNED',
  stage       text,
  remarks     text,
  is_template boolean not null default false,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table tasks (
  id           text primary key,
  project_id   text not null references projects(id) on delete cascade,
  name         text not null,
  description  text,
  owner_id     text not null references users(id),
  department   text,
  start_date   text not null,
  target_date  text not null,
  actual_date  text,
  status       text not null default 'NOT_STARTED',
  priority     text not null default 'MEDIUM',
  completion   double precision not null default 0,
  weight       double precision not null default 1,
  is_milestone boolean not null default false,
  est_minutes  int,
  remarks      text,
  deps         jsonb not null default '[]',  -- tasks this one waits on: [{id, pred, type, lag}]
  version      int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index tasks_project on tasks(project_id);

create table subtasks (
  id          text primary key,
  task_id     text not null references tasks(id) on delete cascade,
  name        text not null,
  owner_id    text not null references users(id),
  start_date  text not null,
  target_date text not null,
  actual_date text,
  status      text not null default 'NOT_STARTED',
  completion  double precision not null default 0,
  weight      double precision not null default 1,
  remarks     text,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index subtasks_task on subtasks(task_id);

create table time_entries (
  id         text primary key,
  task_id    text not null references tasks(id) on delete cascade,
  user_id    text not null references users(id),
  minutes    int not null,
  spent_on   text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index time_task on time_entries(task_id);

create table documents (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  task_id     text,
  file_name   text not null,
  mime        text not null,
  size_bytes  int not null,
  category    text,
  uploaded_by text not null references users(id),
  created_at  timestamptz not null default now()
);

-- Chat: team room when project_id and task_id are both empty.
create table messages (
  id         text primary key,
  project_id text,
  task_id    text,
  author_id  text not null references users(id),
  body       text not null,
  created_at timestamptz not null default now()
);
create index messages_scope on messages(project_id, task_id);

create table notifications (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  type       text not null,
  message    text not null,
  link       text,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user on notifications(user_id, is_read);

create table activity (
  id         text primary key,
  project_id text,
  task_id    text,
  user_id    text not null,
  entity     text not null,
  entity_id  text not null,
  action     text not null,
  field      text,
  old_value  text,
  new_value  text,
  reason     text,
  created_at timestamptz not null default now()
);
create index activity_project on activity(project_id);

-- Default lists, rules and roles (all editable from Administration).
insert into settings (key, value) values
('departments', '[{"name":"Design","active":true},{"name":"Purchase","active":true},{"name":"PPC / PPIC","active":true},{"name":"Production","active":true},{"name":"Quality","active":true},{"name":"Product Management","active":true}]'),
('designations', '[{"name":"Project Manager","active":true},{"name":"Design Team","active":true},{"name":"Purchase Manager","active":true},{"name":"Assistant Manager – PPC","active":true},{"name":"Deputy Manager – PPIC","active":true},{"name":"Production Supervisor","active":true},{"name":"Product Management Team","active":true},{"name":"Director","active":true},{"name":"Administrator","active":true}]'),
('stages', '[{"name":"Project Initiation","seq":1,"active":true},{"name":"Requirement Collection","seq":2,"active":true},{"name":"Concept Development","seq":3,"active":true},{"name":"Design Development","seq":4,"active":true},{"name":"Design Review","seq":5,"active":true},{"name":"Prototype Development","seq":6,"active":true},{"name":"Prototype Testing","seq":7,"active":true},{"name":"Design Modification","seq":8,"active":true},{"name":"Final Design Approval","seq":9,"active":true},{"name":"Drawing / Documentation","seq":10,"active":true},{"name":"Procurement","seq":11,"active":true},{"name":"Manufacturing","seq":12,"active":true},{"name":"Inspection / Validation","seq":13,"active":true},{"name":"Final Approval","seq":14,"active":true},{"name":"Project Closure","seq":15,"active":true}]'),
('rules', '{"atRiskThresholdDays":3,"overdueGraceDays":0,"defaultTaskWeight":1}'),
('views', '[]'),
('roles', '{
  "Administrator": ["PROJECT:VIEW:ALL","PROJECT:CREATE:ALL","PROJECT:EDIT:ALL","PROJECT:DELETE:ALL","PROJECT:ASSIGN:ALL","PROJECT:SHARE:ALL","PROJECT:EXPORT:ALL","TASK:VIEW:ALL","TASK:CREATE:ALL","TASK:EDIT:ALL","TASK:DELETE:ALL","TASK:ASSIGN:ALL","TASK:APPROVE:ALL","DOCUMENT:VIEW:ALL","DOCUMENT:CREATE:ALL","DOCUMENT:EDIT:ALL","DOCUMENT:DELETE:ALL","DOCUMENT:SHARE:ALL","DOCUMENT:EXPORT:ALL","ADMIN:VIEW:ALL","ADMIN:CREATE:ALL","ADMIN:EDIT:ALL","ADMIN:DELETE:ALL","ADMIN:MANAGE_USERS:ALL"],
  "Director": ["PROJECT:VIEW:ALL","PROJECT:EXPORT:ALL","TASK:VIEW:ALL","TASK:APPROVE:ALL","DOCUMENT:VIEW:ALL","DOCUMENT:EXPORT:ALL"],
  "Project Manager": ["PROJECT:VIEW:ALL","PROJECT:CREATE:ALL","PROJECT:EDIT:OWN","PROJECT:SHARE:OWN","PROJECT:EXPORT:OWN","TASK:VIEW:OWN","TASK:CREATE:OWN","TASK:EDIT:OWN","TASK:DELETE:OWN","TASK:ASSIGN:OWN","TASK:APPROVE:OWN","DOCUMENT:VIEW:OWN","DOCUMENT:CREATE:OWN","DOCUMENT:SHARE:OWN","DOCUMENT:DELETE:OWN"],
  "Design Team": ["PROJECT:VIEW:DEPARTMENT","TASK:VIEW:DEPARTMENT","TASK:CREATE:OWN","TASK:EDIT:OWN","DOCUMENT:VIEW:DEPARTMENT","DOCUMENT:CREATE:OWN"],
  "Purchase Manager": ["PROJECT:VIEW:DEPARTMENT","TASK:VIEW:DEPARTMENT","TASK:CREATE:OWN","TASK:EDIT:OWN","DOCUMENT:VIEW:DEPARTMENT","DOCUMENT:CREATE:OWN"],
  "PPC / PPIC": ["PROJECT:VIEW:DEPARTMENT","TASK:VIEW:DEPARTMENT","TASK:CREATE:OWN","TASK:EDIT:OWN","DOCUMENT:VIEW:DEPARTMENT","DOCUMENT:CREATE:OWN"],
  "Production Supervisor": ["PROJECT:VIEW:DEPARTMENT","TASK:VIEW:DEPARTMENT","TASK:CREATE:OWN","TASK:EDIT:OWN","DOCUMENT:VIEW:DEPARTMENT","DOCUMENT:CREATE:OWN"],
  "Product Management Team": ["PROJECT:VIEW:ALL","PROJECT:EXPORT:ALL","TASK:VIEW:ALL","TASK:APPROVE:ALL","DOCUMENT:VIEW:ALL","DOCUMENT:EXPORT:ALL"]
}');
