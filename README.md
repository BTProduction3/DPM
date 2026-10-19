# Design & Development Project Management (simplified)

## Files
- `public/index.html`, `public/app.js`, `public/styles.css` — the whole app screen
- `netlify/functions/api.mjs` — the whole backend (login + every action, plain SQL)
- `netlify/database/migrations/20261019000000_initial.sql` — the whole database (10 tables + default settings)

## Deploy
1. Push this folder to a Git repo and link it in Netlify (or run `netlify deploy --prod` from this folder).
2. Netlify sees `@netlify/database`, creates the Postgres database and applies the migration automatically.
3. Open the site. The first visit asks you to create the master account.

Needs a Netlify credit-based plan (Netlify Database isn't on legacy plans).
No environment variables are required. Optional: `APP_TIMEZONE` (defaults to Asia/Kolkata).

## Changing the database later
Never edit the existing migration file. Add a new file in the same folder with a later number,
e.g. `20261101000000_add_column.sql`. Netlify applies it on the next deploy.
