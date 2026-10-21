# Skynet for Mac

An Electron shell that runs the whole Skynet stack on your Mac. Jobs use the
coding CLIs you already sign in to (Claude Code, Codex CLI, Factory Droid), not
API keys.

On launch the app:

1. Reads your login shell `PATH` so it finds Homebrew, nvm and `~/.local/bin` tools.
2. Checks Docker, then a coding CLI: installed, new enough, signed in, and not at its usage limit.
   Each failed check shows an onboarding screen with the command to fix it.
3. Stops any API or web server that a crashed earlier session left running (recorded in `stack.pids` by process group and start time),
   removes leftover `skynet.job` containers, then starts Postgres (`pgvector/pgvector:pg16`, container `skynet-local-postgres`, volume `skynet-local-pgdata`).
4. Builds the job sandbox image `skynet-local-sandbox:<bundle id>` from `backend/Dockerfile` once per packaged build
   (the bundle id is version, commit and build time) and removes the tags of older builds.
   It builds for `linux/amd64`, because the Dockerfile installs x64-only harness binaries. Docker Desktop runs it under Rosetta.
5. Installs Python packages with the bundled `uv`, runs `alembic upgrade head`, and starts the API.
6. Starts the bundled Next.js server and opens it in the window.

All services listen on `127.0.0.1` only (API 48100-48119, web 48120-48139, Postgres 48140-48159).
The app removes `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
`FACTORY_API_KEY`, `VERCEL_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `RAILWAY_ENVIRONMENT_NAME` from every child environment.
Quitting stops the web server, the API, Postgres and every `skynet.job` sandbox container.

## Requirements

- macOS on Apple silicon. CI also builds an Intel (x64) app, but nobody has run it on Intel hardware yet.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/), running, with "Use Rosetta for x86_64/amd64 emulation" turned on
- One coding CLI, signed in: `claude` 2.1.226 or newer, `codex` 0.160.0 or newer, or `droid`

## Install a downloaded build

The builds are ad-hoc signed and not notarized, so macOS quarantines a downloaded copy.
Open the `.dmg`, drag Skynet to Applications, then run:

```sh
xattr -dr com.apple.quarantine /Applications/Skynet.app
```

The first launch takes several minutes: it pulls Postgres, builds the sandbox image and installs Python packages.

## Build from source

You need Node 22 and git. From the repository root:

```sh
cd desktop
npm ci
npm test
npm run build:mac
```

`build:mac` compiles the shell, builds the frontend (`next build`, standalone output) when
`frontend/.next/standalone` is missing, stages the tracked backend files, downloads the pinned
`uv` release and checks its SHA-256, then writes `dist/Skynet-<version>-arm64.dmg` and
`dist/mac-arm64/Skynet.app`, plus `dist/Skynet-<version>-x64.dmg` and `dist/mac/Skynet.app`. Set `SKYNET_DESKTOP_REBUILD_FRONTEND=1` to force a fresh frontend build.

Check the signature:

```sh
codesign -dv dist/mac-arm64/Skynet.app
```

A locally built app is not quarantined, so it opens without the `xattr` step.

To run without packaging:

```sh
npm run bundle:stack   # once, or after backend/frontend changes
npm start
```

## Where things live

| Path | Contents |
| --- | --- |
| `~/Library/Application Support/Skynet/secrets.bin` | Postgres password and auth secrets, encrypted with the macOS keychain |
| `~/Library/Application Support/Skynet/local/` | Local state for the backend, including `cli_limits.json` |
| `~/Library/Application Support/Skynet/venv/` | Python environment |
| `~/Library/Application Support/Skynet/runtime/` | The backend and frontend copied out of the app bundle |
| `~/Library/Application Support/Skynet/stack.pids` | Process groups of the running API and web server; removed on a clean quit |
| `~/Library/Application Support/Skynet/logs/` | `desktop.log`, `api.log`, `frontend.log`, `migrate.log`, `sandbox-build.log` |

A rebuilt ad-hoc app has a new signature, so macOS can ask once for keychain access to `secrets.bin`. Choose "Always Allow".

To reset all local data, quit Skynet and run:

```sh
docker volume rm skynet-local-pgdata
rm -rf ~/Library/Application\ Support/Skynet
```

The Postgres password lives in both places, so remove them together.

## Testing onboarding

These variables are for development and tests:

| Variable | Effect |
| --- | --- |
| `SKYNET_DESKTOP_FAKE_CLI_DIR` | Look up `docker`, `claude`, `codex` and `droid` only in this directory. Put small shell scripts there to trigger each onboarding screen. |
| `SKYNET_DESKTOP_DATA_DIR` | Use this directory instead of `~/Library/Application Support/Skynet`. Write `local/cli_limits.json` there to trigger the usage-limit screen. |
| `SKYNET_DESKTOP_LANG` | `en` or `he` |
| `SKYNET_DESKTOP_THEME` | `light` or `dark` |
| `SKYNET_DESKTOP_NO_UPDATE` | `1` turns off the update check |

The version floors in `src/main/cli-detect.ts` copy `MIN_VERSIONS` from the backend CLI catalog. Change both together.

## Releases

Push a `desktop-v<version>` tag. `.github/workflows/desktop.yml` builds and publishes a draft GitHub release.
It notarizes only when the `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` and `CSC_LINK`
(Developer ID certificate) secrets exist. Auto-update needs a Developer ID signature, so ad-hoc builds
log the update error and keep running.
