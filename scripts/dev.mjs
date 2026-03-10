import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const srcDir = join(root, "src");

// 0. Parse version argument
const version = process.argv[2];

if (!version) {
  const versions = readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  console.log("Available versions:");
  versions.forEach((v) => console.log(`  ${v}`));
  console.log(`\nUsage: yarn dev <version>\nExample: yarn dev ${versions[0] ?? "v0.1.1"}`);
  process.exit(0);
}

const versionDir = join(srcDir, version);
if (!existsSync(versionDir)) {
  console.error(`Version directory not found: src/${version}`);
  process.exit(1);
}

// 1. Copy channel.json to Electron's resources directory (if not already there)
const channelSrc = join(versionDir, "resources/channel.json");

let electronResourcesDir;
if (process.platform === "darwin") {
  electronResourcesDir = join(root, "node_modules/electron/dist/Electron.app/Contents/Resources");
} else {
  // Windows & Linux
  electronResourcesDir = join(root, "node_modules/electron/dist/resources");
}

const channelDest = join(electronResourcesDir, "channel.json");
if (!existsSync(channelDest)) {
  copyFileSync(channelSrc, channelDest);
}

// 2. Set ELECTRON_RENDERER_URL with cross-platform file:// URL
const rendererPath = join(versionDir, "out/renderer/index.html");
process.env.ELECTRON_RENDERER_URL = pathToFileURL(rendererPath).href;

// 3. Launch Electron
const electronBin = process.platform === "win32" ? "electron.cmd" : "electron";
const electronPath = join(root, "node_modules/.bin", electronBin);

const child = spawn(electronPath, [versionDir], {
  stdio: "inherit",
  env: process.env,
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});
