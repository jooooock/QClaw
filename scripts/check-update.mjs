/**
 * check-update.mjs
 *
 * 独立调用 QClaw 检测更新接口，无需启动软件。
 *
 * Usage:
 *   node scripts/check-update.mjs [--version <ver>] [--system <type>] [--raw]
 *
 * Options:
 *   --version <ver>    当前版本号 (default: 从 src/ 目录读取最高版本)
 *   --system  <type>   系统类型: macarm / mac / win (default: 自动检测)
 *   --raw              输出原始 JSON 响应
 *   -h, --help         帮助信息
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const API_URL = "https://jprx.m.qq.com/data/4066/forward";

const STRATEGY_MAP = {
  0: "ignore   (无需更新)",
  1: "recommend (推荐更新)",
  2: "force    (强制更新)",
};

function detectSystemType() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "macarm" : "mac";
  }
  return "win";
}

function getLatestLocalVersion() {
  const srcDir = join(resolve(import.meta.dirname, ".."), "src");
  try {
    const versions = readdirSync(srcDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^v?\d+\.\d+/.test(d.name))
      .map((d) => d.name.replace(/^v/, ""))
      .sort((a, b) => {
        const ap = a.split(".").map(Number);
        const bp = b.split(".").map(Number);
        for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
          const diff = (ap[i] ?? 0) - (bp[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    return versions.length > 0 ? versions[versions.length - 1] : "0.1.3";
  } catch {
    return "0.1.3";
  }
}

function parseArgs() {
  const defaultVersion = getLatestLocalVersion();
  const args = process.argv.slice(2);
  const opts = {
    version: defaultVersion,
    system: detectSystemType(),
    raw: false,
  };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--version" || args[i] === "-v") && args[i + 1]) {
      opts.version = args[++i];
    } else if ((args[i] === "--system" || args[i] === "-s") && args[i + 1]) {
      opts.system = args[++i];
    } else if (args[i] === "--raw") {
      opts.raw = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: node scripts/check-update.mjs [options]

Options:
  --version, -v <ver>    当前版本号 (default: ${defaultVersion}, from src/)
  --system,  -s <type>   系统类型: macarm / mac / win (default: ${detectSystemType()})
  --raw                  输出原始 JSON 响应
  -h, --help             帮助信息

Examples:
  node scripts/check-update.mjs
  node scripts/check-update.mjs --version 0.1.2
  node scripts/check-update.mjs --system win --raw`);
      process.exit(0);
    }
  }
  return opts;
}

function compareVersions(current, latest) {
  const c = current.replace(/^v/, "").split(".").map(Number);
  const l = latest.replace(/^v/, "").split(".").map(Number);
  const len = Math.max(c.length, l.length);
  for (let i = 0; i < len; i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return 1;  // newer
    if (lv < cv) return -1; // older (shouldn't happen normally)
  }
  return 0; // same
}

async function checkUpdate(opts) {
  const body = {
    last_update_time: 0,
    current_version: opts.version,
    system_type: opts.system,
    web_version: "1.4.0",
    web_env: "release",
  };

  const headers = {
    "Content-Type": "application/json",
    "X-Version": "1",
    "X-Token": "m83qdao0AmE5",
    "X-Guid": "1",
    "X-Account": "1",
    "X-Session": "",
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function main() {
  const opts = parseArgs();

  console.log(`Checking update for QClaw v${opts.version} (${opts.system})...\n`);

  const json = await checkUpdate(opts);

  if (opts.raw) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  // Extract data from nested response
  const data =
    json?.data?.resp?.data ??
    json?.data?.data ??
    json?.data ??
    {};

  const latestVersion = data.version_code || "(unknown)";
  const downloadUrl = data.download_url || "(none)";
  const strategy = data.update_strategy;
  const releaseNotes = data.update_content || "(none)";
  const strategyText = STRATEGY_MAP[strategy] ?? `unknown (${strategy})`;

  const cmp = compareVersions(opts.version, latestVersion);
  const statusIcon = cmp > 0 ? "🆕" : cmp === 0 ? "✅" : "⚠️";

  console.log(`Current version:  ${opts.version}`);
  console.log(`Latest version:   ${latestVersion} ${statusIcon}`);
  console.log(`Update strategy:  ${strategyText}`);
  console.log(`Download URL:     ${downloadUrl}`);
  console.log(`Release notes:    ${releaseNotes}`);

  if (cmp > 0) {
    console.log(`\n${statusIcon} New version available!`);
  } else {
    console.log(`\n${statusIcon} Already up to date.`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
