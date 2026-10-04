# Staging and production

Skynet runs twice on Railway, in one project with two environments.

| | Staging | Production |
|---|---|---|
| Git branch | `staging` | `main` |
| App | https://frontend-staging-102e.up.railway.app | https://skynetml.com |
| API | https://backend-staging-6295.up.railway.app | https://api.skynetml.com |
| Database | its own Postgres, starts empty | real users |
| Payments | off (no Stripe key) | live Stripe |
| Who uses it | you, to try things | customers |

Staging is a copy of production: the same services (backend, worker,
frontend, LiteLLM, Postgres, PgBouncer, Redis), the same Dockerfiles and the
same settings. The differences are only what has to differ:

- **Its own data.** Separate Postgres, Redis and backup bucket. Nothing you do
  on staging touches a real user, and staging never sees production data.
- **Its own secrets.** New login, session and vault keys, so a production
  login or token does not work on staging and the other way round.
- **No payments.** Billing is switched off. Every account still gets the free
  5 dollar grant, and you can add your own model keys.
- **One copy of each service** instead of two or three, to keep it cheap.
- **Tagged as staging** in Sentry and alerts, and no PostHog analytics.

Model calls on staging are real and cost real dollars, capped by the daily
spend ceiling.

## How a change ships

```
feature branch ──PR──▶ staging ──release PR──▶ main
                         │                      │
                    deploys staging        deploys production
```

1. **Build on a branch.** `git checkout -b feat/my-change`, then commit.
2. **Put it on staging.** Open a PR into `staging` (`gh pr create --base staging`)
   and merge it, or push straight to `staging` when you just want to try
   something. Railway deploys staging within a few minutes. The
   **staging deploy** check on GitHub turns green once staging serves your
   commit, and its summary has the links.
3. **Try it on staging.** Break whatever you like. Nothing needs a rollback:
   push a fix, or reset `staging` to `main`.
4. **Release.** Run `scripts/release.sh`. It opens one PR from `staging` to
   `main` listing everything that ships. CI runs on it. Merge it with
   **Create a merge commit** (`gh pr merge <number> --merge`), not squash,
   so the two branches keep one history. Railway then deploys production,
   after CI passes.

**Hotfixes** can still go straight to `main` through a PR. The **sync staging**
job merges every change on `main` back into `staging`, so a later release
never undoes the fix.

## Starting staging over

Staging is disposable. To throw away experiments and match production again:

```
git push --force origin origin/main:staging
```

The data stays. To wipe it too, delete the staging Postgres volume in Railway.

## Things only you can do

These need the provider consoles, so they are not automatic:

- **Google and GitHub sign-in** on staging. Add these callback URLs to the
  existing OAuth apps, or create separate staging apps:
  - Google: `https://frontend-staging-102e.up.railway.app/api/auth/callback/google`
  - GitHub: `https://frontend-staging-102e.up.railway.app/api/auth/callback/github`

  Email sign-in works on staging without this.
- **Connector sign-ins** (Google Sheets, OneDrive, Notion, Supabase, Hugging
  Face). Add `https://backend-staging-6295.up.railway.app/connectors/<name>/oauth/callback`
  to each app if you want to test them on staging. The GitHub connector,
  which repository runs use, needs none of this: connect it with a personal
  access token.
- **Test payments.** To try checkout, put Stripe *test mode* keys
  (`sk_test_...`) and test price ids on the staging backend and worker.
  Never put the live key on staging.
- **Nicer addresses.** If you want `staging.skynetml.com`, add it as a custom
  domain on the staging frontend in Railway and update the URLs above.
