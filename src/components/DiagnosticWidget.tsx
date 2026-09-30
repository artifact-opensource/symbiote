import { useEffect, useState } from "react";
import { Activity, Gauge, Monitor, Server, Thermometer, Radio } from "lucide-react";
import { SymbioteTelemetry } from "../types";

interface DiagnosticWidgetProps {
  telemetry: SymbioteTelemetry;
  onRefresh: () => void;
  isScanning: boolean;
}

export default function DiagnosticWidget({ telemetry, onRefresh, isScanning }: DiagnosticWidgetProps) {
  // Local history array to draw an interactive floating neural graph
  const [history, setHistory] = useState<number[]>([98, 97.4, 98.1, 97.9, 98.4, 98.2, 98.5]);

  useEffect(() => {
    // Append the cohesion value to the plotting cache
    setHistory(prev => {
      const next = [...prev, telemetry.coreCohesion];
      if (next.length > 12) next.shift();
      return next;
    });
  }, [telemetry.coreCohesion]);

  // Construct SVG Polyline coordinates dynamically for our beautiful responsive chart
  const padding = 15;
  const width = 280;
  const height = 80;
  
  const minVal = 90;
  const maxVal = 100;
  const range = maxVal - minVal;

  const points = history.map((val, index) => {
    const x = padding + (index / (history.length - 1)) * (width - padding * 2);
    // invert Y coordinates so higher values plot higher up in the graph
    const normalized = (val - minVal) / range;
    const y = height - padding - normalized * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div id="plugin-system-monitor-card" className="w-full flex flex-col gap-4 p-4 bg-slate-950/40 border border-slate-900 rounded-3xl relative overflow-hidden group">
      {/* HUD Accent Glows */}
      <div className="absolute -top-12 -right-12 w-24 h-24 rounded-full bg-cyan-500/5 filter blur-2xl group-hover:bg-cyan-500/10 transition-all duration-700"></div>

      {/* Plugin Header */}
      <div className="flex items-center justify-between border-b border-slate-900/60 pb-2.5">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-cyan-400" />
          <h3 className="font-sans text-xs font-semibold tracking-wide text-slate-200">SYSTEM MONITORS</h3>
        </div>
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${isScanning ? "bg-purple-500 animate-ping" : "bg-cyan-500 animate-pulse"}`}></span>
          <span className="font-mono text-[9px] text-slate-500 tracking-wider font-medium">{isScanning ? "SCANNING" : "SYNCD"}</span>
        </div>
      </div>

      {/* Grid of Micro-meters — live data from /api/telemetry */}
      <div className="grid grid-cols-2 gap-3">
        {/* CPU Load */}
        <div className="flex items-center gap-3 p-2.5 bg-slate-900/30 border border-slate-900/80 rounded-xl">
          <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
            <Thermometer className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-[9px] text-slate-500">CPU LOAD</span>
            <span className="font-sans text-sm font-medium text-slate-200">
              {telemetry._raw ? `${telemetry._raw.cpu.load.percent}%` : `${telemetry.thermalLevel.toFixed(1)}%`}
            </span>
            {telemetry._raw && (
              <span className="font-mono text-[8px] text-slate-600">{telemetry._raw.cpu.cores} cores · {telemetry._raw.cpu.model.slice(0, 20)}</span>
            )}
          </div>
        </div>

        {/* RAM Usage */}
        <div className="flex items-center gap-3 p-2.5 bg-slate-900/30 border border-slate-900/80 rounded-xl">
          <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
            <Gauge className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-[9px] text-slate-500">MEMORY</span>
            <span className="font-sans text-sm font-medium text-slate-200">
              {telemetry._raw ? `${telemetry._raw.memory.percent}%` : `${(telemetry.neuralBandwidth / 20).toFixed(0)}%`}
            </span>
            {telemetry._raw && (
              <span className="font-mono text-[8px] text-slate-600">
                {(telemetry._raw.memory.used / 1073741824).toFixed(1)} / {(telemetry._raw.memory.total / 1073741824).toFixed(1)} GB
              </span>
            )}
          </div>
        </div>

        {/* System Uptime */}
        <div className="flex items-center gap-3 p-2.5 bg-slate-900/30 border border-slate-900/80 rounded-xl">
          <div className="p-2 rounded-lg bg-purple-500/10 text-purple-400">
            <Server className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-[9px] text-slate-500">UPTIME</span>
            <span className="font-sans text-sm font-medium text-slate-200">
              {telemetry._raw ? telemetry._raw.uptime.systemFormatted : "—"}
            </span>
          </div>
        </div>

        {/* Network / Nodes */}
        <div className="flex items-center gap-3 p-2.5 bg-slate-900/30 border border-slate-900/80 rounded-xl">
          <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-450">
            <Radio className="w-4 h-4 text-emerald-450" />
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-[9px] text-slate-500">NETWORK</span>
            <span className="font-sans text-sm font-medium text-slate-200">
              {telemetry._raw ? `${Object.keys(telemetry._raw.network).length} IFs` : `${telemetry.connectedSymbionts} ACTIVE`}
            </span>
            {telemetry._raw && telemetry._raw.env?.pid && (
              <span className="font-mono text-[8px] text-slate-600">PID {telemetry._raw.env.pid}</span>
            )}
          </div>
        </div>
      </div>

      {/* Reactive Visual Oscilloscope Chart */}
      <div className="flex flex-col gap-1.5 p-2 bg-slate-900/30 border border-slate-900/80 rounded-2xl">
        <div className="flex justify-between items-center px-1 font-mono text-[8px] text-slate-500 tracking-wider">
          <span className="flex items-center gap-1">
            <Activity className="w-2.5 h-2.5 text-cyan-500 animate-pulse" />
            SYNAPTIC CORE COHESION WAVE
          </span>
          <span>{telemetry.coreCohesion.toFixed(2)}%</span>
        </div>

        <div className="w-full h-20 bg-slate-950/80 border border-slate-950 rounded-lg overflow-hidden relative">
          {/* Neon background scanlines */}
          <div className="absolute inset-0 bg-radial-grid opacity-10"></div>
          
          {/* Floating diagnostic scanner ribbon */}
          {isScanning && (
            <div className="absolute top-0 bottom-0 w-12 bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent animate-slide-scan"></div>
          )}

          {/* SVG Sparkline Graph */}
          <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="overflow-visible">
            {/* Grid base indicators */}
            <line x1="0" y1="40" x2={width} y2="40" stroke="#1e293b" strokeWidth="0.5" strokeDasharray="3,3" />
            
            {/* Glow backing line */}
            <polyline 
              fill="none" 
              stroke="url(#sparkGlow)" 
              strokeWidth="5" 
              points={points} 
              className="opacity-40 filter blur-[2px]"
            />
            {/* Fine sharp text line */}
            <polyline 
              fill="none" 
              stroke="url(#sparkGrad)" 
              strokeWidth="1.5" 
              points={points} 
              className="drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]"
            />
            
            {/* Interactive End Dot glow */}
            {points.length > 0 && (
              <circle 
                cx={padding + ((history.length - 1) / (history.length - 1)) * (width - padding * 2)}
                cy={height - padding - ((history[history.length - 1] - minVal) / range) * (height - padding * 2)}
                r="3.5"
                fill="#ffffff"
                className="animate-ping"
              />
            )}

            {/* Gradients declaration */}
            <defs>
              <linearGradient id="sparkGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#818cf8" />
                <stop offset="50%" stopColor="#06b6d4" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
              <linearGradient id="sparkGlow" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#818cf8" />
                <stop offset="100%" stopColor="#06b6d4" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      {/* Sync trigger CTA */}
      <button
        onClick={onRefresh}
        id="trigger-diagnostic-refresh-btn"
        className="w-full py-1.5 bg-cyan-950/20 hover:bg-cyan-950/40 border border-cyan-800/20 hover:border-cyan-800/50 rounded-xl font-mono text-[10px] tracking-wider text-cyan-400 cursor-pointer active:scale-98 transition-all"
      >
        {isScanning ? "ANALYSING SYSMETRICS..." : "RUN FULL DIAGNOSTIC RUN"}
      </button>
    </div>
  );
}
