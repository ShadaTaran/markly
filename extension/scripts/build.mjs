import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "dist");
const watch = process.argv.includes("--watch");

fs.mkdirSync(outdir, { recursive: true });

function copyStatic() {
  fs.copyFileSync(path.join(root, "manifest.json"), path.join(outdir, "manifest.json"));
  fs.copyFileSync(path.join(root, "src/popup/popup.html"), path.join(outdir, "popup.html"));
  fs.copyFileSync(path.join(root, "src/popup/popup.css"), path.join(outdir, "popup.css"));
}

const common = {
  bundle: true,
  platform: "browser",
  target: "chrome110",
  sourcemap: true,
  logLevel: "info",
};

const targets = [
  { entryPoints: [path.join(root, "src/background/service-worker.ts")], outfile: path.join(outdir, "background.js"), format: "esm" },
  { entryPoints: [path.join(root, "src/content/content-script.ts")], outfile: path.join(outdir, "content.js"), format: "iife" },
  { entryPoints: [path.join(root, "src/popup/popup.ts")], outfile: path.join(outdir, "popup.js"), format: "iife" },
];

async function run() {
  copyStatic();

  if (watch) {
    const contexts = await Promise.all(targets.map((target) => context({ ...common, ...target })));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log(`Watching extension source — rebuilding into ${outdir} on change. Reload the unpacked extension in chrome://extensions after each rebuild.`);
  } else {
    await Promise.all(targets.map((target) => build({ ...common, ...target })));
    console.log(`Extension build complete -> ${outdir}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
