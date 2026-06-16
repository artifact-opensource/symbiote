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
var import_os = __toESM(require("os"), 1);
var import_dotenv = __toESM(require("dotenv"), 1);
var import_genai = require("@google/genai");
var import_vite = require("vite");
import_dotenv.default.config();
var app = (0, import_express.default)();
var PORT = parseInt(process.env.PORT || "3010");
app.use(import_express.default.json({ limit: "15mb" }));
var ai = null;
try {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    ai = new import_genai.GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
  } else {
    console.warn("WARNING: GEMINI_API_KEY is not defined in the environment. Symbiote will run in simulated mode.");
  }
} catch (error) {
  console.error("Failed to initialize GoogleGenAI client:", error);
}
function collectTelemetry() {
  const cpus = import_os.default.cpus();
  const loadavg = import_os.default.loadavg();
  const freemem = import_os.default.freemem();
  const totalmem = import_os.default.totalmem();
  const usedmem = totalmem - freemem;
  const memPercent = (usedmem / totalmem * 100).toFixed(1);
  const cpuCount = cpus.length;
  const cpuLoadPercent = (loadavg[0] / cpuCount * 100).toFixed(1);
  const processUptime = process.uptime();
  const systemUptime = import_os.default.uptime();
  const netInterfaces = import_os.default.networkInterfaces();
  const activeInterfaces = {};
  for (const [name, addrs] of Object.entries(netInterfaces)) {
    if (addrs) {
      const active = addrs.filter((a) => !a.internal);
      if (active.length > 0) activeInterfaces[name] = active.map((a) => ({ address: a.address, family: a.family, internal: a.internal }));
    }
  }
  const memPerProcess = process.memoryUsage();
  return {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    hostname: import_os.default.hostname(),
    platform: import_os.default.platform(),
    arch: import_os.default.arch(),
    release: import_os.default.release(),
    cpu: {
      model: cpus[0]?.model || "unknown",
      cores: cpuCount,
      speed: cpus[0]?.speed || 0,
      load: {
        "1min": +loadavg[0].toFixed(3),
        "5min": +loadavg[1].toFixed(3),
        "15min": +loadavg[2].toFixed(3),
        percent: +cpuLoadPercent
      }
    },
    memory: {
      total: totalmem,
      used: usedmem,
      free: freemem,
      percent: +memPercent,
      process: {
        rss: memPerProcess.rss,
        heapTotal: memPerProcess.heapTotal,
        heapUsed: memPerProcess.heapUsed,
        external: memPerProcess.external
      }
    },
    uptime: {
      system: systemUptime,
      systemFormatted: formatUptime(systemUptime),
      process: processUptime,
      processFormatted: formatUptime(processUptime)
    },
    network: activeInterfaces,
    env: {
      nodeVersion: process.version,
      pid: process.pid,
      cwd: process.cwd()
    }
  };
}
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor(seconds % 86400 / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    symbioteStatus: "active",
    apiAvailable: !!ai,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/api/telemetry", (req, res) => {
  try {
    const telemetry = collectTelemetry();
    res.json(telemetry);
  } catch (err) {
    console.error("Telemetry collection error:", err);
    res.status(500).json({ error: "Failed to collect telemetry", message: err?.message });
  }
});
var symbioteState = {
  coreCohesion: 98.4,
  thermalLevel: 34.2,
  neuralBandwidth: 1240,
  connectedSymbionts: 1,
  memoryEntropy: 0.12,
  pluginStates: {
    "system-monitor": true,
    "sensory-feedback": true,
    "neural-archives": true,
    "vision-projection": true,
    "biometric-breath": true
  }
};
function generateProceduralFallbackImage(prompt, aspectRatio) {
  const width = aspectRatio === "16:9" ? 800 : aspectRatio === "9:16" ? 450 : 600;
  const height = aspectRatio === "16:9" ? 450 : aspectRatio === "9:16" ? 800 : 600;
  const neonColors = ["#06b6d4", "#a855f7", "#ec4899", "#10b981", "#3b82f6"];
  const themeColor = neonColors[Math.floor(Math.random() * neonColors.length)];
  const secondColor = neonColors[Math.floor(Math.random() * neonColors.length)];
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">
      <rect width="100%" height="100%" fill="#05050a" />
      <defs>
        <radialGradient id="ringGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${themeColor}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${themeColor}" />
          <stop offset="100%" stop-color="${secondColor}" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#ringGlow)" />
      <g opacity="0.15">
        ${Array.from({ length: 20 }, (_, i) => `
          <line x1="0" y1="${height / 20 * i}" x2="${width}" y2="${height / 20 * i}" stroke="#ffffff" stroke-width="0.5" />
          <line x1="${width / 20 * i}" y1="0" x2="${width / 20 * i}" y2="${height}" stroke="#ffffff" stroke-width="0.5" />
        `).join("")}
      </g>
      <g stroke="url(#lineGrad)" fill="none" opacity="0.8">
        <path d="M ${width * 0.1} ${height * 0.5} Q ${width * 0.3} ${height * 0.2}, ${width * 0.5} ${height * 0.5} T ${width * 0.9} ${height * 0.5}" stroke-width="3" />
        <path d="M ${width * 0.15} ${height * 0.4} Q ${width * 0.4} ${height * 0.8}, ${width * 0.6} ${height * 0.3} T ${width * 0.85} ${height * 0.6}" stroke-width="1.5" />
        <path d="M ${width * 0.2} ${height * 0.6} C ${width * 0.4} ${height * 0.1}, ${width * 0.6} ${height * 0.9}, ${width * 0.8} ${height * 0.4}" stroke-width="1" stroke-dasharray="5,5" />
      </g>
      <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) * 0.2}" fill="none" stroke="url(#lineGrad)" stroke-width="2" opacity="0.5" filter="blur(1px)" />
      <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) * 0.15}" fill="none" stroke="${themeColor}" stroke-width="4" />
      <circle cx="${width / 2}" cy="${height / 2}" r="12" fill="#ffffff" />
      <text x="30" y="${height - 60}" fill="#94a3b8" font-family="monospace" font-size="12" opacity="0.6">&gt; SYMBIOTE SYNTHETIC IMAGE FALLBACK</text>
      <text x="30" y="${height - 40}" fill="${themeColor}" font-family="monospace" font-size="14" font-weight="bold">&gt; PROJECTION: "${prompt.slice(0, 45).toUpperCase()}..."</text>
      <text x="30" y="${height - 20}" fill="#94a3b8" font-family="monospace" font-size="11" opacity="0.6">&gt; ASPECT: ${aspectRatio} | MATRIX COHESION: SECURE</text>
    </svg>
  `;
  const base64Svg = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${base64Svg}`;
}
app.post("/api/generate-image", async (req, res) => {
  const { prompt, aspectRatio = "1-1" } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "No prompt supplied for image generation." });
  }
  const aspectMap = {
    "1:1": "1:1",
    "4:3": "4:3",
    "3:4": "3:4",
    "16:9": "16:9",
    "9:16": "9:16",
    "1-1": "1:1",
    "4-3": "4:3",
    "3-4": "3:4",
    "16-9": "16:9",
    "9-16": "9:16"
  };
  const standardAspect = aspectMap[aspectRatio] || "1:1";
  const dimMap = {
    "1:1": [1024, 1024],
    "4:3": [1024, 768],
    "3:4": [768, 1024],
    "16:9": [1344, 768],
    "9:16": [768, 1344]
  };
  const [w, h] = dimMap[standardAspect] || [1024, 1024];
  try {
    const encodedPrompt = encodeURIComponent(prompt);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${w}&height=${h}&nologo=true&seed=${Math.floor(Math.random() * 999999)}`;
    const fetch = (await import("node-fetch")).default;
    const imgRes = await fetch(pollinationsUrl, { timeout: 15e3 });
    if (imgRes.ok && imgRes.headers.get("content-type")?.includes("image")) {
      const imgBuffer = await imgRes.buffer();
      const base64 = imgBuffer.toString("base64");
      const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
      const imageUrl = `data:${mimeType};base64,${base64}`;
      console.log(`[IMAGE] Pollinations.ai success \u2014 ${imgBuffer.length} bytes, ${standardAspect}`);
      return res.json({ imageUrl, source: "pollinations", simulated: false });
    }
    console.warn("[IMAGE] Pollinations returned non-image response, trying next...");
  } catch (err) {
    console.warn("[IMAGE] Pollinations failed:", err?.message || err);
  }
  if (ai) {
    try {
      console.log(`[IMAGE] Trying Gemini for: "${prompt}"`);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: { parts: [{ text: prompt }] },
        config: { imageConfig: { aspectRatio: standardAspect } }
      });
      let base64Data = null;
      if (response.candidates?.[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData?.data) {
            base64Data = part.inlineData.data;
            break;
          }
        }
      }
      if (base64Data) {
        const imageUrl = `data:image/png;base64,${base64Data}`;
        console.log(`[IMAGE] Gemini success \u2014 ${standardAspect}`);
        return res.json({ imageUrl, source: "gemini", simulated: false });
      }
    } catch (err) {
      console.warn("[IMAGE] Gemini failed:", err?.message || err);
    }
  }
  console.log("[IMAGE] All AI sources exhausted, using procedural SVG fallback");
  const fallback = generateProceduralFallbackImage(prompt, standardAspect);
  return res.json({ imageUrl: fallback, source: "svg-fallback", simulated: true });
});
app.get("/api/plugins", (req, res) => {
  res.json(symbioteState.pluginStates);
});
app.post("/api/plugins/toggle", (req, res) => {
  const { pluginId, enabled } = req.body;
  if (!pluginId || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "pluginId and enabled required" });
  }
  symbioteState.pluginStates[pluginId] = enabled;
  res.json({ success: true, pluginStates: symbioteState.pluginStates });
});
app.post("/api/plugins/register", (req, res) => {
  const { id, name, description, author, version, entryPoint } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: "id and name required" });
  }
  symbioteState.pluginStates[id] = true;
  console.log(`[PLUGIN] Registered: ${name} v${version || "1.0"} by ${author || "unknown"} \u2014 entry: ${entryPoint || "inline"}`);
  res.json({ success: true, pluginId: id, pluginStates: symbioteState.pluginStates });
});
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, messages: uiMessages } = req.body;
  const userMessage = message || (Array.isArray(uiMessages) && uiMessages.length > 0 ? uiMessages[uiMessages.length - 1]?.parts?.[0]?.text : "") || "";
  const sid = sessionId || `web-${Date.now()}`;
  try {
    const fetch = (await import("node-fetch")).default;
    const gatewayUrl = process.env.GATEWAY_URL || "http://127.0.0.1:3006";
    const MACH6_API_KEY = process.env.MACH6_API_KEY || "";
    const gatewayRes = await fetch(`${gatewayUrl}/api/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...MACH6_API_KEY ? { Authorization: `Bearer ${MACH6_API_KEY}` } : {}
      },
      body: JSON.stringify({ sessionId: sid, text: userMessage })
    });
    const data = await gatewayRes.json();
    return res.json({
      text: data.text || data.message || data.reply || "No response from gateway.",
      sessionId: sid
    });
  } catch (error) {
    console.error("Gateway proxy error:", error);
    return res.json({
      text: `**[GATEWAY UNAVAILABLE]**

Could not reach the mach6 gateway.
Error: ${error?.message || String(error)}`,
      sessionId: sid,
      simulated: true
    });
  }
});
async function initServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await (0, import_vite.createServer)({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
    console.log("Vite development server middleware loaded.");
  } else {
    const distPath = import_path.default.join(process.cwd(), "dist");
    app.use(import_express.default.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(import_path.default.join(distPath, "index.html"));
    });
    console.log("Serving static production assets from dist/.");
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Symbiote engine online. Running behind proxy at http://localhost:${PORT}`);
  });
}
initServer().catch((err) => {
  console.error("Critical error launching Symbiote server process:", err);
});
//# sourceMappingURL=server.cjs.map
