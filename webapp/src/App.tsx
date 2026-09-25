import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Send, Cpu, Radio, Shield, Globe, Terminal, Layers, 
  HelpCircle, Settings2, Sliders, ChevronRight, ChevronLeft, Search, 
  Sparkles, Camera, Zap, CheckCircle2, RotateCw, Plus, X, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen
} from "lucide-react";
import Markdown from "react-markdown";
import { Message, SymbiotePlugin, SymbioteTelemetry, ChatSession } from "./types";
import SemanticGraph from "./components/SemanticGraph";
import DiagnosticWidget from "./components/DiagnosticWidget";

// Default initial message block for new sessions
const defaultMessages: Message[] = [
  {
    id: "init-1",
    role: "assistant",
    parts: [{ text: "Welcome back, Operator. The Symbiote core kernel is fully synchronized with your local workstation environment. All active biometric pathways match. How shall we expand today?" }],
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    executedTool: null
  }
];

// Generates a concise one-line summary for each chat session dynamically
const getConciseSummary = (messages: Message[]): string => {
  const userMessages = messages.filter(
    m => m.role === "user" && 
    !m.parts[0]?.text.includes("PULSE_SIGNAL_RECEIVED") && 
    !m.parts[0]?.text.includes("selected semantic keyword")
  );
  if (userMessages.length === 0) {
    return "New Connection";
  }
  const latestText = userMessages[userMessages.length - 1].parts[0]?.text || "";
  // Strip markdown formatting & system command traces to keep it sleek and clean
  let clean = latestText.replace(/[#*`_]/g, "").trim();
  if (clean.length > 24) {
    return clean.slice(0, 22) + "...";
  }
  return clean || "Active Link";
};

export default function App() {
  // SESSION MANAGEMENT
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  // SIDEBAR & VIEW STATES
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [currentView, setCurrentView] = useState<"chat" | "theme" | "personality">("chat");

  // UI state attributes
  const [inputValue, setInputValue] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isRefreshingTelemetry, setIsRefreshingTelemetry] = useState(false);
  const [activeNotification, setActiveNotification] = useState<string | null>(null);

  // Configuration Sliders for Quantum logic plugins
  const [reasoningDepth, setReasoningDepth] = useState<number>(82);
  const [creativityOffset, setCreativityOffset] = useState<number>(45);

  // Sensory feedback variables (Bio-resonant pulse effect flash overlay)
  const [biowaveActive, setBiowaveActive] = useState(false);
  const [biowaveType, setBiowaveType] = useState<string>("pulse");

  // Semantic Archive search widget fields
  const [archiveSearchQuery, setArchiveSearchQuery] = useState("");
  const [archiveSearchResults, setArchiveSearchResults] = useState<string[]>([]);
  const [isSearchingArchives, setIsSearchingArchives] = useState(false);

  // Image Generation Projection states
  const [imagePrompt, setImagePrompt] = useState("");
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);

  // Telemetry status state initialized elegantly
  // Telemetry status state — starts with defaults, replaced by live data
  const [telemetry, setTelemetry] = useState<SymbioteTelemetry>({
    coreCohesion: 98.4,
    thermalLevel: 34.2,
    neuralBandwidth: 1240, // Mbps
    connectedSymbionts: 3,
    memoryEntropy: 0.12,
  });

  // Fetch real telemetry from the server every 3s
  useEffect(() => {
    let cancelled = false;
    const fetchTelemetry = async () => {
      try {
        const res = await fetch("/api/telemetry");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data) return;
        setTelemetry({
          coreCohesion: Math.min(100, Math.max(0, 100 - (data.cpu?.load?.percent || 0) * 0.8)),
          thermalLevel: Math.min(100, (data.cpu?.load?.percent || 0) * 0.9 + 20),
          neuralBandwidth: Math.round((data.memory?.percent || 0) * 20 + 800),
          connectedSymbionts: data.env?.pid ? 3 : 1,
          memoryEntropy: parseFloat(((data.memory?.percent || 100) / 1000).toFixed(3)),
          _raw: data,
        } as SymbioteTelemetry);
      } catch {
        // Silently keep defaults if endpoint unavailable
      }
    };
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // State management for modular plugins
  const [plugins, setPlugins] = useState<SymbiotePlugin[]>([
    { id: "system-monitor", name: "Telemetry_Monitor.sys", description: "Performs real-time diagnostic checks, tracking thermal index and bandwidth parameters.", icon: "Cpu", active: true, accent: "text-cyan-400" },
    { id: "sensory-feedback", name: "Bio_Sensory_Pulse.wav", description: "Injects physical light wave rhythms and visual pulses straight onto the operator layout.", icon: "Radio", active: true, accent: "text-[#FF3E00]" },
    { id: "neural-archives", name: "Semantic_Archives.db", description: "Maintains semantic indexes of previous growth compilations and ancient user files.", icon: "Layers", active: false, accent: "text-indigo-400" },
    { id: "vision-projection", name: "Neural_Visualizer.exe", description: "Enables server-side multi-dimensional image generation and graphic projections.", icon: "Camera", active: true, accent: "text-pink-400" },
    { id: "quantum-logic", name: "Quantum_Logic_Filer", description: "Adapts reasoning density ratios and creativity modifiers inside Gemini.", icon: "Sliders", active: true, accent: "text-amber-400" }
  ]);

  // Scroll anchor ref for aesthetic message snapping
  const chatEndRef = useRef<HTMLDivElement>(null);

  // LIFECYCLE: Load Sessions from LocalStorage
  useEffect(() => {
    const saved = localStorage.getItem("symbiote_sessions");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.length > 0) {
          setSessions(parsed);
          setActiveSessionId(parsed[0].id);
        } else {
          initDefaultSession();
        }
      } catch(e) {
        initDefaultSession();
      }
    } else {
      initDefaultSession();
    }
  }, []);

  // LIFECYCLE: Auto-save sessions changes to LocalStorage
  useEffect(() => {
    if (sessions.length > 0) {
      localStorage.setItem("symbiote_sessions", JSON.stringify(sessions));
    }
  }, [sessions]);

  const initDefaultSession = () => {
    const initSession: ChatSession = {
      id: `session-${Date.now()}`,
      name: "01",
      createdAt: Date.now(),
      messages: [...defaultMessages]
    };
    setSessions([initSession]);
    setActiveSessionId(initSession.id);
  };

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeMessages = activeSession ? activeSession.messages : [];

  const activeKeywords = React.useMemo(() => {
    if (!activeMessages || activeMessages.length === 0) return ["COGNITION", "DYNAMICS", "SYNAPSE", "RESONANCE"];
    const words = new Set<string>();
    const text = activeMessages.map(m => m.parts.map(p => p.text).join(" ")).join(" ").toLowerCase();
    
    const vocabulary = [
      "resonance", "telemetry", "biometric", "cohesion", "neural", 
      "quantum", "entropy", "matrix", "vector", "synthesis", 
      "projection", "archives", "feedback", "silicon", "pathway", 
      "consciousness", "cognition", "evolution", "calibration", "operator", 
      "symbiant", "kernel", "diagnostic", "buffer", "wave", "logic",
      "biomedical", "cybernetic", "frequency", "intelligence"
    ];
    
    vocabulary.forEach(vocab => {
      if (text.includes(vocab)) {
        words.add(vocab.toUpperCase());
      }
    });

    const matches = text.match(/\b[A-Za-z]{5,12}\b/g);
    if (matches) {
      matches.forEach(m => {
        const common = ["welcome", "operator", "how", "what", "where", "there", "about", "would", "shall", "today", "using", "state", "system"];
        if (m.length > 5 && !common.includes(m.toLowerCase()) && !vocabulary.includes(m.toLowerCase())) {
          words.add(m.toUpperCase());
        }
      });
    }

    const list = Array.from(words);
    return list.length > 0 ? list : ["COGNITION", "DYNAMICS", "SYNAPSE", "RESONANCE"];
  }, [activeMessages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages, isThinking, currentView]);

  // ADD NEW SESSION
  const handleAddSession = () => {
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      name: String(sessions.length + 1).padStart(2, '0'),
      createdAt: Date.now(),
      messages: [...defaultMessages]
    };
    setSessions(prev => [...prev, newSession]);
    setActiveSessionId(newSession.id);
    setCurrentView("chat");
    triggerSplashNotification("SPAWNED NEW NEURAL THREAD.");
  };

  // DELETE SESSION
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => {
      const updated = prev.filter(s => s.id !== id);
      if (updated.length === 0) {
        // If all deleted, create a new default one
        const initSession: ChatSession = {
          id: `session-${Date.now()}`,
          name: "01",
          createdAt: Date.now(),
          messages: [...defaultMessages]
        };
        setTimeout(() => setActiveSessionId(initSession.id), 0);
        return [initSession];
      }
      
      // Update names to remain sequential (01, 02, etc.)
      const sequential = updated.map((s, i) => ({
        ...s,
        name: String(i + 1).padStart(2, '0')
      }));

      // Find new active session if deleted one was active
      if (id === activeSessionId) {
        setTimeout(() => setActiveSessionId(sequential[sequential.length - 1].id), 0);
      }
      return sequential;
    });
    triggerSplashNotification("NEURAL THREAD SEVERED.");
  };

  // Automatically refresh server-side telemetry to synchronize state
  const handleResonateCore = async () => {
    setIsRefreshingTelemetry(true);
    triggerSplashNotification("Re-synchronizing symbiotic core resonance loops...");

    try {
      const response = await fetch("/api/health");
      await response.json();
      
      setTimeout(() => {
        setTelemetry({
          coreCohesion: 95 + Math.random() * 4.9,
          thermalLevel: 32.5 + Math.random() * 4.5,
          neuralBandwidth: 1150 + Math.floor(Math.random() * 250),
          connectedSymbionts: Math.floor(1 + Math.random() * 5),
          memoryEntropy: 0.08 + Math.random() * 0.1,
        });
        setIsRefreshingTelemetry(false);
      }, 900);
    } catch (err) {
      setTimeout(() => {
        setTelemetry(prev => ({
          ...prev,
          coreCohesion: 96 + Math.random() * 3.5,
          thermalLevel: 31 + Math.random() * 5,
        }));
        setIsRefreshingTelemetry(false);
      }, 800);
    }
  };

  const triggerSensoryFlash = (pattern: string = "pulse") => {
    setBiowaveType(pattern);
    setBiowaveActive(true);
    setTimeout(() => {
      setBiowaveActive(false);
    }, 2200);
  };

  const togglePlugin = (id: string) => {
    setPlugins(prev =>
      prev.map(p => {
        if (p.id === id) {
          const nextActive = !p.active;
          triggerSplashNotification(`${p.name} diagnostic module: ${nextActive ? "ENABLED" : "SUSPENDED"}`);
          return { ...p, active: nextActive };
        }
        return p;
      })
    );
  };

  const triggerSplashNotification = (msg: string) => {
    setActiveNotification(msg);
    setTimeout(() => {
      setActiveNotification(null);
    }, 4000);
  };

  const executeArchiveSearch = () => {
    if (!archiveSearchQuery.trim()) return;
    setIsSearchingArchives(true);

    const mockRecords = [
      "Record ID 901: Early bio-silicon growth experiments succeeded at room temperatures.",
      "Record ID 1042: Core Symbiote kernel compiled with 0 critical syntax leaks. Code integrity verified stable.",
      "Record ID 1184: Integration of functional sensory feedback module achieved. Pulse wave loops calibrate neural telemetry.",
      "Record ID 1290: Quantum logic matrices embedded to scale creative multipliers using dynamic weights.",
      "Record ID 1435: Projection vectors optimized.",
      "Record ID 1580: The Operator initiated system-wide resonance synchronization; neural alignment optimized at 98.4%."
    ];

    setTimeout(() => {
      const query = archiveSearchQuery.toLowerCase();
      const filtered = mockRecords.filter(r => r.toLowerCase().includes(query));
      setArchiveSearchResults(filtered.length > 0 ? filtered : ["No precise logs match. Try 'resonance', 'pulse', 'kernel', or 'framework'."]);
      setIsSearchingArchives(false);
    }, 600);
  };

  const handleGenerateProjection = async (customPrompt?: string) => {
    const promptToUse = customPrompt || imagePrompt;
    if (!promptToUse.trim()) {
      triggerSplashNotification("Enter an architectural prompt to invoke synthesis.");
      return;
    }

    if (!activeSessionId) return;

    setIsGeneratingImage(true);
    triggerSplashNotification(`Invoking Vision Projection: "${promptToUse.slice(0, 30)}..."`);

    try {
      const response = await fetch("/api/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptToUse,
          aspectRatio: "16:9"
        })
      });

      const data = await response.json();
      if (data.imageUrl) {
        const newMsg: Message = {
          id: `proj-${Date.now()}`,
          role: "assistant",
          parts: [{ text: `### Vision Projection Rendered\nI have projected your concept: *${promptToUse}* directly into our active telemetry buffer.` }],
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          imageUrl: data.imageUrl,
          executedTool: "triggerVisionProjection"
        };
        
        setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: [...s.messages, newMsg] } : s));
        triggerSplashNotification("Sensory vision projection synthesized successfully!");
      }
    } catch (err) {
      triggerSplashNotification("Projection engine experienced quota limits. Defaulting to pure textual buffer.");
    } finally {
      setIsGeneratingImage(false);
      setImagePrompt("");
    }
  };

  const handleSendChat = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const text = overrideText || inputValue;
    if (!text.trim()) return;
    if (!activeSessionId) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      parts: [{ text }],
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: [...s.messages, userMsg] } : s));
    setInputValue("");
    setIsThinking(true);

    const activeIds = plugins.filter(p => p.active).map(p => p.id);
    const messagesSoFar = activeSession ? [...activeSession.messages, userMsg] : [userMsg];

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messagesSoFar,
          activePlugins: activeIds
        })
      });

      const data = await response.json();
      let finalResponseText = data.text || "Understood. The matrix is stable.";

      let executedToolName = data.executedTool;
      let toolResultPayload = data.toolResult;

      if (executedToolName === "getSystemStatus" && toolResultPayload) {
        setTelemetry(t => ({
          ...t,
          coreCohesion: parseFloat(toolResultPayload.coreCohesion) || t.coreCohesion,
          thermalLevel: parseFloat(toolResultPayload.thermalLevel) || t.thermalLevel,
          neuralBandwidth: parseInt(toolResultPayload.neuralBandwidth) || t.neuralBandwidth,
        }));
        triggerSplashNotification("Gemini diagnostic tool accessed core matrix parameters!");
      }

      if (executedToolName === "triggerVisualBuffer" && toolResultPayload) {
        triggerSensoryFlash(toolResultPayload.pattern || "wave");
        triggerSplashNotification(`Biometric signal pulse triggered by core: ${toolResultPayload.pattern}`);
      }

      const botMsg: Message = {
        id: `bot-${Date.now()}`,
        role: "assistant",
        parts: [{ text: finalResponseText }],
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        executedTool: executedToolName,
        toolResult: toolResultPayload,
        isSimulated: data.simulated
      };

      setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: [...s.messages, botMsg] } : s));

    } catch (err: any) {
      console.error(err);
      const errorMsg: Message = {
        id: `bot-err-${Date.now()}`,
        role: "assistant",
        parts: [{ text: "### Connection Loss Detected\n*The neural bridge reported synchronization latency packet loss. Core simulator continues to process local command buffers.*" }],
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSimulated: true
      };
      setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: [...s.messages, errorMsg] } : s));
    } finally {
      setIsThinking(false);
    }
  };

  const executeCommandPreset = (cmd: string) => {
    if (cmd === "diagnostics") {
      handleResonateCore();
    } else if (cmd === "biometric-pulse") {
      triggerSensoryFlash("aurora");
      triggerSplashNotification("Biometric pulse wave dispatched. Synapses calibrating...");
      handleSendChat(undefined, "PULSE_SIGNAL_RECEIVED: Operators biometric pathways have spiked. Check up on the User immediately with high-tech empathy.");
    } else if (cmd === "archive-check") {
      setArchiveSearchQuery("resonance");
      triggerSplashNotification("Archival search mapped to query: 'resonance'");
    } else if (cmd === "project-nebula") {
      handleGenerateProjection("A glowing crimson bio mechanical symbiote network hub floating in deep dark space digital art");
    }
  };

  const handleKeywordSelect = (word: string) => {
    triggerSplashNotification(`Probing semantic relation token: ${word}`);
    handleSendChat(undefined, `Operator selected semantic keyword: "${word}". Map its relationship to our core network.`);
  };

  return (
    <div className="flex h-screen w-full bg-[#0F0F10] text-[#E0E0E0] overflow-hidden font-sans border border-[#333] relative">
      
      {/* 1. SENSORY IMMERSIVE WAVE BIO-FLASH OVERLAYS */}
      <AnimatePresence>
        {biowaveActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.45, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.2, ease: "easeOut" }}
            className={`absolute inset-0 pointer-events-none z-50 mix-blend-screen ${
              biowaveType === "aurora" ? "bg-gradient-to-tr from-[#FF3E00]/25 via-purple-600/20 to-[#FF3E00]/25" :
              biowaveType === "warning" ? "bg-amber-500/20" :
              "bg-gradient-to-r from-red-600/15 to-[#FF3E00]/20"
            }`}
          />
        )}
      </AnimatePresence>

      {/* LEFT SIDEBAR (Sessions) */}
      <aside className={`${leftSidebarOpen ? "w-64 px-3" : "w-16"} transition-all duration-300 border-r border-[#222] flex flex-col items-center py-6 bg-[#0A0A0A] relative z-20 overflow-y-auto overflow-x-hidden`}>
        <button 
          onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
          className="absolute top-4 right-2 text-[#444] hover:text-[#FF3E00] transition-colors bg-transparent border-none outline-none cursor-pointer p-1"
        >
          {leftSidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>

        {leftSidebarOpen ? (
          <span className="text-[9px] uppercase tracking-widest text-[#666] font-mono mt-8 mb-6 delay-150 transition-opacity self-start pl-3 font-semibold">
            NEURAL ENGINES
          </span>
        ) : (
          <div className="h-10"></div>
        )}
        
        <div className="flex flex-col gap-3 w-full mt-2">
          {sessions.map((sess) => {
            const isActive = activeSessionId === sess.id && currentView === "chat";
            const summary = getConciseSummary(sess.messages);
            return (
              <div 
                key={sess.id} 
                className={`relative group w-full flex items-center gap-3 p-1.5 rounded transition-all duration-200 ${
                  isActive 
                    ? "bg-[#141416] border border-[#FF3E00]/30 shadow-[0_0_10px_rgba(255,62,0,0.05)]" 
                    : "border border-transparent hover:bg-[#111] hover:border-[#222]"
                }`}
              >
                <button 
                  onClick={() => {
                    setActiveSessionId(sess.id);
                    setCurrentView("chat");
                  }}
                  className={`flex-shrink-0 w-9 h-9 rounded-full border flex items-center justify-center text-xs font-mono cursor-pointer transition-all ${
                    isActive 
                      ? "border-[#FF3E00] text-[#FF3E00] bg-[#FF3E00]/5" 
                      : "border-[#444] text-[#666] group-hover:border-[#888] group-hover:text-white"
                  }`}
                  title={`Thread: ${sess.name} - ${summary}`}
                >
                  {sess.name}
                </button>
                
                {leftSidebarOpen && (
                  <div 
                    onClick={() => {
                      setActiveSessionId(sess.id);
                      setCurrentView("chat");
                    }}
                    className="flex-1 min-w-0 flex flex-col justify-center cursor-pointer select-none text-left"
                  >
                    <span className={`text-[10px] font-mono tracking-wider uppercase truncate ${isActive ? "text-[#FF3E00] font-semibold" : "text-slate-400 group-hover:text-white"}`}>
                      TH-{sess.name}
                    </span>
                    <span className="text-[10px] text-slate-500 font-light truncate leading-none mt-0.5 group-hover:text-slate-400">
                      {summary}
                    </span>
                  </div>
                )}

                {/* Delete button: always show on hover if expanded/collapsed or there are multiple threads */}
                {sessions.length > 1 && (
                  <button 
                    onClick={(e) => handleDeleteSession(sess.id, e)}
                    className={`absolute ${
                      leftSidebarOpen 
                        ? "right-2 top-1/2 -translate-y-1/2" 
                        : "top-0 right-0"
                    } bg-[#151515] text-[#666] hover:text-[#FF3E00] border border-[#222] hover:border-[#FF3E00] rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-pointer`}
                    title="Sever Thread"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
          
          <button 
            onClick={handleAddSession}
            className={`mt-1 flex items-center justify-center border border-dashed border-[#444] hover:border-[#FF3E00] text-[#666] hover:text-[#FF3E00] transition-all cursor-pointer rounded ${
              leftSidebarOpen 
                ? "w-full py-2 px-3 gap-2 text-xs font-mono" 
                : "w-9 h-9 mx-auto rounded-full"
            }`}
            title="Initialize New Thread"
          >
            <Plus className="w-4 h-4 shrink-0" />
            {leftSidebarOpen && <span className="font-mono text-[9px] tracking-widest uppercase">New Connection</span>}
          </button>
        </div>

        <div className="flex-1"></div>
        
        <div className={`flex flex-col gap-4 mt-6 items-center w-full ${leftSidebarOpen ? "px-2" : ""}`}>
          <div className="w-8 h-px bg-[#222] my-2"></div>
          
          <button 
            onClick={() => setCurrentView("theme")}
            className={`rounded border transition-all cursor-pointer ${
              leftSidebarOpen 
                ? "w-full px-3 py-2 flex items-center gap-2.5 text-xs text-left" 
                : "p-2 items-center justify-center"
            } ${currentView === "theme" ? "border-[#FF3E00] text-[#FF3E00] bg-[#FF3E00]/5" : "border-transparent text-[#666] hover:text-white hover:border-[#444]"}`}
            title="Aesthetic Theme Builder"
          >
            <Sparkles className="w-4 h-4 shrink-0" />
            {leftSidebarOpen && <span className="font-mono text-[9px] tracking-widest uppercase">Aesthetics</span>}
          </button>

          <button 
            onClick={() => setCurrentView("personality")}
            className={`rounded border transition-all cursor-pointer ${
              leftSidebarOpen 
                ? "w-full px-3 py-2 flex items-center gap-2.5 text-xs text-left" 
                : "p-2 items-center justify-center"
            } ${currentView === "personality" ? "border-[#FF3E00] text-[#FF3E00] bg-[#FF3E00]/5" : "border-transparent text-[#666] hover:text-white hover:border-[#444]"}`}
            title="Personality Core Matrix"
          >
            <Cpu className="w-4 h-4 shrink-0" />
            {leftSidebarOpen && <span className="font-mono text-[9px] tracking-widest uppercase">Personality</span>}
          </button>
        </div>
      </aside>

      {/* 2. MAIN LAYOUT FLEX COLUMN */}
      <div className="flex flex-col h-full w-full overflow-hidden relative">
        
        {/* HEADER BLOCK (Editorial Aesthetic) */}
        <header className="flex justify-between items-end p-8 border-b border-[#222]">
          <div className="flex flex-col">
            <span className="text-[10px] tracking-[0.3em] text-[#666] uppercase mb-1 font-semibold">SYSTEM IDENTITY</span>
            <div className="flex items-center gap-2">
              <h1 className="text-5xl font-light tracking-tighter text-white">
                SYMBIANT
              </h1>
            </div>
          </div>
          
          <div className="flex gap-12 text-[11px] tracking-widest uppercase text-[#888]">
            <div className="flex flex-col items-end">
              <span className="text-white">v1.2.0 - SECURE</span>
              <span className="text-slate-500 font-mono">LATENCY: 14ms</span>
            </div>
            
            <div className="flex flex-col items-end">
              <span className="text-white">PLUGINS ACTIVE</span>
              <span className="text-slate-500 font-mono">({plugins.filter(p => p.active).length} / {plugins.length} LOADED)</span>
            </div>

            {/* Toggle right sidebar button attached to header flex block */}
            <button 
              onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
              className="text-[#555] hover:text-[#FF3E00] transition-colors ml-4 cursor-pointer"
            >
              {rightSidebarOpen ? <PanelRightClose className="w-5 h-5" /> : <PanelRightOpen className="w-5 h-5" />}
            </button>
          </div>
        </header>

        {/* MAIN BODY AREA CONTAINER */}
        <main className="flex-1 flex overflow-hidden">
          
          {/* ACTIVE CONTENT WORKSPACE */}
          <div className="flex-1 flex overflow-hidden">
            
            {/* TOAST SYSTEM HEALTH NOTIFICATION POPUP */}
            <AnimatePresence>
              {activeNotification && (
                <motion.div
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute top-6 left-1/2 transform -translate-x-1/2 z-40 bg-[#151515] text-[#E0E0E0] border border-[#FF3E00]/50 px-6 py-2.5 rounded-sm shadow-2xl flex items-center gap-3 text-xs tracking-wider uppercase"
                >
                  <span className="w-2 h-2 rounded-full bg-[#FF3E00] animate-pulse"></span>
                  <span className="font-mono">{activeNotification}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* TAB CONTENT RENDERING */}
            {currentView === "chat" && (
              <section className="flex-1 flex flex-col relative px-8 lg:px-12 py-8 overflow-y-auto w-full">
                <div className="flex-1 flex flex-col justify-end space-y-10 max-w-4xl mx-auto w-full mb-6">
                
                {/* Scrollable list spacer */}
                <div className="flex-1 overflow-y-auto space-y-10 pr-2 pb-4">
                  {activeMessages.map((msg) => (
                    <div key={msg.id} className="flex flex-col items-start relative w-full group">
                      
                      {msg.role === "user" ? (
                        <div className="flex flex-col items-start w-full">
                          <span className="text-[9px] uppercase tracking-widest text-[#666] mb-2 font-mono">
                            PROMPT / {msg.timestamp}
                          </span>
                          <p className="text-[17px] font-light leading-relaxed border-l border-[#333] pl-6 text-[#ccc]">
                            {msg.parts[0]?.text}
                          </p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-start relative w-full pl-6">
                          {/* Editorial beautiful quotes styling */}
                          <div className="absolute -left-6 top-3 text-[#FF3E00] text-4xl italic font-serif pointer-events-none select-none">
                            “
                          </div>
                          
                          <div className="flex items-center gap-2 mb-2 font-mono text-[9px] uppercase tracking-widest text-[#FF3E00] font-semibold">
                            <span>SYMBIOTE / {msg.timestamp}</span>
                            {msg.executedTool && (
                              <span className="bg-[#FF3E00]/10 border border-[#FF3E00]/20 px-1.5 py-0.2 rounded text-[7.5px] scale-90">
                                {msg.executedTool.toUpperCase()}
                              </span>
                            )}
                          </div>

                          <div className="text-[15px] font-sans leading-relaxed text-[#eee] pr-12 w-full">
                            <div className="markdown-body prose prose-invert max-w-none text-slate-300 font-light prose-headings:text-white prose-strong:text-white prose-strong:font-semibold prose-code:text-[#FF3E00] prose-code:bg-[#151515] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:text-xs">
                              <Markdown
                                components={{
                                  code({ node, inline, className, children, ...props }: any) {
                                    const match = /language-(\w+)/.exec(className || '');
                                    return !inline ? (
                                      <div className="relative my-4 overflow-hidden rounded border border-[#222] bg-[#0A0A0B] font-mono text-xs">
                                        <div className="flex items-center justify-between bg-[#111] px-4 py-1.5 text-[10px] text-slate-500 border-b border-[#222]">
                                          <span className="uppercase tracking-widest">{match ? match[1] : "code"}</span>
                                          <span className="text-[8px] uppercase tracking-wider text-[#FF3E00]">active buffer</span>
                                        </div>
                                        <pre className="p-4 overflow-x-auto text-slate-300 leading-relaxed font-mono select-text">
                                          <code className={className} {...props}>
                                            {children}
                                          </code>
                                        </pre>
                                      </div>
                                    ) : (
                                      <code className="bg-[#18181A] text-[#FF3E00] px-1.5 py-0.5 rounded font-mono text-xs border border-[#2c2c2f]" {...props}>
                                        {children}
                                      </code>
                                    );
                                  },
                                  h1: ({ children }: any) => <h1 className="text-xl font-light tracking-tight text-white mb-3 mt-5 uppercase border-b border-[#222] pb-1 font-serif italic">{children}</h1>,
                                  h2: ({ children }: any) => <h2 className="text-lg font-light tracking-tight text-white mb-2.5 mt-4 uppercase border-b border-[#222] pb-0.5 font-sans">{children}</h2>,
                                  h3: ({ children }: any) => <h3 className="text-md font-medium tracking-tight text-white mb-2 mt-3 font-sans">{children}</h3>,
                                  p: ({ children }: any) => {
                                    // If we are at the very beginning list or dynamic output, let's allow it to feel highly editorial
                                    return <p className="mb-3.5 leading-relaxed text-slate-300">{children}</p>;
                                  },
                                  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-4 space-y-1.5 text-slate-300">{children}</ul>,
                                  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-4 space-y-1.5 text-slate-300">{children}</ol>,
                                  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
                                  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-[#FF3E00] pl-4 italic text-slate-400 my-4 bg-[#FF3E00]/5 py-2 pr-2">{children}</blockquote>,
                                  strong: ({ children }: any) => <strong className="font-semibold text-white">{children}</strong>,
                                  a: ({ href, children }: any) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#FF3E00] hover:underline decoration-[#FF3E00]/50">{children}</a>
                                }}
                              >
                                {msg.parts[0]?.text}
                              </Markdown>
                            </div>
                          </div>

                          {/* Dynamic image projections inline */}
                          {msg.imageUrl && (
                            <motion.div 
                              initial={{ opacity: 0, scale: 0.98 }}
                              animate={{ opacity: 1, scale: 1 }}
                              className="mt-4 max-w-xl w-full border border-[#333] p-1.5 bg-[#0A0A0A] rounded-sm shadow-2xl relative group/img overflow-hidden"
                            >
                              <img 
                                src={msg.imageUrl} 
                                alt="Symbiote Neural Projection" 
                                className="w-full h-auto aspect-video object-cover brightness-95 group-hover/img:brightness-100 transition-all duration-500 rounded-sm"
                              />
                              <div className="absolute top-4 right-4 bg-black/80 px-2.5 py-1 text-[8.5px] font-mono tracking-widest text-[#FF3E00] uppercase border border-[#FF3E00]/30 rounded-sm">
                                active matrix
                              </div>
                            </motion.div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Thinking organic dot */}
                  {isThinking && (
                    <div className="flex items-center gap-2 pl-6 font-mono text-[9px] text-[#FF3E00] tracking-widest uppercase animate-pulse">
                      <span className="w-1.5 h-1.5 bg-[#FF3E00] rounded-full animate-ping"></span>
                      <span>Symbiote thinking... channeling logic matrix</span>
                    </div>
                  )}

                  <div ref={chatEndRef}></div>
                </div>

                {/* EDITORIAL FAST PRESET BUTTONS RAIL */}
                <div className="border-t border-[#222]/80 pt-4 flex flex-wrap gap-3">
                  <span className="text-[8.5px] uppercase tracking-wider text-slate-500 font-mono mr-1 flex items-center justify-center">
                    QUICK CMD FLAGS:
                  </span>
                  <button 
                    onClick={() => executeCommandPreset("diagnostics")}
                    className="px-3 py-1 rounded-sm border border-[#222] text-[9.5px] uppercase tracking-wider text-slate-400 hover:text-white hover:border-[#FF3E00]/50 transition-all bg-[#0A0A0A]/40 cursor-pointer"
                  >
                    Resonate Core
                  </button>
                  <button 
                    onClick={() => executeCommandPreset("biometric-pulse")}
                    className="px-3 py-1 rounded-sm border border-[#222] text-[9.5px] uppercase tracking-wider text-slate-400 hover:text-white hover:border-[#FF3E00]/50 transition-all bg-[#0A0A0A]/40 cursor-pointer"
                  >
                    Biometric Pulse
                  </button>
                  {plugins.find(p => p.id === "vision-projection")?.active && (
                    <button 
                      onClick={() => executeCommandPreset("project-nebula")}
                      className="px-3 py-1 rounded-sm border border-[#222] text-[9.5px] uppercase tracking-wider text-[#FF3E00] hover:text-white hover:border-[#FF3E00] transition-all bg-[#FF3E00]/5 cursor-pointer"
                    >
                      Project Neural Art
                    </button>
                  )}
                  {plugins.find(p => p.id === "neural-archives")?.active && (
                    <button 
                      onClick={() => executeCommandPreset("archive-check")}
                      className="px-3 py-1 rounded-sm border border-[#222] text-[9.5px] uppercase tracking-wider text-slate-400 hover:text-white hover:border-[#FF3E00]/50 transition-all bg-[#0A0A0A]/40 cursor-pointer"
                    >
                      Query Archives
                    </button>
                  )}
                </div>

              </div>
            </section>
            )}

            {currentView === "theme" && (
              <section className="flex-1 flex flex-col relative px-12 py-10 overflow-y-auto w-full">
                <div className="max-w-3xl mx-auto w-full space-y-8 mt-8">
                  <div className="border-b border-[#222] pb-6">
                    <h2 className="text-4xl font-light tracking-tighter text-white uppercase">Aesthetic <span className="text-[#FF3E00] italic font-serif">Builder</span></h2>
                    <p className="text-[11px] uppercase tracking-widest text-slate-500 mt-3">Customize core layouts, kinetic typography, and bio-luminescent visual motifs.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-8">
                    <div className="flex flex-col gap-4 border border-[#222] p-6 bg-[#0E0E10]/20 rounded-sm hover:border-[#FF3E00]/50 transition-colors cursor-pointer group">
                      <div className="w-8 h-8 rounded-full bg-cyan-500/20 flex items-center justify-center"><div className="w-4 h-4 rounded-full bg-cyan-500 group-hover:scale-110 transition-transform"></div></div>
                      <h3 className="text-sm uppercase tracking-widest font-bold">Neon Matrix</h3>
                      <p className="text-xs text-slate-500 leading-relaxed font-mono">A cool, cybernetic blue framework maximizing technical analytical states.</p>
                    </div>
                    <div className="flex flex-col gap-4 border border-[#FF3E00] p-6 bg-[#FF3E00]/5 rounded-sm relative overflow-hidden">
                      <div className="absolute top-0 right-0 bg-[#FF3E00] text-black text-[9px] uppercase font-bold tracking-widest px-2 py-1">Active</div>
                      <div className="w-8 h-8 rounded-full bg-[#FF3E00]/20 flex items-center justify-center"><div className="w-4 h-4 rounded-full bg-[#FF3E00]"></div></div>
                      <h3 className="text-sm uppercase tracking-widest font-bold text-white">Editorial Cosmic</h3>
                      <p className="text-xs text-slate-400 leading-relaxed font-mono">High-contrast sleek minimalist warmth. Ideal for deeply philosophical alignment.</p>
                    </div>
                  </div>
                  <div className="pt-4">
                    <button className="px-6 py-3 border border-[#333] hover:border-white text-xs uppercase tracking-widest font-mono text-slate-300 hover:text-white transition-all w-full text-left flex justify-between items-center cursor-pointer">
                      <span>Upload Custom Theme .symtheme</span>
                      <span>+</span>
                    </button>
                  </div>
                </div>
              </section>
            )}

            {currentView === "personality" && (
              <section className="flex-1 flex flex-col relative px-12 py-10 overflow-y-auto w-full">
                <div className="max-w-3xl mx-auto w-full space-y-8 mt-8">
                  <div className="border-b border-[#222] pb-6">
                    <h2 className="text-4xl font-light tracking-tighter text-white uppercase">Personality <span className="text-[#FF3E00] italic font-serif">Core</span></h2>
                    <p className="text-[11px] uppercase tracking-widest text-slate-500 mt-3">Dynamic psychological shifting engine and milestone memory buffer.</p>
                  </div>
                  <div className="space-y-6 max-w-xl">
                    <div className="flex flex-col space-y-4">
                      <div className="flex justify-between items-center text-[10px] font-mono tracking-widest uppercase">
                        <span className="text-slate-400">Formality Index</span>
                        <span className="text-[#FF3E00]">60%</span>
                      </div>
                      <div className="h-1 bg-[#222] w-full relative"><div className="absolute top-0 left-0 h-1 bg-[#FF3E00] w-[60%]"></div></div>
                    </div>
                    <div className="flex flex-col space-y-4">
                      <div className="flex justify-between items-center text-[10px] font-mono tracking-widest uppercase">
                        <span className="text-slate-400">Empathic Resonance</span>
                        <span className="text-emerald-500">85%</span>
                      </div>
                      <div className="h-1 bg-[#222] w-full relative"><div className="absolute top-0 left-0 h-1 bg-emerald-500 w-[85%]"></div></div>
                    </div>
                  </div>
                  <div className="mt-12 bg-[#151515] border border-[#222] p-6">
                    <h4 className="text-xs uppercase tracking-widest text-slate-400 mb-4 font-mono border-b border-[#222] pb-2">Interaction Milestones</h4>
                    <ul className="space-y-3 font-mono text-[10px] text-slate-500 leading-relaxed">
                      <li><span className="text-[#FF3E00]">[14:32]</span> Operator rejected analytical structure; shifting to poetic warmth.</li>
                      <li><span className="text-[#FF3E00]">[12:15]</span> Philosophical query depth noted. Increased creativity offset.</li>
                      <li><span className="text-[#FF3E00]">[09:00]</span> Initial Boot Sequence. Baseline Archetype Selected: "Nurturing / Poetic".</li>
                    </ul>
                  </div>
                  <div className="pt-6">
                    <button className="px-6 py-2 border border-red-500/30 text-red-500/80 hover:bg-red-500 hover:text-white text-[10px] uppercase tracking-widest font-bold transition-all w-full cursor-pointer">
                      Purge Core Alignment & Reset
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* WORKSPACE COLUMN 2: EDITORIAL CONTROL SIDEBAR (Right) */}
            <aside className={`transition-all duration-500 ease-in-out bg-[#0A0A0A] border-l border-[#222] overflow-y-auto flex flex-col ${rightSidebarOpen ? "w-80 min-w-[20rem] p-8 space-y-8" : "w-0 p-0 overflow-hidden"}`}>
              {rightSidebarOpen && (
                <>
                  {/* Semantic Keywords Graph */}
                  <div className="flex flex-col space-y-1 mt-2">
                    <SemanticGraph 
                      keywords={activeKeywords}
                      onKeywordClick={handleKeywordSelect}
                    />
                  </div>

                  {/* Advanced Sliders (Quantum Logic plugins) */}
                  <div className="space-y-6 pt-3 border-t border-[#222]/60">
                    <h3 className="text-[11px] uppercase tracking-[0.2em] text-[#666] font-semibold">MODULE CONFIGURATIONS</h3>
                    
                    <div className="flex flex-col space-y-3">
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-white">Reasoning Depth</span>
                        <span className="text-[#FF3E00]">{reasoningDepth}%</span>
                      </div>
                      <div className="relative pt-1">
                        <input 
                          type="range" 
                          min="10" 
                          max="100" 
                          value={reasoningDepth}
                          onChange={(e) => setReasoningDepth(parseInt(e.target.value))}
                          className="w-full h-1 bg-[#222] rounded-lg appearance-none cursor-pointer accent-[#FF3E00]"
                        />
                        <div className="h-px bg-[#222] w-full mt-1"></div>
                      </div>
                    </div>

                    <div className="flex flex-col space-y-3">
                      <div className="flex justify-between text-xs font-mono">
                        <span className="text-white">Creativity Offset</span>
                        <span className="text-[#FF3E00]">{creativityOffset}%</span>
                      </div>
                      <div className="relative pt-1">
                        <input 
                          type="range" 
                          min="0" 
                          max="100" 
                          value={creativityOffset}
                          onChange={(e) => setCreativityOffset(parseInt(e.target.value))}
                          className="w-full h-1 bg-[#222] rounded-lg appearance-none cursor-pointer accent-[#FF3E00]"
                        />
                        <div className="h-px bg-[#222] w-full mt-1"></div>
                      </div>
                    </div>
                  </div>

                  {/* Extensible Plugins Checklist */}
                  <div className="space-y-4 pt-3 border-t border-[#222]/60">
                    <div className="flex justify-between items-center">
                      <h4 className="text-[11px] uppercase tracking-[0.2em] text-[#666] font-semibold">ACTIVE PLUGINS</h4>
                      <span className="font-mono text-[8px] tracking-wider text-slate-500">TOGGLE SLOTS</span>
                    </div>

                    <ul className="space-y-3">
                      {plugins.map((plugin) => (
                        <li 
                          key={plugin.id} 
                          onClick={() => togglePlugin(plugin.id)}
                          className="flex flex-col p-2.5 rounded-sm border border-[#222] bg-[#0E0E10]/20 hover:bg-[#151515]/40 hover:border-[#FF3E00]/30 transition-all cursor-pointer group"
                        >
                          <div className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full ${plugin.active ? "bg-[#FF3E00]" : "bg-[#444]"} transition-colors duration-300`}></span>
                              <span className={`${plugin.active ? "text-white" : "text-[#666]"} font-mono text-[11px] font-medium`}>
                                {plugin.name}
                              </span>
                            </div>
                            <span className="text-[#444] group-hover:text-white transition-colors">→</span>
                          </div>
                          <p className="text-[9.5px] text-slate-500 mt-1 font-sans leading-snug">
                            {plugin.description}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Sub-Widget: Diagnostics Telemetry Display */}
                  {plugins.find(p => p.id === "system-monitor")?.active && (
                    <div className="pt-2 border-t border-[#222]/60">
                      <DiagnosticWidget 
                        telemetry={telemetry}
                        onRefresh={handleResonateCore}
                        isScanning={isRefreshingTelemetry}
                      />
                    </div>
                  )}

                  {/* Sub-Widget: Search Archival Index */}
                  {plugins.find(p => p.id === "neural-archives")?.active && (
                    <div className="p-3.5 bg-[#0F0F10] border border-[#222] rounded-lg flex flex-col gap-2">
                      <div className="flex items-center gap-1.5 text-[#FF3E00]">
                        <Search className="w-3.5 h-3.5" />
                        <span className="font-mono text-[10px] uppercase font-bold tracking-wider">ARCHIVAL SECTOR</span>
                      </div>
                      <div className="flex gap-1">
                        <input 
                          type="text"
                          value={archiveSearchQuery}
                          onChange={(e) => setArchiveSearchQuery(e.target.value)}
                          placeholder="Topic search query..."
                          className="w-full bg-[#151515] text-[#E0E0E0] text-xs font-mono px-2 py-1 outline-none border border-[#333] focus:border-[#FF3E00] rounded-sm placeholder-[#444]"
                        />
                        <button 
                          onClick={executeArchiveSearch}
                          className="p-1 px-2.5 bg-[#FF3E00] text-black hover:bg-[#FF3E00]/80 rounded-sm font-bold text-xs"
                        >
                          Find
                        </button>
                      </div>
                      {archiveSearchResults.length > 0 && (
                        <div className="mt-1.5 border-t border-[#222]/80 pt-1.5 max-h-32 overflow-y-auto space-y-1.5">
                          {archiveSearchResults.map((res, i) => (
                            <p key={i} className="font-mono text-[9px] text-[#ccc] leading-normal bg-[#000]/30 p-1.5 border-l border-[#FF3E00] rounded-sm">
                              {res}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sub-Widget: Vision Manual Synthesizer Form */}
                  {plugins.find(p => p.id === "vision-projection")?.active && (
                    <div className="p-3.5 bg-[#0F0F10] border border-[#222] rounded-lg flex flex-col gap-2">
                      <div className="flex items-center justify-between text-xs text-pink-400 font-mono">
                        <div className="flex items-center gap-1.5">
                          <Camera className="w-3.5 h-3.5" />
                          <span className="uppercase font-bold tracking-wider">PROJECTION STUDIO</span>
                        </div>
                      </div>
                      <div className="relative">
                        <textarea
                          value={imagePrompt}
                          onChange={(e) => setImagePrompt(e.target.value)}
                          placeholder="Describe abstract vectors..."
                          className="w-full bg-[#151515] text-[#E0E0E0] text-xs font-mono p-2 py-1.5 outline-none border border-[#333] focus:border-[#FF3E00] rounded-sm placeholder-[#444] resize-none h-14"
                        />
                      </div>
                      <button 
                        onClick={() => handleGenerateProjection()}
                        disabled={isGeneratingImage}
                        className="w-full py-1.5 bg-white hover:bg-[#E0E0E0] text-black font-mono text-[9.5px] uppercase tracking-widest font-bold cursor-pointer rounded-sm disabled:opacity-50 flex items-center justify-center gap-1.5"
                      >
                        {isGeneratingImage ? "GENERATING PROJECTILE..." : "CHANNELS PROJECTION"}
                      </button>
                    </div>
                  )}

                  {/* Custom modular extension CTA — opens a new chat session to design + build the plugin */}
                  <div className="pt-2">
                    <button 
                      onClick={() => {
                        // Switch to chat view and pre-fill a plugin design session
                        setCurrentView("chat");
                        // Create a new session for this plugin discussion
                        const pluginSessionId = `plugin-design-${Date.now()}`;
                        setActiveSessionId(pluginSessionId);
                        const welcomeMessage: Message = {
                          id: `msg-${Date.now()}`,
                          role: "assistant",
                          parts: [{ text: "🔌 **Plugin Design Session**\n\nYou're about to build a new plugin for the Symbiote dashboard.\n\nTell me:\n1. **What should the plugin do?** (e.g., \"monitor GPU temp\", \"show live trading data\", \"display a neural network graph\")\n2. **What data source?** (system API, external API, computed from telemetry)\n3. **How should it look?** (chart, meter, text feed, toggle, etc.)\n\nI'll design the Python script, register it, and wire it into the dashboard. What are we building?" }],
                          timestamp: new Date().toISOString(),
                        };
                        setSessions(prev => ({
                          ...prev,
                          [pluginSessionId]: {
                            id: pluginSessionId,
                            title: "Plugin Design",
                            messages: [welcomeMessage],
                            createdAt: new Date().toISOString(),
                          }
                        }));
                        setActiveMessages([welcomeMessage]);
                        triggerSplashNotification("Plugin design session started — describe what you want to build!");
                      }}
                      className="w-full py-3 bg-white hover:bg-[#E0E0E0] text-black text-center text-[10px] uppercase tracking-widest font-mono font-bold cursor-pointer transition-all active:scale-98 rounded-sm"
                    >
                      Install New Module
                    </button>
                  </div>
                </>
              )}
            </aside>
          </div>
            
        </main>

        {/* INPUT FORM FOOTER BAR (Editorial Aesthetic) */}
        {currentView === "chat" && (
          <footer className="h-24 bg-[#0A0A0A] border-t border-[#222] flex items-center px-8 z-20">
            <form onSubmit={handleSendChat} id="chat-input-form" className="flex-1 flex items-center bg-[#151515] rounded-sm px-6 h-12 border border-[#222] hover:border-[#333] transition-colors relative z-10">
              <span className="text-[#444] mr-4 text-xs font-mono font-bold">/cmd</span>
              <input 
                type="text" 
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Enter your command to Symbiote..."
                className="bg-transparent border-none outline-none text-sm w-full placeholder-[#444] text-white tracking-wide z-10"
              />
              
              <div className="flex gap-4 ml-auto items-center select-none shrink-0 pl-4 border-l border-[#222] z-10">
                <div className="w-3 h-3 border border-[#444] rounded-sm bg-[#FF3E00]/20 flex items-center justify-center">
                  <div className="w-1 h-1 bg-[#FF3E00] rounded-sm animate-pulse"></div>
                </div>
                <span className="text-[10px] text-[#444] uppercase tracking-widest font-mono font-semibold hidden md:inline">
                  SECURE LINK ACTIVE
                </span>
              </div>
            </form>

            <div className="ml-8 flex gap-6 select-none shrink-0 z-10">
              <button 
                onClick={(e) => handleSendChat(e)}
                type="button"
                className="text-[12px] uppercase tracking-[0.2em] text-[#FF3E00] font-bold cursor-pointer hover:opacity-80 active:scale-95 transition-all w-[100px] text-right"
              >
                Execute
              </button>
            </div>
          </footer>
        )}

      </div>
    </div>
  );
}
