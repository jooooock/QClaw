import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

// 1. Copy channel.json to Electron's resources directory (if not already there)
const channelSrc = join(root, "src/v0.1.1/resources/channel.json");

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
const rendererPath = join(root, "src/v0.1.1/out/renderer/index.html");
process.env.ELECTRON_RENDERER_URL = pathToFileURL(rendererPath).href;

// 3. Launch Electron
const electronBin = process.platform === "win32" ? "electron.cmd" : "electron";
const electronPath = join(root, "node_modules/.bin", electronBin);

const child = spawn(electronPath, [join(root, "src/v0.1.1")], {
  stdio: "inherit",
  env: process.env,
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});
