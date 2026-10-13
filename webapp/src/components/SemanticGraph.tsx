import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Maximize2,
  Minimize2,
  Search,
  FileCode,
  Brain,
  Sparkles,
  Link2,
  Copy,
  Check,
  MessageSquare,
  X,
  ExternalLink,
  Target,
  Compass,
} from "lucide-react";
import { SemanticNode, SemanticEdge, KnowledgeGraphData, NodeCategory } from "../types";

interface SemanticGraphProps {
  onNodeQuery?: (query: string) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export default function SemanticGraph({
  onNodeQuery,
  isExpanded = false,
  onToggleExpand,
}: SemanticGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [graphData, setGraphData] = useState<KnowledgeGraphData>({ nodes: [], edges: [] });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [copiedContent, setCopiedContent] = useState(false);

  // Pan and Zoom
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const draggedNodeRef = useRef<SemanticNode | null>(null);

  // Load knowledge graph
  const fetchGraph = useCallback(async () => {
    try {
      const res = await fetch("/api/context-graph");
      if (res.ok) {
        const data: KnowledgeGraphData = await res.json();
        const width = containerRef.current?.clientWidth || 700;
        const height = containerRef.current?.clientHeight || 500;
        const cx = width / 2;
        const cy = height / 2;

        // Position nodes precisely using their vector coordinates
        const positionedNodes = data.nodes.map((node) => {
          // Map normalized [-1, 1] vector coordinates to 2D canvas space
          const vx = node.vector?.[0] ?? (Math.random() * 2 - 1);
          const vy = node.vector?.[1] ?? (Math.random() * 2 - 1);
          const span = Math.min(width, height) * 0.38;

          // Compute node degree (connection count)
          const degree = data.edges.filter(
            (e) => e.source === node.id || e.target === node.id
          ).length;

          return {
            ...node,
            vector: [vx, vy] as [number, number],
            degree,
            x: cx + vx * span,
            y: cy + vy * span,
            vx: 0,
            vy: 0,
          };
        });

        setGraphData({ nodes: positionedNodes, edges: data.edges });
      }
    } catch (err) {
      console.error("Failed to fetch context graph:", err);
    }
  }, []);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((n) => n.id === selectedNodeId) || null,
    [graphData.nodes, selectedNodeId]
  );

  // Obsidian Spotlight connections
  const activeFocusId = hoveredNodeId || selectedNodeId;

  const connectedEdgeSet = useMemo(() => {
    if (!activeFocusId) return new Set<string>();
    return new Set(
      graphData.edges
        .filter((e) => e.source === activeFocusId || e.target === activeFocusId)
        .map((e) => e.id)
    );
  }, [graphData.edges, activeFocusId]);

  const connectedNeighborIds = useMemo(() => {
    if (!activeFocusId) return new Set<string>();
    const neighbors = new Set<string>();
    graphData.edges.forEach((e) => {
      if (e.source === activeFocusId) neighbors.add(e.target);
      if (e.target === activeFocusId) neighbors.add(e.source);
    });
    return neighbors;
  }, [graphData.edges, activeFocusId]);

