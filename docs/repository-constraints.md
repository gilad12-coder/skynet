# Repository constraints: `optimize.toml`

A repository run reads an `optimize.toml` file at the root of the repository,
at the pinned commit. The file can only narrow the settings that the run's
owner approved. It cannot widen them, and it cannot grant services.

```toml
version = 1

[paths]
# Optional. Each path must be inside an approved editable path.
editable = ["bot/geocode"]
# Optional. No version may change these, even inside an editable path.
protected = ["bot/geocode/eval", "data/labels.csv"]

[setup]
# Optional. Used only when the run has no setup command of its own.
command = "pip install -r requirements.txt"

[instructions]
# Optional. The optimization agent reads these as guidance. They are not enforced.
intent = "Return the coordinates of the place the sender most likely means."
invariants = ["Keep the reply format unchanged."]
```

## What is enforced

| Setting | Enforcement |
| --- | --- |
| `[paths] editable` | The parent checks every version before it is scored or published. A path outside the approved editable paths fails the setup check. |
| `[paths] protected` | The parent rejects a version that changes a protected path, in its patch or while its code runs. A write that the code undoes before it exits also counts. The rejection names the path and the rule, with secret values hidden. `optimize.toml` itself is always protected. |
| `[setup] command` | Runs once on the starting commit, with package-registry network and no secrets. The box goes offline before any version runs. |
| `[instructions]` | Not enforced. The agent reads them in its brief. The scorer decides the score. |

## What fails the setup check

- A `[services]` section. Repository runs cannot reach outside services yet,
  and a repository file can never grant them.
- An unknown section or setting, a `version` other than `1`, or invalid TOML.
- A path that leaves the repository, names `.git`, or protects the whole tree.
- A path with `*`, `?` or `[`. Paths are literal; patterns are not supported,
  so name the files or folders.
- An empty `[paths] editable` list, or protected paths that cover every
  editable path. Such a run could not change anything. This includes a run
  without the file whose only approved editable path is `optimize.toml`,
  because `optimize.toml` is always protected.
- An `optimize.toml` that is a link or a folder, or a file larger than 64 KiB.

## Where the effective environment is recorded

The setup check response includes `environment`. The run saves the same
record under `target.repo.environment`. It holds the commit, the editable,
protected and read-only paths, the secret names (never values), the setup
command, the network for setup and for versions, and the services (none).
A resumed run that arrives at different rules fails instead of continuing.
