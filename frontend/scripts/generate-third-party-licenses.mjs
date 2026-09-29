/**
 * Write the license text of every installed production dependency to
 * `public/THIRD_PARTY_LICENSES.txt`.
 *
 * The standalone Next.js output copies dependency code into the image without
 * the packages' LICENSE files, so MIT/BSD/Apache notice conditions would go
 * unmet. The Dockerfile runs this before `next build`, so the file ships in
 * `public/` next to the hand-written `THIRD_PARTY_NOTICES.txt`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

const sections = [];
const missing = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path || meta.dev || meta.link) continue;
  const dir = join(root, path);
  // Optional platform packages for other OSes are in the lockfile but not on disk.
  if (!existsSync(dir)) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const files = readdirSync(dir).filter((file) => LICENSE_FILE.test(file)).sort();
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = meta.license ?? manifest.license ?? manifest.licenses?.map((entry) => entry.type).join(" OR ");
  // Unlicensed peer-only installs (e.g. @splinetool/runtime) are never imported, so never bundled.
  if (meta.peer && !license && files.length === 0) continue;
  const header = `${name}@${meta.version} (${license ?? "UNKNOWN"})`;
  if (files.length === 0) missing.push(header);
  const texts = files.map((file) => readFileSync(join(dir, file), "utf8").trim());
  sections.push([header, "=".repeat(header.length), ...texts].join("\n\n"));
}

const intro = [
  "Third-party software licenses",
  "",
  "License texts of the npm packages bundled into this frontend, generated at",
  "build time from package-lock.json. See THIRD_PARTY_NOTICES.txt for copied",
  "source, fonts and copyleft components.",
  missing.length ? `\nPackages without a license file (declared license shown):\n${missing.join("\n")}` : "",
].join("\n");
writeFileSync(join(root, "public", "THIRD_PARTY_LICENSES.txt"), `${intro}\n\n\n${sections.join("\n\n\n")}\n`);
console.log(`Wrote licenses for ${sections.length} packages (${missing.length} without a license file).`);