  // Render Loop (Obsidian Style: pure black, hairline links, zero particle animations)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      // Deep Pure Obsidian Black Background
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.scale, transform.scale);

      // Subtle Background Coordinate Grid
      ctx.strokeStyle = "rgba(255, 255, 255, 0.025)";
      ctx.lineWidth = 0.5;
      const gridSize = 60;
      const startX = -1000;
      const endX = 2000;
      for (let x = startX; x <= endX; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, -1000);
        ctx.lineTo(x, 2000);
        ctx.stroke();
      }
      for (let y = startX; y <= endX; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(-1000, y);
        ctx.lineTo(2000, y);
        ctx.stroke();
      }

      // Draw Edges (Very light, subtle connections)
      graphData.edges.forEach((edge) => {
        const source = graphData.nodes.find((n) => n.id === edge.source);
        const target = graphData.nodes.find((n) => n.id === edge.target);
        if (!source?.x || !source?.y || !target?.x || !target?.y) return;

        const isConnected = connectedEdgeSet.has(edge.id);
        const isDimmed = activeFocusId && !isConnected;

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);

        if (isConnected) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
          ctx.lineWidth = 1.2;
        } else if (isDimmed) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.02)";
          ctx.lineWidth = 0.5;
        } else {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
          ctx.lineWidth = 0.75;
        }
        ctx.stroke();
      });

      // Draw Nodes (Clean, meticulous, obsidian circles)
      graphData.nodes.forEach((node) => {
        if (!node.x || !node.y) return;

        const isSelected = selectedNodeId === node.id;
        const isHovered = hoveredNodeId === node.id;
        const isNeighbor = connectedNeighborIds.has(node.id);
        const isDimmed = activeFocusId && !isSelected && !isHovered && !isNeighbor;

        const baseRadius = 3.5 + Math.min(8, (node.degree || 1) * 1.5);
        const radius = isSelected || isHovered ? baseRadius * 1.3 : baseRadius;

        // Subtle spotlight outer ring if focused
        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Node fill
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);

        if (isSelected) {
          ctx.fillStyle = "#ffffff";
        } else if (isHovered || isNeighbor) {
          ctx.fillStyle = node.clusterColor || "#ffffff";
        } else if (isDimmed) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
        } else {
          ctx.fillStyle = node.clusterColor ? `${node.clusterColor}bb` : "rgba(255, 255, 255, 0.75)";
        }
        ctx.fill();

        // Obsidian Clean Node Labels
        const showLabel = isSelected || isHovered || isNeighbor || (!activeFocusId && transform.scale > 0.85);

        if (showLabel) {
          ctx.font = `${isSelected || isHovered ? "600 " : "400 "}10px 'Space Grotesk', system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = isSelected || isHovered ? "#ffffff" : isNeighbor ? "#e2e8f0" : "rgba(255, 255, 255, 0.45)";
          ctx.fillText(node.label, node.x, node.y + radius + 11);
        }
      });

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [graphData, transform, selectedNodeId, hoveredNodeId, activeFocusId, connectedEdgeSet, connectedNeighborIds]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isExpanded]);

  // Coordinate transforms
  const screenToWorld = useCallback(
    (screenX: number, screenY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: (screenX - rect.left - transform.x) / transform.scale,
        y: (screenY - rect.top - transform.y) / transform.scale,
      };
    },
    [transform]
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = screenToWorld(e.clientX, e.clientY);

    const hit = graphData.nodes.find((n) => {
      if (!n.x || !n.y) return false;
      const dx = n.x - x;
      const dy = n.y - y;
      const r = 5 + Math.min(10, (n.degree || 1) * 2);
      return Math.sqrt(dx * dx + dy * dy) <= r;
    });

    if (hit) {
      draggedNodeRef.current = hit;
      setSelectedNodeId(hit.id);
    } else {
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = screenToWorld(e.clientX, e.clientY);

    if (draggedNodeRef.current) {
      draggedNodeRef.current.x = x;
      draggedNodeRef.current.y = y;
    } else if (isPanningRef.current) {
      setTransform((prev) => ({
        ...prev,
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      }));
    } else {
      const hovered = graphData.nodes.find((n) => {
        if (!n.x || !n.y) return false;
        const dx = n.x - x;
        const dy = n.y - y;
        const r = 6 + Math.min(10, (n.degree || 1) * 2);
        return Math.sqrt(dx * dx + dy * dy) <= r;
      });
      setHoveredNodeId(hovered ? hovered.id : null);
    }
  };

  const handleMouseUp = () => {
    draggedNodeRef.current = null;
    isPanningRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    setTransform((prev) => ({
      ...prev,
      scale: Math.max(0.35, Math.min(3.0, prev.scale * factor)),
    }));
  };

  const handleCopy = () => {
    if (!selectedNode) return;
    navigator.clipboard.writeText(selectedNode.content || selectedNode.summary);
    setCopiedContent(true);
    setTimeout(() => setCopiedContent(false), 2000);
  };

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col bg-black border border-white/10 rounded-2xl overflow-hidden select-none ${
        isExpanded ? "w-full h-full" : "w-full h-80"
      }`}
    >
      {/* Top Header Bar */}
      <div className="h-10 px-3.5 border-b border-white/10 flex items-center justify-between bg-black/90 z-10">
        <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span className="font-semibold tracking-wide">VECTOR CONTEXT MAP</span>
          <span className="text-[10px] text-slate-500">
            [{graphData.nodes.length} nodes · {graphData.edges.length} couplings]
          </span>
        </div>

        <div className="flex items-center gap-2">
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10"
              title={isExpanded ? "Minimize" : "Full Screen"}
            >
              {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Canvas Viewport */}
      <div className="flex-1 relative overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          className="w-full h-full cursor-grab active:cursor-grabbing block"
        />

        {/* Vector Info HUD for active node */}
        {activeFocusId && (
          <div className="absolute top-3 left-3 bg-black/85 border border-white/10 px-3 py-1.5 rounded-lg text-[10px] font-mono text-slate-300 pointer-events-none backdrop-blur-md">
            {(() => {
              const node = graphData.nodes.find((n) => n.id === activeFocusId);
              if (!node) return null;
              return (
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-white">{node.label}</span>
                  <span>
                    Vector: [{node.vector[0].toFixed(3)}, {node.vector[1].toFixed(3)}]
                  </span>
                  <span>Connections: {node.degree}</span>
                </div>
              );
            })()}
          </div>
        )}

        {/* Pan / Zoom HUD */}
        <div className="absolute bottom-3 left-3 flex items-center gap-1 bg-black/80 border border-white/10 p-1 rounded-lg text-xs font-mono text-slate-400">
          <button
            onClick={() => setTransform((prev) => ({ ...prev, scale: Math.min(3, prev.scale * 1.15) }))}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 hover:text-white"
          >
            +
          </button>
          <button
            onClick={() => setTransform((prev) => ({ ...prev, scale: Math.max(0.35, prev.scale * 0.85) }))}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 hover:text-white"
          >
            -
          </button>
          <button
            onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}
            className="px-2 h-6 flex items-center justify-center rounded text-[10px] hover:bg-white/10 hover:text-white"
          >
            RESET
          </button>
        </div>
      </div>

      {/* Selected Node Details Drawer */}
      <AnimatePresence>
        {selectedNode && (
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            className="absolute bottom-0 left-0 right-0 max-h-[80%] bg-black/95 border-t border-white/15 p-4 overflow-y-auto backdrop-blur-2xl z-20"
          >
            <div className="flex items-start justify-between border-b border-white/10 pb-2.5 mb-2.5">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white font-mono">{selectedNode.label}</h3>
                  <span
                    className="px-2 py-0.5 rounded text-[9px] font-mono uppercase font-semibold border"
                    style={{
                      borderColor: `${selectedNode.clusterColor}60`,
                      color: selectedNode.clusterColor,
                    }}
                  >
                    {selectedNode.category}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-slate-500 mt-1">
                  VECTOR COORDINATES: [{selectedNode.vector[0].toFixed(4)}, {selectedNode.vector[1].toFixed(4)}] · DEGREES: {selectedNode.degree}
                </div>
              </div>
              <button
                onClick={() => setSelectedNodeId(null)}
                className="p-1 rounded text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <p className="text-slate-300 leading-relaxed bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                {selectedNode.summary}
              </p>

              <div>
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mb-1">
                  <span>CONTEXT CONTENT</span>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 text-slate-400 hover:text-white"
                  >
                    {copiedContent ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedContent ? "Copied" : "Copy"}</span>
                  </button>
                </div>
                <pre className="p-2.5 bg-black border border-white/10 rounded-lg text-[11px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-40">
                  {selectedNode.content}
                </pre>
              </div>

              {onNodeQuery && (
                <button
                  onClick={() => {
                    onNodeQuery(`Analyze context for ${selectedNode.label}: ${selectedNode.summary}`);
                    setSelectedNodeId(null);
                  }}
                  className="w-full py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg font-mono text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span>Query In Chat</span>
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
