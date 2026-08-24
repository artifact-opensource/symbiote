var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_express = __toESM(require("express"), 1);
var import_path = __toESM(require("path"), 1);
var import_cors = __toESM(require("cors"), 1);
var import_dotenv = __toESM(require("dotenv"), 1);
var import_vite = require("vite");

// ../mach6-core/dist/sessions/manager.js
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var DEFAULT_DIR = "/opt/ava/mach6/.sessions";
var DEFAULT_TTL = 7 * 24 * 60 * 60 * 1e3;
function sanitizeToolPairs(messages) {
  const allToolCallIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls)
        allToolCallIds.add(tc.id);
    }
    if (msg.role === "assistant" && typeof msg.content !== "string") {
      for (const b of msg.content) {
        if (b.type === "tool_use" && b.id)
          allToolCallIds.add(b.id);
      }
    }
  }
  const allResultRefs = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id)
      allResultRefs.add(msg.tool_call_id);
    if (typeof msg.content !== "string") {
      for (const b of msg.content) {
        if (b.type === "tool_result" && b.tool_use_id)
          allResultRefs.add(b.tool_use_id);
      }
    }
  }
  const filtered = messages.filter((msg) => {
    if (msg.role === "tool" && msg.tool_call_id) {
      if (!allToolCallIds.has(msg.tool_call_id)) {
        console.log(`[sessions] Dropping orphaned tool result: ${msg.tool_call_id}`);
        return false;
      }
    }
    if (typeof msg.content !== "string" && msg.content.some((b) => b.type === "tool_result")) {
      const hasOrphan = msg.content.some((b) => b.type === "tool_result" && b.tool_use_id && !allToolCallIds.has(b.tool_use_id));
      if (hasOrphan) {
        const validBlocks = msg.content.filter((b) => {
          if (b.type === "tool_result" && b.tool_use_id && !allToolCallIds.has(b.tool_use_id)) {
            console.log(`[sessions] Dropping orphaned tool_result block: ${b.tool_use_id}`);
            return false;
          }
          return true;
        });
        if (validBlocks.length === 0)
          return false;
        msg.content = validBlocks;
      }
    }
    return true;
  });
  return filtered;
}
var SessionManager = class {
  dir;
  ttl;
  constructor(baseDir, ttl) {
    this.dir = baseDir ?? import_node_path.default.join(import_node_os.default.homedir(), DEFAULT_DIR);
    this.ttl = ttl ?? DEFAULT_TTL;
    import_node_fs.default.mkdirSync(this.dir, { recursive: true });
  }
  filePath(id) {
    const safe = id.replace(/[^a-zA-Z0-9_\-:.]/g, "_");
    return import_node_path.default.join(this.dir, `${safe}.json`);
  }
  defaultMetadata() {
    return { messageCount: 0, tokenUsage: { input: 0, output: 0 }, toolsUsed: {}, depth: 0 };
  }
  create(id, opts) {
    const session = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      metadata: {
        ...this.defaultMetadata(),
        label: opts?.label,
        provider: opts?.provider,
        model: opts?.model,
        parentSessionId: opts?.parentSessionId,
        depth: opts?.depth ?? 0
      }
    };
    this.save(session);
    return session;
  }
  load(id) {
    try {
      const data = JSON.parse(import_node_fs.default.readFileSync(this.filePath(id), "utf-8"));
      if (!data.metadata || typeof data.metadata !== "object" || !("messageCount" in data.metadata)) {
        data.metadata = { ...this.defaultMetadata(), ...data.metadata ?? {} };
      }
      const cleaned = sanitizeToolPairs(data.messages);
      if (cleaned.length < data.messages.length) {
        data.messages = cleaned;
        data.updatedAt = Date.now();
        try {
          import_node_fs.default.writeFileSync(this.filePath(id), JSON.stringify(data, null, 2));
        } catch {
        }
      } else {
        data.messages = cleaned;
      }
      return data;
    } catch {
      return null;
    }
  }
  save(session) {
    session.updatedAt = Date.now();
    session.metadata.messageCount = session.messages.length;
    import_node_fs.default.writeFileSync(this.filePath(session.id), JSON.stringify(session, null, 2));
  }
  delete(id) {
    try {
      import_node_fs.default.unlinkSync(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }
  list() {
    try {
      const summaries = [];
      for (const f of import_node_fs.default.readdirSync(this.dir).filter((f2) => f2.endsWith(".json"))) {
        try {
          const s = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(this.dir, f), "utf-8"));
          summaries.push({
            id: s.id,
            label: s.metadata?.label,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length,
            provider: s.metadata?.provider,
            model: s.metadata?.model
          });
        } catch {
        }
      }
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }
  /** Update token usage */
  trackUsage(session, input, output) {
    session.metadata.tokenUsage.input += input;
    session.metadata.tokenUsage.output += output;
  }
  /** Track tool call */
  trackToolCall(session, toolName) {
    session.metadata.toolsUsed[toolName] = (session.metadata.toolsUsed[toolName] ?? 0) + 1;
  }
  /** Clean up stale sessions older than TTL */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    try {
      for (const f of import_node_fs.default.readdirSync(this.dir).filter((f2) => f2.endsWith(".json"))) {
        try {
          const s = JSON.parse(import_node_fs.default.readFileSync(import_node_path.default.join(this.dir, f), "utf-8"));
          if (now - s.updatedAt > this.ttl) {
            import_node_fs.default.unlinkSync(import_node_path.default.join(this.dir, f));
            cleaned++;
          }
        } catch {
        }
      }
    } catch {
    }
    return cleaned;
  }
  /** Rename / label a session */
  setLabel(id, label) {
    const session = this.load(id);
    if (!session)
      return false;
    session.metadata.label = label;
    this.save(session);
    return true;
  }
  // ── Session Archival ─────────────────────────────────────────────────────
  archiveDir() {
    const dir = import_node_path.default.join(this.dir, "archive");
    import_node_fs.default.mkdirSync(dir, { recursive: true });
    return dir;
  }
  /**
   * Archive a session: move old messages to an archive file, keep only
   * the system prompt + last N messages in the active session.
   * Returns number of messages archived.
   */
  archive(id, keepMessages = 20) {
    const session = this.load(id);
    if (!session || session.messages.length <= keepMessages)
      return 0;
    const systemMsgs = session.messages.filter((m) => m.role === "system");
    const convMsgs = session.messages.filter((m) => m.role !== "system");
    if (convMsgs.length <= keepMessages)
      return 0;
    const toArchive = convMsgs.slice(0, convMsgs.length - keepMessages);
    const toKeep = convMsgs.slice(convMsgs.length - keepMessages);
    const archiveSummary = this.extractArchiveSummary(toArchive);
    const archiveFile = import_node_path.default.join(this.archiveDir(), `${id.replace(/[^a-zA-Z0-9_\-:.]/g, "_")}-${Date.now()}.json`);
    const archiveData = {
      sessionId: id,
      archivedAt: Date.now(),
      messageCount: toArchive.length,
      tokenUsage: { ...session.metadata.tokenUsage },
      messages: toArchive
    };
    import_node_fs.default.writeFileSync(archiveFile, JSON.stringify(archiveData));
    session.messages = [...systemMsgs, ...toKeep];
    if (archiveSummary) {
      session.messages.splice(systemMsgs.length, 0, {
        role: "user",
        content: archiveSummary
      });
    }
    this.save(session);
    console.log(`[sessions] Archived ${toArchive.length} messages from ${id} \u2192 ${import_node_path.default.basename(archiveFile)}`);
    return toArchive.length;
  }
  /**
   * Auto-archive sessions that exceed a size threshold.
   * Call periodically (e.g., after each agent turn).
   */
  autoArchive(maxSizeBytes = 200 * 1024, keepMessages = 30) {
    let totalArchived = 0;
    try {
      for (const f of import_node_fs.default.readdirSync(this.dir).filter((f2) => f2.endsWith(".json"))) {
        const fp = import_node_path.default.join(this.dir, f);
        try {
          const stat = import_node_fs.default.statSync(fp);
          if (stat.size > maxSizeBytes) {
            const id = f.replace(".json", "").replace(/_/g, "/");
            const session = JSON.parse(import_node_fs.default.readFileSync(fp, "utf-8"));
            totalArchived += this.archive(session.id, keepMessages);
          }
        } catch {
        }
      }
    } catch {
    }
    return totalArchived;
  }
  /**
   * Extract a summary of key decisions and findings from messages being archived.
   * Keeps the LLM aware of what happened earlier without the full conversation.
   */
  extractArchiveSummary(messages) {
    if (messages.length === 0)
      return null;
    const findings = [];
    const toolsUsed = [];
    const filesRead = [];
    const filesWritten = [];
    const commands = [];
    for (const msg of messages) {
      if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 50 && !msg.tool_calls?.length) {
        const firstSentence = msg.content.split(/[.!?\n]/)[0]?.trim();
        if (firstSentence && firstSentence.length > 20 && firstSentence.length < 200) {
          findings.push(firstSentence);
        }
      }
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name === "read" && tc.input?.path) {
            filesRead.push(String(tc.input.path).split("/").pop() || String(tc.input.path));
          } else if (tc.name === "write" && tc.input?.path) {
            filesWritten.push(String(tc.input.path).split("/").pop() || String(tc.input.path));
          } else if (tc.name === "exec" && tc.input?.command) {
            const cmd = String(tc.input.command).slice(0, 60);
            commands.push(cmd);
          } else if (!["read", "write", "exec"].includes(tc.name)) {
            toolsUsed.push(tc.name);
          }
        }
      }
    }
    const parts = ["[Earlier conversation archived. Key context:]"];
    if (filesRead.length > 0) {
      parts.push(`\u2022 Read: ${[...new Set(filesRead)].slice(0, 10).join(", ")}`);
    }
    if (filesWritten.length > 0) {
      parts.push(`\u2022 Wrote: ${[...new Set(filesWritten)].slice(0, 10).join(", ")}`);
    }
    if (commands.length > 0) {
      parts.push(`\u2022 Commands: ${[...new Set(commands)].slice(0, 5).join("; ")}`);
    }
    if (toolsUsed.length > 0) {
      parts.push(`\u2022 Tools: ${[...new Set(toolsUsed)].join(", ")}`);
    }
    if (findings.length > 0) {
      parts.push(`\u2022 Findings: ${findings.slice(0, 5).join(". ")}`);
    }
    if (parts.length <= 1)
      return null;
    return parts.join("\n");
  }
};

