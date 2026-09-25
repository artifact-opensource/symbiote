import React, { useMemo } from "react";
import { motion } from "motion/react";
import { Network } from "lucide-react";

interface SemanticGraphProps {
  keywords: string[];
  onKeywordClick: (word: string) => void;
}

export default function SemanticGraph({ keywords, onKeywordClick }: SemanticGraphProps) {
  // Always ensure we have at least 4-5 nodes for visual appeal
  const fallbackKeywords = ["COGNITION", "DYNAMICS", "SYNAPSE", "RESONANCE"];
  const displayKeywords = useMemo(() => {
    let list = [...keywords];
    if (list.length < 4) {
      fallbackKeywords.forEach(fw => {
        if (!list.includes(fw)) {
          list.push(fw);
        }
      });
    }
    return list.slice(0, 7); // keep it elegant and dense in sidebar (max 7)
  }, [keywords]);

  // Dynamically place keywords radially around center (100, 100) on a 200x200 canvas
  const nodes = useMemo(() => {
    const center = { x: 100, y: 100 };
    const radius = 62;
    return displayKeywords.map((word, index) => {
      const angle = (index * 2 * Math.PI) / displayKeywords.length - Math.PI / 2;
      return {
        id: word,
        label: word,
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
        angle
      };
    });
  }, [displayKeywords]);

  return (
    <div className="border border-[#222] bg-[#0A0A0B] rounded-sm p-4 relative overflow-hidden group hover:border-[#FF3E00]/30 transition-all duration-300">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-1.5 text-xs text-[#FF3E00] font-mono">
          <Network className="w-3.5 h-3.5" />
          <span className="uppercase font-bold tracking-widest text-[10px]">SEMANTIC RELATION</span>
        </div>
        <span className="text-[8px] font-mono text-[#FF3E00] uppercase tracking-widest bg-[#FF3E00]/10 px-1.5 py-0.2 rounded">
          {displayKeywords.length} NODES
        </span>
      </div>

      <div className="relative w-full aspect-square max-w-[200px] mx-auto bg-black/40 rounded-sm overflow-hidden border border-[#1a1a1a]">
        {/* Connection matrix SVG */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 200 200">
          <defs>
            <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FF3E00" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="glowLine" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FF3E00" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#FF3E00" stopOpacity="0.10" />
            </linearGradient>
          </defs>

          {/* Lines connecting each word to central node */}
          {nodes.map((node) => (
            <g key={`line-${node.id}`}>
              <motion.line
                x1={100}
                y1={100}
                x2={node.x}
                y2={node.y}
                stroke="url(#glowLine)"
                strokeWidth={1.2}
                initial={{ strokeDasharray: "4,4", strokeDashoffset: 0 }}
                animate={{ strokeDashoffset: [0, -10] }}
                transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
              />
              {/* Little moving particles on the line */}
              <motion.circle
                r={2}
                fill="#FF3E00"
                animate={{
                  cx: [100, node.x],
                  cy: [100, node.y]
                }}
                transition={{
                  duration: 2.2 + Math.random() * 1.5,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              />
            </g>
          ))}

          {/* Central Core Connection Hub */}
          <circle cx={100} cy={100} r={18} fill="url(#hubGlow)" />
          <circle cx={100} cy={100} r={5} fill="#FF3E00" className="animate-pulse" />
        </svg>

        {/* Central Core Node Button Label */}
        <div className="absolute top-[88px] left-[88px] w-6 h-6 flex items-center justify-center pointer-events-none">
          <span className="text-[6.5px] font-mono text-white/40 tracking-widest uppercase">
            CORE
          </span>
        </div>

        {/* Discovered Radial Keyword Nodes */}
        {nodes.map((node) => (
          <div
            key={node.id}
            className="absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer group/node"
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
            onClick={() => onKeywordClick(node.id)}
          >
            <motion.div
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.92 }}
              className="bg-[#0C0C0D] border border-[#222] hover:border-[#FF3E00] px-1.5 py-0.5 rounded-sm shadow-xl flex items-center gap-1 transition-all duration-300"
            >
              <div className="w-1 h-1 rounded-full bg-[#FF3E00] group-hover/node:bg-white"></div>
              <span className="text-[7.5px] font-mono text-slate-300 group-hover/node:text-white uppercase tracking-tight">
                {node.label}
              </span>
            </motion.div>
          </div>
        ))}
      </div>

      <div className="mt-3 text-center">
        <p className="text-[9px] font-mono text-slate-500 leading-normal">
          Click any terminal token node above to probe or deep-dive into its keywords.
        </p>
      </div>
    </div>
  );
}
