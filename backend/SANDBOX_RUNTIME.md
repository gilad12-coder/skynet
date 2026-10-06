# Protected optimizer deployment

Build `backend/Dockerfile` from the same source and dependency lock as the API/worker deployment. The image contains the offline dependencies; wizard execution does not install missing built-in packages. Secrets belong in the trusted parent environment, never the image. `.dockerignore` excludes `.env*`.

## Vercel images

Push a **linux/amd64** image to the selected project's Vercel Container Registry (VCR), wait for its repository state to become **Ready**, and resolve the immutable digest. Set both `DSPY_SANDBOX_IMAGE` and `VERCEL_SANDBOX_IMAGE` to that verified image when using the shared backend profile. Each must contain `@sha256:` followed by the complete 64-character digest. Configure `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` only on the parent. A GHCR reference or a mutable `:latest` tag is not a protected runtime profile.

When extending a VCR image with zstd layers, publish through the Vercel CLI’s OCI Buildx exporter. Preserve the original compression media types when reusing layers; legacy Docker pushes can relabel zstd blobs as gzip. Verify a real sandbox command after publication even when the image is Ready.

Vercel does not execute Docker `CMD` or `ENTRYPOINT`; Skynet starts the runner explicitly. `WORKDIR` is honored. The image is the whole optimizer: the guest runs the image's own `/app` copy of the backend with the image's Python and dependencies, and the parent ships only the request. The two share one contract, `SANDBOX_PROTOCOL` in `core/worker/sandbox_protocol.py`, covering the request and event shapes; bump it whenever either changes incompatibly. Before sending a request, the worker reads the image's own protocol from that module and refuses an image that lacks it (built before it existed) or speaks another one, asking for a rebuild. Worker dependency or Python updates never block a sandbox. A run records the image it first opens on the job (`sandbox_image`), and every later sandbox for that run, including a resume after a redeploy, boots from that image; its GEPA checkpoints are tied to that image alone, not to the worker. Rebuild and re-pin the image to ship optimizer code changes to new runs. Image publication and dependency installation alone do not establish that a live setup check succeeded. [Vercel image documentation](https://vercel.com/docs/sandbox/concepts/images)

Keep runtime networking disabled. The parent owns model dispatch, sandbox controls, credentials, cumulative budget reservations, and final usage settlement. Guests use separate scoped capabilities through the stdout/file mailbox. Anthropic Messages, Chat Completions, and the bounded stateless Responses path share this metered dispatch boundary.

Each paid Continue check and each submitted run creates exactly one outer Vercel execution sandbox. The complete Anything readiness or optimization orchestrator runs there. Scorer, target-agent, and native-engine commands receive private workspaces inside that same boundary, so they do not open or reserve nested Vercel sandboxes. A fresh wizard path has two Continue checks (Evaluation and Optimization) plus the submitted run; matching evidence retries reuse the completed check rather than opening another session. Python scorers also use one dependency-resolution session when a matching lock is unavailable, before the full readiness check. The runtime estimate includes this additional setup session.

## Offline dependencies

| Dependency | Execution identity |
| --- | --- |
| GEPA, including OA engines/recipes | `0632cdb5dcc052e690eab439e1b4a7e3e9cfe407` |
| DSPy | `3.3.1` |
| pip, for scorer wheel resolution | `26.2.1` |
| Node | `22.22.0` |
| Claude Code | `@anthropic-ai/claude-code@2.1.259` |
| Pi | `@earendil-works/pi-coding-agent@0.87.1` |
| Codex | `@openai/codex@0.153.0` |
| OpenCode | `opencode-ai@1.18.27` |
| Prime Agent | `prime-agent@0.9.7` (release tarball), with a prebuilt Python kernel at `/opt/prime-agent/kernel-venv` |
| Deno, for the Flex-capable profile | `2.6.6`, with the prewarmed `/app/.deno` Pyodide cache |

`sandbox-runtime/package-lock.json` locks the CLI dependency graph and package integrity. Prime Agent and its three `@earendil-works/*` runtime packages resolve from Prime Intellect's release host rather than the npm registry, so `NPM_CONFIG_REGISTRY` does not redirect them; air-gap builds mirror that host's `releases/` path and pass it as `PRIME_AGENT_RELEASE_MIRROR` (lockfile integrity still applies). The Prime Agent kernel is built with the image's Python and `PIP_INDEX_URL` from the pinned `sandbox-runtime/prime-agent-kernel.txt`, and the Prime launch sets `PRIME_AGENT_KERNEL_PYTHON` to it so it never bootstraps over the network. Python dependencies come from `uv.lock` or the selected complete requirements lock. Mirror build inputs with the existing `REGISTRY_PREFIX`, `DEBIAN_MIRROR`, `GEPA_GIT_MIRROR`, `PIP_INDEX_URL`, `PIP_TRUSTED_HOST`, `NPM_CONFIG_REGISTRY`, `PRIME_AGENT_RELEASE_MIRROR`, and `DENO_DOWNLOAD_BASE` build arguments. Preserve the GEPA revision and package integrity when mirroring. A deployment may also copy approved wheels into `/opt/skynet/wheels`; those files are server-owned build inputs and must be integrity-pinned with the image.

