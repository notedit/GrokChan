// Bundles scripts/elevenlabs-smoke.ts with esbuild (a wrangler dependency) and runs it under Node >= 22.
// usage: ELEVENLABS_API_KEY=... node scripts/elevenlabs-smoke.mjs   (reads process.env only, never prints the key)
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "gc-smoke-")), "smoke.mjs");
await build({ entryPoints: [join(here, "elevenlabs-smoke.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
await import(pathToFileURL(out).href);
