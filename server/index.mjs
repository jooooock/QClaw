import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createPrompt, createCancel, newSessionId, newPromptId } from "./agp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "9099", 10);
const TOKEN = process.env.TOKEN || "my-secret-token";

// ============================================
// State
// ============================================

/** The single QClaw WebSocket client (or null) */
let qclawWs = null;

/** SSE clients waiting for events */
const sseClients = new Set();

/** Current active session */
let currentSessionId = newSessionId();

/** Current active prompt (null = idle) */
let currentPromptId = null;

// ============================================
// SSE broadcast
// ============================================

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ============================================
// HTTP server
// ============================================

const indexHtml = readFileSync(join(__dirname, "public/index.html"), "utf-8");

const httpServer = createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET / — Web UI
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }

  // GET /api/status — connection status
  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: qclawWs !== null, busy: currentPromptId !== null }));
    return;
  }

  // GET /api/events — SSE stream
  if (req.method === "GET" && req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Send initial status
    res.write(`event: status\ndata: ${JSON.stringify({ connected: qclawWs !== null })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // POST /api/send — send message to QClaw
  if (req.method === "POST" && req.url === "/api/send") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || !text.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }
        if (!qclawWs) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "QClaw client not connected" }));
          return;
        }
        if (currentPromptId) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "A prompt is already in progress" }));
          return;
        }

        currentPromptId = newPromptId();
        const envelope = createPrompt(currentSessionId, currentPromptId, text.trim());
        qclawWs.send(JSON.stringify(envelope));
        console.log(`[AGP] >>> session.prompt: "${text.trim().slice(0, 60)}..." promptId=${currentPromptId}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, promptId: currentPromptId }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/cancel — cancel current prompt
  if (req.method === "POST" && req.url === "/api/cancel") {
    if (!qclawWs || !currentPromptId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No active prompt to cancel" }));
      return;
    }
    const envelope = createCancel(currentSessionId, currentPromptId);
    qclawWs.send(JSON.stringify(envelope));
    console.log(`[AGP] >>> session.cancel: promptId=${currentPromptId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/new-session — start a new session
  if (req.method === "POST" && req.url === "/api/new-session") {
    currentSessionId = newSessionId();
    currentPromptId = null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionId: currentSessionId }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ============================================
// WebSocket server (AGP)
// ============================================

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  // Token auth
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  if (token !== TOKEN) {
    console.log(`[WSS] Rejected connection: invalid token "${token}"`);
    ws.close(4001, "Invalid token");
    return;
  }

  // Only allow one QClaw client
  if (qclawWs) {
    console.log("[WSS] Replacing existing QClaw connection");
    qclawWs.close(4002, "Replaced by new connection");
  }

  qclawWs = ws;
  console.log("[WSS] QClaw client connected");
  broadcast("status", { connected: true });

  ws.on("message", (data) => {
    try {
      const envelope = JSON.parse(data.toString());
      handleAGPMessage(envelope);
    } catch (e) {
      console.error("[WSS] Failed to parse message:", e.message);
    }
  });

  ws.on("close", (code, reason) => {
    if (qclawWs === ws) {
      qclawWs = null;
      currentPromptId = null;
      console.log(`[WSS] QClaw client disconnected: code=${code} reason=${reason}`);
      broadcast("status", { connected: false });
    }
  });

  ws.on("error", (err) => {
    console.error("[WSS] WebSocket error:", err.message);
  });
});

// ============================================
// AGP message handler
// ============================================

function handleAGPMessage(envelope) {
  const { method, payload } = envelope;

  if (method === "session.update") {
    const { update_type, content, tool_call, prompt_id } = payload;

    if (update_type === "message_chunk" && content) {
      broadcast("chunk", { text: content.text, promptId: prompt_id });
    } else if (update_type === "tool_call" && tool_call) {
      console.log(`[AGP] <<< tool_call: ${tool_call.title || tool_call.tool_call_id} (${tool_call.status})`);
      broadcast("tool", { toolCall: tool_call, promptId: prompt_id });
    } else if (update_type === "tool_call_update" && tool_call) {
      console.log(`[AGP] <<< tool_call_update: ${tool_call.tool_call_id} (${tool_call.status})`);
      broadcast("tool", { toolCall: tool_call, promptId: prompt_id });
    }
  } else if (method === "session.promptResponse") {
    const { stop_reason, content, error, prompt_id } = payload;
    console.log(`[AGP] <<< promptResponse: stop_reason=${stop_reason}`);

    let finalText = "";
    if (content && Array.isArray(content)) {
      finalText = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
    broadcast("done", { stopReason: stop_reason, text: finalText, error, promptId: prompt_id });

    if (currentPromptId === prompt_id) {
      currentPromptId = null;
    }
  } else {
    console.log(`[AGP] <<< unknown method: ${method}`);
  }
}

// ============================================
// Start
// ============================================

httpServer.listen(PORT, () => {
  console.log(`\n  AGP Bridge Server running on http://localhost:${PORT}`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  QClaw should connect to: ws://localhost:${PORT}?token=${TOKEN}\n`);
});
