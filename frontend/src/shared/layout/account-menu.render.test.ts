import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// The privacy tab pulls in a stylesheet that node cannot load.
const stub = path.join(
  frontend,
  "src/features/optimizations/components/__fixtures__/style-stub.ts",
);

// node --test only loads .ts, so the .tsx render test runs in a jiti child.
void it("AccountMenu render tests pass", () => {
  const result = spawnSync(
    path.join(frontend, "node_modules/.bin/jiti"),
    ["src/shared/layout/account-menu.test.tsx"],
    {
      cwd: frontend,
      encoding: "utf8",
      env: {
        ...process.env,
        JITI_JSX: "1",
        JITI_ALIAS: JSON.stringify({
          "@/": `${path.join(frontend, "src")}/`,
          "react-loading-skeleton/dist/skeleton.css": stub,
        }),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

void it("AccountMenu link state tests pass", () => {
  const fixtures = path.join(frontend, "src/shared/layout/__fixtures__");
  const result = spawnSync(
    path.join(frontend, "node_modules/.bin/jiti"),
    ["src/shared/layout/account-menu.states.test.tsx"],
    {
      cwd: frontend,
      encoding: "utf8",
      env: {
        ...process.env,
        JITI_JSX: "1",
        JITI_ALIAS: JSON.stringify({
          "@/shared/hooks/use-linked-account": path.join(fixtures, "linked-account-mock.ts"),
          "@/shared/ui/primitives/popover": path.join(fixtures, "popover-inline.tsx"),
          "@/": `${path.join(frontend, "src")}/`,
        }),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