// server.ts
import_dotenv.default.config();
var app = (0, import_express.default)();
var port = parseInt(process.env.WEBUI_PORT || '3010', 10);
var host = process.env.WEBUI_HOST || '0.0.0.0';
var sessionManager = new SessionManager();
app.use((0, import_cors.default)());
app.use(import_express.default.json());
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = sessionManager.list();
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: "Failed to list sessions" });
  }
});
app.get("/api/sessions/:id", (req, res) => {
  try {
    const session = sessionManager.load(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: "Failed to load session" });
  }
});
app.post("/api/sessions", (req, res) => {
  try {
    const { label, provider, model } = req.body;
    const id = `sess_${Date.now()}`;
    const session = sessionManager.create(id, { label, provider, model });
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: "Failed to create session" });
  }
});
app.delete("/api/sessions/:id", (req, res) => {
  try {
    const success = sessionManager.delete(req.params.id);
    res.json({ success });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: "Missing sessionId or message" });
  }
  try {
    let session = sessionManager.load(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    session.messages.push({ role: "user", content: message });
    sessionManager.save(session);
    const response = await fetch("http://127.0.0.1:3000/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        messages: session.messages
      })
    });
    const data = await response.json();
    session.messages.push({
      role: "assistant",
      content: data.content
    });
    sessionManager.save(session);
    res.json({ content: data.content });
  } catch (e) {
    console.error("[Symbiote Server] Chat Error:", e);
    res.status(500).json({ error: "Gateway communication failed" });
  }
});
async function startServer() {
  const vite = await (0, import_vite.createServer)({
    server: { middlewareMode: true },
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use((req, res, next) => {
    const url = req.originalUrl;
    if (url.startsWith("/@vite/client")) {
      return next();
    }
    res.sendFile(import_path.default.resolve(__dirname, "index.html"));
  });
  app.listen(port, host, () => {
    console.log(`Symbiote Bridge running at http://${host}:${port}`);
  });
}
startServer();
//# sourceMappingURL=server.cjs.map
