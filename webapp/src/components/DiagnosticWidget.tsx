import React from 'react';
import { Activity, Gauge, Server, Thermometer, Radio, RotateCw, Zap } from 'lucide-react';
import { SymbioteTelemetry } from '../types';

interface DiagnosticWidgetProps {
  telemetry: SymbioteTelemetry;
  onRefresh: () => void;
  isScanning: boolean;
  tokenHistory?: number[];
  tokenSpeed?: number;
  totalTokens?: number;
}

export default function DiagnosticWidget({
  telemetry,
  onRefresh,
  isScanning,
  tokenHistory = [12, 24, 38, 45, 52, 48, 62, 55, 70],
  tokenSpeed = 0,
  totalTokens = 0,
}: DiagnosticWidgetProps) {
  const padding = 10;
  const width = 280;
  const height = 60;

  const validHistory = tokenHistory.length > 1 ? tokenHistory : [0, tokenSpeed || 10];
  const maxVal = Math.max(75, ...validHistory);
  const minVal = 0;
  const range = maxVal - minVal || 1;

  const points = validHistory
    .map((val, index) => {
      const x = padding + (index / Math.max(1, validHistory.length - 1)) * (width - padding * 2);
      const normalized = Math.min(1, Math.max(0, (val - minVal) / range));
      const y = height - padding - normalized * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(' ');

  const raw = telemetry._raw;
  const cpuPercent = raw ? raw.cpu?.load?.percent : Math.round(telemetry.thermalLevel);
  const memPercent = raw ? raw.memory?.percent : Math.round(telemetry.memoryEntropy * 100);
  const uptimeStr = raw ? raw.uptime?.systemFormatted : 'Online';
  const nodeVer = raw?.env?.nodeVersion || 'v22';
  const pid = raw?.env?.pid || process?.pid || 'host';

  return (
    <div className="w-full flex flex-col gap-3 p-3.5 bg-zinc-950 border border-zinc-800 rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-sky-400" />
          <h3 className="text-xs font-semibold text-zinc-200">Host Runtime Telemetry</h3>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 font-mono">
          <span className={`w-1.5 h-1.5 rounded-full ${isScanning ? 'bg-sky-400 animate-ping' : 'bg-emerald-400'}`}></span>
          <span>{isScanning ? 'POLLING' : 'ACTIVE'}</span>
        </div>
      </div>

      {/* Real Host Metric Cards */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {/* CPU */}
        <div className="p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-sky-500/10 text-sky-400">
            <Thermometer className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-zinc-500 font-mono">CPU LOAD</div>
            <div className="font-semibold text-zinc-200 truncate">{cpuPercent}%</div>
          </div>
        </div>

        {/* Memory */}
        <div className="p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-emerald-500/10 text-emerald-400">
            <Gauge className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-zinc-500 font-mono">MEMORY</div>
            <div className="font-semibold text-zinc-200 truncate">{memPercent}%</div>
          </div>
        </div>

        {/* Uptime */}
        <div className="p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-purple-500/10 text-purple-400">
            <Server className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-zinc-500 font-mono">UPTIME</div>
            <div className="font-semibold text-zinc-200 truncate max-w-[85px]">{uptimeStr}</div>
          </div>
        </div>

        {/* Host Node / Process */}
        <div className="p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-amber-500/10 text-amber-400">
            <Radio className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-zinc-500 font-mono">RUNTIME</div>
            <div className="font-semibold text-zinc-200 truncate text-[11px] font-mono">Node {nodeVer}</div>
          </div>
        </div>
      </div>

      {/* Token Throughput Graph */}
      <div className="flex flex-col gap-1.5 p-2.5 bg-zinc-900/60 border border-zinc-800 rounded-lg">
        <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400">
          <span className="flex items-center gap-1 text-zinc-300">
            <Zap className="w-3 h-3 text-sky-400" />
            TOKEN GENERATION SPEED
          </span>
          <span className="text-sky-400 font-semibold">{tokenSpeed > 0 ? `${tokenSpeed} tok/s` : 'IDLE'}</span>
        </div>

        <div className="w-full h-12 bg-black/60 rounded overflow-hidden relative border border-zinc-800/80">
          <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
            <line x1="0" y1="30" x2={width} y2="30" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" strokeDasharray="3,3" />
            <polyline fill="none" stroke="#38bdf8" strokeWidth="1.5" points={points} />
          </svg>
        </div>

        <div className="flex justify-between text-[9px] font-mono text-zinc-500">
          <span>PEAK: {maxVal} T/S</span>
          <span>SESSION: {totalTokens} TOKENS</span>
        </div>
      </div>

      {/* Host Environment Info */}
      <div className="text-[11px] font-mono text-zinc-500 space-y-1 pt-1 border-t border-zinc-850">
        <div className="flex justify-between">
          <span>Platform:</span>
          <span className="text-zinc-300">{raw?.platform || 'linux'} ({raw?.cpu?.cores || 4} cores)</span>
        </div>
        <div className="flex justify-between">
          <span>Working Dir:</span>
          <span className="text-zinc-300 truncate max-w-[150px]">{raw?.env?.cwd || '.'}</span>
        </div>
        <div className="flex justify-between">
          <span>PID:</span>
          <span className="text-zinc-300">{pid}</span>
        </div>
      </div>

      {/* Refresh Button */}
      <button
        onClick={onRefresh}
        disabled={isScanning}
        className="w-full py-2 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-750 border border-zinc-800 rounded-lg text-xs font-mono text-zinc-300 hover:text-white transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
      >
        <RotateCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-sky-400' : ''}`} />
        <span>{isScanning ? 'POLLING SYSTEM...' : 'REFRESH METRICS'}</span>
      </button>
    </div>
  );
}
