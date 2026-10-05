# MangaHive — GitHub Pages + Supabase deployment

This repository is prepared to run MangaHive as a static PWA on GitHub Pages while using Supabase for authentication, community data, and the database.

## Architecture

- **Frontend:** GitHub Pages
- **Frontend build:** no npm build step; GitHub Actions assembles the static Pages artifact
- **Database:** Supabase
- **Database schema:** `supabase/migrations/` is the source of truth
- **Frontend key:** Supabase publishable/anon key only
- **Secret database access:** Supabase CLI access token is used only by the manual migration workflow

## 1. Create the GitHub repository

Create a new GitHub repository and use `main` as the default branch. Upload the **contents of this folder**, not the ZIP file itself.

Do not commit `.env` files, service-role keys, OAuth client secrets, Android signing keys, or other private credentials.

## 2. Add GitHub Actions secrets

Open:

**GitHub → Repository → Settings → Secrets and variables → Actions → New repository secret**

Add:

| Secret | Value |
|---|---|
| `MANGAHIVE_SUPABASE_URL` | Your Supabase project URL, e.g. `https://YOUR_PROJECT.supabase.co` |
| `MANGAHIVE_SUPABASE_ANON_KEY` | Your browser-safe Supabase publishable/anon key |
| `MANGAHIVE_GOOGLE_CLIENT_ID` | Your Google OAuth Web client ID |

The Supabase **service-role/secret key must never be used for the Pages deployment**.

The publishable/anon key is intentionally delivered to the browser. RLS and the server-side authorization model protect database operations.

## 3. Enable GitHub Pages

Open:

**Settings → Pages → Build and deployment → Source → GitHub Actions**

No branch/folder deployment configuration is required. The workflow publishes the Pages artifact directly.

## 4. Deploy MangaHive

Push to `main`.

The workflow `.github/workflows/deploy-pages.yml` automatically:

1. checks the repository inputs;
2. runs all Phase 0 and Phase 1 regression tests;
3. validates JavaScript syntax;
4. creates `config/runtime-config.production.js` from GitHub Secrets;
5. verifies that the generated configuration contains no placeholders;
6. assembles the GitHub Pages artifact;
7. deploys it.

Your Pages URL will normally be:

`https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME/`

Use the exact URL shown by GitHub after deployment.

## 5. Configure Supabase

The repository already contains the ordered SQL migration chain under:

`supabase/migrations/`

For a **test/staging Supabase project**, add these additional repository secrets:

- `MANGAHIVE_SUPABASE_PROJECT_ID` — the Supabase project reference ID
- `SUPABASE_ACCESS_TOKEN` — a Supabase CLI access token

Then run:

**Actions → MangaHive — Supabase Migration Deploy → Run workflow**

The workflow checks the migration state and pushes the committed migrations with the Supabase CLI.

A normal frontend deployment does **not** change the database.

### Recommended testing order

1. Create/use a dedicated Supabase staging project.
2. Run the migration workflow against staging.
3. Confirm authentication, RLS, library/progress, community, and reader flows.
4. Only then point the GitHub Pages deployment at production Supabase if desired.

## 6. Google sign-in

MangaHive uses Google Identity Services plus Supabase Auth.

After the GitHub Pages URL is known:

1. In Google Cloud Console, create/use a **Web application** OAuth client.
2. Add the exact GitHub Pages origin to **Authorized JavaScript origins**.
3. In Supabase → Authentication → Providers → Google, configure Google using the same client credentials/authorized client configuration.
4. Confirm the deployed URL is allowed by the Supabase Auth URL configuration where applicable.
5. Test Google sign-in from the actual Pages URL.

Do not guess the final URL before GitHub has created the Pages site.

## 7. Security rules

Never commit:

- Supabase service-role/secret keys
- Supabase CLI access tokens
- Google OAuth client secrets
- `.env` files containing credentials
- Android signing keys
- private certificates

Safe for the browser:

- Supabase project URL
- Supabase publishable/anon key
- Google OAuth Web client ID

## 8. Local testing

This is a static application. For local testing, serve the repository over HTTP rather than opening `index.html` directly:

```bash
npx serve .
```

The production runtime configuration is deliberately fail-closed until deployment injects real Supabase values.

## 9. If GitHub Actions fails

Check the failed step first:

- **Missing deployment secret:** add the named repository secret.
- **Regression test failure:** do not bypass it; fix the failing test/code first.
- **Pages deployment failure:** verify Pages is set to **GitHub Actions**.
- **Supabase migration failure:** verify the project ID/access token and inspect migration status before rerunning.
- **Google sign-in failure:** verify the exact Pages origin, Google OAuth client ID, and Supabase Google provider configuration.
