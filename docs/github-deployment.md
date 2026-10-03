# Deploy from GitHub main

`main` contains the reviewed source, exported OpenAPI and documentation PDF. Validation automatically runs on pushes and pull requests. Production deployment is a separate manually dispatched workflow, preventing an unconfigured deployment on every edit.

Create a GitHub environment named `production`, restricted to `main`, and add encrypted `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD` secrets. Use a dedicated deployment credential with suitable scope/expiry. Configure the four application secrets through Supabase first; they never belong in GitHub source or frontend variables. See [Supabase CI environments](https://supabase.com/docs/guides/deployment/managing-environments).

In **Actions → Deploy production API → Run workflow**, select `main`. The job installs the lockfile, validates types/tests/OpenAPI/bundles/formatting, audits runtime dependencies, links the intended project, checks configuration and secret names, applies tracked migrations and deploys both functions using `--use-api`. Docker is unnecessary for deployment. The workflow pins action commits, uses read-only GitHub permissions, supplies deployment credentials only to deployment steps, and serializes production runs.

Non-secret production defaults and the public URL live in `docs/configuration.json`; ensure its project reference matches the GitHub secret. After deploying, verify `/health`, `/ready`, CORS from a local frontend, register/login/refresh/logout, owner-scoped CRUD and private upload/download. Run `npm run maintenance:setup` locally once after initial deployment to provision the encrypted Vault token and recurring Cron job. It preserves existing application secrets. Cron setup does not require exposing its token to GitHub.

Keep migrations compatible with the currently running application. If deployment fails after migrations apply, resolve the deployment issue and rerun the same commit. Do not automatically reset/roll back production data or run the local demo seed remotely. Free projects lack automatic backups; define an encrypted export/restore process before storing important data.