Codex uses Responses and disables transport retries/websockets in its generated provider configuration. OpenCode's pinned package bundles its OpenAI-compatible provider; the protected profile disables model-catalog refresh, updates, default auth plugins, and language-server downloads. Built-in readiness checks verify exact CLI versions in the selected sandbox. Authored dependency commands run in the same offline Vercel boundary and may use only the pinned image or deployment-owned package artifacts such as `/opt/skynet/wheels`. Scorer and agent dependencies are installed during their paid Continue check; command syntax that requires a real candidate remains separately verified without inventing one. Missing offline dependencies fail setup clearly. The submitted run repeats preparation in its own sandbox so readiness evidence never substitutes for run isolation.

## Scorer packages

Python scorer setup inspects imports in the selected sandbox and resolves missing distributions against the account registry (Settings → Optimization; PyPI by default). Optional package requirements disambiguate import names and version constraints. Resolution uses pip 26.2.1 and accepts wheels with SHA-256 hashes only; source distributions and direct URL requirements are unsupported. The parent brokers bounded registry downloads through a separate package-only mailbox capability, with DNS pinning, TLS verification, and no redirects. Sandbox networking remains disabled.

The signed lock binds exact wheel versions, URLs, and hashes to the scorer source, Python patch version, and immutable sandbox image. Subsequent checks and runs install these artifacts into the private scorer workspace using `--no-index --no-deps --require-hashes`. An altered lock or changed source/image requires resolution again. The full scorer check executes after installation; resolving packages alone is not successful scorer evidence. Resolution and scorer checks use the same authorized setup budget and preserve pending usage and budget stops. Built-in image dependencies remain bound to the image digest. Registry downloads are limited to 256 MiB per wheel and 512 MiB per dependency set.

Candidates the optimizer writes later may import packages the lock never saw. Before such a candidate scores, the parent scans its imports and runs the setup script's `extend` action in the same box: missing roots resolve against the account registry with every locked distribution pinned as a constraint, and only the new wheels install. The relay therefore keeps the index reachable under a lock, bounded by the same budget check and download ceiling. A candidate whose packages cannot be installed receives that failure as scorer feedback.

The image ships OSMesa (`libosmesa6`, `libgl1`, `libglu1-mesa`) and the scorer runs with `PYOPENGL_PLATFORM=osmesa`, so PyOpenGL-based renderers such as pyrender work without a display or GPU.

## External evaluators and tools

User-selected remote evaluators keep their original `POST {candidate, case}` protocol. The parent retains the selected endpoint and bearer credential, pins its permitted DNS address, verifies TLS for the original host, and disables redirects and transport retries. Private/loopback endpoints require the existing explicit `DISCOVER_ALLOW_PRIVATE` deployment opt-in; cloud metadata addresses remain denied. The guest receives an opaque evaluator-only capability, separate from model, tool, and sandbox controls.

External evaluator and MCP service fees are outside Skynet Total. Their relay still checks the owning execution generation and cancellation state; it does not invent zero-cost provider receipts. Every Anything setup and run requires the deployment's managed Vercel profile. The external endpoint call leaves through the trusted parent relay, while optimizer and target execution remain inside the sandbox boundary. A supplied seed is scored on a non-held-out case, and an HTTP failure remains a failed check with the original status. Seedless setup verifies endpoint readiness and clearly defers the actual request until a real candidate exists.

## Recovery contract

An interrupted run is never restarted automatically: a worker shutdown, a lost lease, or a dropped sandbox leaves the run failed with `stop_reason=interrupted`. The owner chooses what happens next: Resume, Retry, or Clone.

| Path | Manual Resume |
| --- | --- |
| DSPy GEPA, including independent GEPA grid pairs | Exact compatible persisted GEPA state |
| Anything, single GEPA engine | Exact compatible persisted GEPA state |
| Meta-Harness, AutoResearch, AutoSaddler, ShinkaEvolve, Auto/omni, other optimizers | Not supported; Retry or Clone instead |

Resume requires state schema 7 at the pinned GEPA revision, matching checkpoint bytes, task/configuration/data, and the run's pinned sandbox image. It retains the same job and cumulative funded budget, fences the previous execution generation, and waits for unresolved prior usage before admitting new work. The resumed run's seed reevaluation is ordinary metered work under that budget.

Budget-reached stops and user cancellation are never resumed without the owner. A fresh restart returns to configuration for fresh authorization. A stopped run retains only an upstream-selected evaluated incumbent, with explicit final-evaluation evidence; no-result stops remain distinct from failures and from evaluated results.
