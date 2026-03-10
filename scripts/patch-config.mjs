/**
 * patch-config.mjs
 *
 * 将 ~/.qclaw/openclaw.json 中的 wechat-access 通道配置
 * 指向本地自建 WSS 服务器，使 QClaw 连接本地而非腾讯服务器。
 *
 * Usage:
 *   node scripts/patch-config.mjs [--ws-url <url>] [--token <token>]
 *
 * 默认值：
 *   --ws-url  ws://localhost:9099
 *   --token   my-secret-token
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const configPath = join(homedir(), ".qclaw", "openclaw.json");

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    wsUrl: "ws://localhost:9099",
    token: "my-secret-token",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ws-url" && args[i + 1]) {
      opts.wsUrl = args[++i];
    } else if (args[i] === "--token" && args[i + 1]) {
      opts.token = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: node scripts/patch-config.mjs [options]

Options:
  --ws-url <url>    WebSocket server URL (default: ws://localhost:9099)
  --token  <token>  Channel auth token  (default: my-secret-token)
  -h, --help        Show this help`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs();

if (!existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  console.error("Please run QClaw at least once to generate the config file.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));

// Ensure channels.wechat-access exists
if (!config.channels) config.channels = {};
if (!config.channels["wechat-access"]) config.channels["wechat-access"] = {};

const wa = config.channels["wechat-access"];
const oldWsUrl = wa.wsUrl;
const oldToken = wa.token;

wa.wsUrl = opts.wsUrl;
wa.token = opts.token;

writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

console.log(`Patched ${configPath}`);
console.log(`  wsUrl: ${oldWsUrl || "(empty)"} -> ${opts.wsUrl}`);
console.log(`  token: ${oldToken || "(empty)"} -> ${opts.token}`);
