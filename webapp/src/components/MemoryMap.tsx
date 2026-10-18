import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Download, Eye, EyeOff, Maximize2, Minus, Plus, Search, Send, X } from 'lucide-react';
import type { MemoryDocument, MemoryGraphData, MemoryGraphNode } from '../types';
import ActivityOrb from './ActivityOrb';

type MemoryRequest = <T>(endpoint: string, options?: RequestInit) => Promise<T>;
type Side = 'system' | 'documents' | 'sessions' | 'projects';
type NodeKind = 'system' | 'domain' | 'shard' | 'document';
type GraphNode = {
  id: string;
  label: string;
  kind: NodeKind;
  side: Side;
  source?: string;
  document?: MemoryGraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchorX: number;
  anchorY: number;
  radius: number;
};
type GraphEdge = { source: string; target: string; similarity: number; kind: 'structure' | 'similarity' };
type Transform = { x: number; y: number; scale: number };

const MEMORY_COLORS = {
  symbiote: '#55c982',
  knowledge: '#50b976',
  sessions: '#5796f5',
  projects: '#e8ba4b',
  vdb: '#ed5964',
};

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildGraph(data: MemoryGraphData, width: number, height: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const centerX = width / 2;
  const centerY = height / 2;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const addNode = (node: Omit<GraphNode, 'vx' | 'vy'>) => nodes.push({ ...node, vx: 0, vy: 0 });
  addNode({
    id: 'system', label: 'SYMBIOTE', kind: 'system', side: 'system',
    x: centerX, y: centerY, anchorX: centerX, anchorY: centerY, radius: 12,
  });

  const sides: Array<{ id: Exclude<Side, 'system'>; label: string; x: number; y: number; dx: number; dy: number }> = [
    { id: 'documents', label: 'KNOWLEDGE', x: centerX - Math.min(215, width * 0.27), y: centerY, dx: -1, dy: 0 },
    { id: 'sessions', label: 'SESSIONS', x: centerX + Math.min(215, width * 0.27), y: centerY, dx: 1, dy: 0 },
    { id: 'projects', label: 'PROJECTS', x: centerX, y: centerY + Math.min(130, height * 0.26), dx: 0, dy: 1 },
  ];
  const parent = new Map(data.nodes.map(document => [document.id, document.id]));
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const join = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot < rightRoot ? rightRoot : leftRoot, leftRoot < rightRoot ? leftRoot : rightRoot);
  };
  const sideById = new Map(data.nodes.map(document => [document.id, document.side]));
  const documentIds = new Set(data.nodes.map(document => document.id));
  const similarityEdges = data.edges.filter(edge =>
    edge.source !== edge.target
      && documentIds.has(edge.source)
      && documentIds.has(edge.target)
      && Number.isFinite(edge.similarity)
      && edge.similarity >= 0
      && edge.similarity <= 1,
  );
  const strongestSimilarity = new Map<string, number>();
  for (const edge of similarityEdges) {
    strongestSimilarity.set(edge.source, Math.max(strongestSimilarity.get(edge.source) ?? 0, edge.similarity));
    strongestSimilarity.set(edge.target, Math.max(strongestSimilarity.get(edge.target) ?? 0, edge.similarity));
  }
  for (const edge of similarityEdges) {
    const localBaseline = Math.min(
      strongestSimilarity.get(edge.source) ?? 0,
      strongestSimilarity.get(edge.target) ?? 0,
    );
    const clusterThreshold = Math.max(0.12, localBaseline * 0.68);
    if (edge.similarity >= clusterThreshold && sideById.get(edge.source) === sideById.get(edge.target)) {
      join(edge.source, edge.target);
    }
  }
  const components = new Map<string, MemoryGraphNode[]>();
  for (const document of data.nodes) {
    const root = find(document.id);
    const component = components.get(root) ?? [];
    component.push(document);
    components.set(root, component);
  }
  const multiDocumentComponents = [...components.entries()]
    .filter(([, documents]) => documents.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  const componentNumbers = new Map(multiDocumentComponents.map(([root], index) => [root, index + 1]));
  const shards = new Map<string, { side: Exclude<Side, 'system'>; source: string; label: string; documents: MemoryGraphNode[] }>();
  const isolated = new Map<string, MemoryGraphNode[]>();
  for (const [root, documents] of components) {
    const side = documents[0].side;
    const sources = new Map<string, number>();
    for (const document of documents) sources.set(document.source, (sources.get(document.source) ?? 0) + 1);
    const source = [...sources].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? 'other';
    if (documents.length === 1) {
      const key = `${side}\0${source}`;
      const group = isolated.get(key) ?? [];
      group.push(...documents);
      isolated.set(key, group);
    } else {
      const number = String(componentNumbers.get(root) ?? 1).padStart(2, '0');
      shards.set(`cluster:${side}:${root}`, {
        side, source, label: `${source.toUpperCase()} · ${number}`, documents,
      });
    }
  }
  for (const [key, documents] of isolated) {
    const [side, source] = key.split('\0') as [Exclude<Side, 'system'>, string];
    shards.set(`isolated:${side}:${source}`, {
      side, source, label: `${source.toUpperCase()} · OTHER`, documents,
    });
  }

  for (const side of sides) {
    const domainId = `domain:${side.id}`;
    addNode({
      id: domainId, label: side.label, kind: 'domain', side: side.id,
      x: side.x, y: side.y, anchorX: side.x, anchorY: side.y, radius: 8,
    });
    edges.push({ source: 'system', target: domainId, similarity: 1, kind: 'structure' });
    const groups = [...shards.entries()]
      .filter(([, shard]) => shard.side === side.id)
      .sort(([left], [right]) => left.localeCompare(right));
    const perpendicularX = -side.dy;
    const perpendicularY = side.dx;
    const sourceX = side.x + side.dx * 72;
    const sourceY = side.y + side.dy * 72;
    groups.forEach(([key, shard], groupIndex) => {
      const { source, documents } = shard;
      const rows = Math.max(1, groups.length);
      const offset = (groupIndex - (rows - 1) / 2) * Math.min(125, Math.max(24, width / rows * 0.12));
      const shardX = sourceX + perpendicularX * offset;
      const shardY = sourceY + perpendicularY * offset;
      const shardId = `shard:${key}`;
      addNode({
        id: shardId, label: shard.label, kind: 'shard', side: side.id, source,
        x: shardX, y: shardY, anchorX: shardX, anchorY: shardY, radius: 5,
      });
      edges.push({ source: domainId, target: shardId, similarity: 1, kind: 'structure' });
      documents.forEach(document => {
        const hash = stableHash(document.id);
        const angle = (hash % 3600) / 3600 * Math.PI * 2;
        const distance = 24 + ((hash >>> 9) % 100) / 100 * 77;
        const x = shardX + Math.cos(angle) * distance;
        const y = shardY + Math.sin(angle) * distance;
        addNode({
          id: document.id, label: document.label, kind: 'document', side: side.id,
          source: document.source, document,
          x, y, anchorX: x, anchorY: y, radius: 2.2,
        });
        edges.push({ source: shardId, target: document.id, similarity: 1, kind: 'structure' });
      });
    });
  }

  for (const edge of similarityEdges) {
    edges.push({ ...edge, kind: 'similarity' });
  }
  return { nodes, edges };
}

function sideColor(node: GraphNode): string {
  if (node.kind === 'system') return MEMORY_COLORS.symbiote;
  if (node.side === 'documents') return MEMORY_COLORS.knowledge;
  if (node.side === 'sessions') return MEMORY_COLORS.sessions;
  if (node.side === 'projects') return MEMORY_COLORS.projects;
  return MEMORY_COLORS.knowledge;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MemoryMap({ request, onSendNode }: { request: MemoryRequest; onSendNode: (node: MemoryGraphNode) => Promise<void> }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<GraphNode[]>([]);
  const graphEdgesRef = useRef<GraphEdge[]>([]);
  const renderGraphRef = useRef<() => void>(() => {});
  const hoveredIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const hasAutoFitRef = useRef(false);
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const pointerRef = useRef<{ x: number; y: number; startX: number; startY: number; nodeId: string | null; moved: boolean } | null>(null);
  const [data, setData] = useState<MemoryGraphData | null>(null);
  const [selected, setSelected] = useState<MemoryDocument | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [sendingNodeId, setSendingNodeId] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');
  hoveredIdRef.current = hoveredId;
  selectedIdRef.current = selected?.id ?? null;

  const loadGraph = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const graph = await request<MemoryGraphData>('/api/memory/graph');
      setData(graph);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load the memory map.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [request]);

  useEffect(() => {
    void loadGraph();
    const timer = window.setInterval(() => void loadGraph(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadGraph]);

  const sources = useMemo(() => [...new Set(data?.nodes.map(node => node.source) ?? [])].sort(), [data]);
  const queryLower = query.trim().toLowerCase();
  const shownDocuments = useMemo(() => (data?.nodes ?? []).filter(node =>
    (sourceFilter === 'all' || (sourceFilter === 'projects' && node.side === 'projects') || node.storage === sourceFilter || node.source === sourceFilter)
    && (!queryLower || `${node.label} ${node.source} ${node.excerpt}`.toLowerCase().includes(queryLower)),
  ), [data, queryLower, sourceFilter]);

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas || !data) return;
    let width = Math.max(1, shell.clientWidth);
    let height = Math.max(1, shell.clientHeight);
    let frame = 0;
    let tick = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const setSize = () => {
      const previousWidth = width;
      const previousHeight = height;
      width = Math.max(1, shell.clientWidth);
      height = Math.max(1, shell.clientHeight);
      if (hasAutoFitRef.current) {
        transformRef.current.x += (width - previousWidth) / 2;
        transformRef.current.y += (height - previousHeight) / 2;
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    setSize();
    const observer = new ResizeObserver(() => {
      setSize();
      renderGraphRef.current();
    });
    observer.observe(shell);

    const graph = buildGraph(data, width, height);
    const previous = new Map(graphRef.current.map(node => [node.id, node]));
    for (const node of graph.nodes) {
      const old = previous.get(node.id);
      if (old) {
        node.x = old.x;
        node.y = old.y;
        node.anchorX = old.anchorX;
        node.anchorY = old.anchorY;
      }
    }
    graphRef.current = graph.nodes;
    graphEdgesRef.current = graph.edges;
    if (!hasAutoFitRef.current && graph.nodes.length) {
      const bounds = graph.nodes.reduce((result, node) => ({
        minX: Math.min(result.minX, node.x),
        maxX: Math.max(result.maxX, node.x),
        minY: Math.min(result.minY, node.y),
        maxY: Math.max(result.maxY, node.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
      const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
      const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
      const scale = Math.max(0.3, Math.min(1.2, 1, (width - 76) / graphWidth, (height - 76) / graphHeight));
      transformRef.current = {
        x: width / 2 - (bounds.minX + bounds.maxX) / 2 * scale,
        y: height / 2 - (bounds.minY + bounds.maxY) / 2 * scale,
        scale,
      };
      hasAutoFitRef.current = true;
    }

    const render = () => {
      const context = canvas.getContext('2d');
      if (!context) return;
      const themeRoot = document.documentElement;
      const themeStyles = getComputedStyle(themeRoot);
      const canvasBackground = themeStyles.getPropertyValue('--paper-raised').trim() || themeStyles.backgroundColor;
      const ink = themeStyles.getPropertyValue('--appearance-paper-ink').trim() || themeStyles.color || '#111';
      context.clearRect(0, 0, width, height);
      context.fillStyle = canvasBackground;
      context.fillRect(0, 0, width, height);
      const transform = transformRef.current;
      context.save();
      context.translate(transform.x, transform.y);
      context.scale(transform.scale, transform.scale);

      const byId = new Map(graph.nodes.map(node => [node.id, node]));
      const visibleIds = new Set(['system', 'domain:documents', 'domain:sessions', 'domain:projects']);
      for (const document of shownDocuments) {
        visibleIds.add(document.id);
        const parentEdge = graph.edges.find(edge => edge.kind === 'structure' && edge.target === document.id);
        if (parentEdge) visibleIds.add(parentEdge.source);
      }
      const visibleEdges = graph.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
      const focusId = hoveredIdRef.current ?? selectedIdRef.current;
      const focusEdges = focusId ? visibleEdges.filter(edge => edge.source === focusId || edge.target === focusId) : [];
      const focusSet = new Set(focusEdges);
      for (const edge of visibleEdges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target) continue;
        const focused = focusSet.has(edge);
        context.beginPath();
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
        if (edge.kind === 'similarity') {
          context.strokeStyle = focused ? MEMORY_COLORS.knowledge : ink;
          context.globalAlpha = focused ? 0.28 + edge.similarity * 0.62 : 0.025 + edge.similarity * 0.2;
          context.lineWidth = focused ? 0.85 + edge.similarity : 0.45;
        } else {
          const sourceNode = byId.get(edge.source);
          context.strokeStyle = sourceNode ? sideColor(sourceNode) : MEMORY_COLORS.symbiote;
          context.globalAlpha = focused ? 0.78 : edge.source === 'system' ? 0.38 : 0.2;
          context.lineWidth = focused ? 1.1 : edge.source === 'system' ? 1.15 : 0.75;
        }
        context.stroke();
        context.globalAlpha = 1;
      }

      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const node of graph.nodes) {
        if (!visibleIds.has(node.id)) continue;
        const color = sideColor(node);
        const isFocused = node.id === focusId;
        const radius = node.radius * (isFocused ? 1.6 : 1);
        if (node.kind !== 'document') {
          context.beginPath();
          context.arc(node.x, node.y, radius + (node.kind === 'system' ? 11 : 5), 0, Math.PI * 2);
          context.strokeStyle = color;
          context.globalAlpha = node.kind === 'system' ? 0.24 : 0.12;
          context.lineWidth = node.kind === 'system' ? 1.2 : 0.8;
          context.stroke();
          context.globalAlpha = 1;
        }
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        context.fillStyle = color;
        context.globalAlpha = node.kind === 'document' && focusId && !focusEdges.some(edge => edge.source === node.id || edge.target === node.id) ? 0.38 : 0.92;
        context.fill();
        context.globalAlpha = 1;
        if (node.kind === 'document' && node.document?.storage === 'vdb') {
          context.beginPath();
          context.arc(node.x, node.y, radius + 2.1, 0, Math.PI * 2);
          context.strokeStyle = MEMORY_COLORS.vdb;
          context.globalAlpha = 0.8;
          context.lineWidth = 0.8;
          context.stroke();
          context.globalAlpha = 1;
        }

      }
      context.restore();

      if (!reducedMotion && tick < 150 && graph.nodes.length <= 5000) {
        tick++;
        const cellSize = 42;
        const grid = new Map<string, GraphNode[]>();
        const nodeIndexes = new Map(graph.nodes.map((node, index) => [node, index]));
        for (const node of graph.nodes) {
          const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
          const cell = grid.get(key) ?? [];
          cell.push(node);
          grid.set(key, cell);
        }
        for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex++) {
          const node = graph.nodes[nodeIndex];
          if (node.kind === 'system') continue;
          const cellX = Math.floor(node.x / cellSize);
          const cellY = Math.floor(node.y / cellSize);
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (const other of grid.get(`${cellX + dx},${cellY + dy}`) ?? []) {
                const otherIndex = nodeIndexes.get(other) ?? -1;
                if (otherIndex <= nodeIndex) continue;
                const differenceX = node.x - other.x;
                const differenceY = node.y - other.y;
                const distanceSquared = differenceX * differenceX + differenceY * differenceY;
                if (distanceSquared > 0 && distanceSquared < cellSize * cellSize) {
                  const force = (node.kind === 'document' && other.kind === 'document' ? 2.8 : 6) / distanceSquared;
                  node.vx += differenceX * force;
                  node.vy += differenceY * force;
                  other.vx -= differenceX * force;
                  other.vy -= differenceY * force;
                }
              }
            }
          }
        }
        for (const edge of graph.edges) {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          if (!source || !target || edge.kind === 'similarity' && edge.similarity < 0.16) continue;
          const differenceX = target.x - source.x;
          const differenceY = target.y - source.y;
          const distance = Math.max(1, Math.hypot(differenceX, differenceY));
          const targetDistance = edge.kind === 'similarity' ? 55 + (1 - edge.similarity) * 62 : 88;
          const force = edge.kind === 'similarity' ? edge.similarity * 0.004 : 0.009;
          const attraction = (distance - targetDistance) * force;
          if (source.kind !== 'system') {
            source.vx += differenceX / distance * attraction;
            source.vy += differenceY / distance * attraction;
          }
          if (target.kind !== 'system') {
            target.vx -= differenceX / distance * attraction;
            target.vy -= differenceY / distance * attraction;
          }
        }
        for (const node of graph.nodes) {
          const anchorForce = node.kind === 'system' ? 0 : node.kind === 'document' ? 0.006 : 0.02;
          node.vx += (node.anchorX - node.x) * anchorForce;
          node.vy += (node.anchorY - node.y) * anchorForce;
          node.vx *= 0.84;
          node.vy *= 0.84;
          node.x += Math.max(-3, Math.min(3, node.vx));
          node.y += Math.max(-3, Math.min(3, node.vy));
        }
        frame = window.requestAnimationFrame(render);
      }
    };
    renderGraphRef.current = render;
    render();
    const themeObserver = new MutationObserver(() => renderGraphRef.current());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [data, shownDocuments]);

  const getPointerNode = (event: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }): GraphNode | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const transform = transformRef.current;
    const x = (event.clientX - bounds.left - transform.x) / transform.scale;
    const y = (event.clientY - bounds.top - transform.y) / transform.scale;
    for (let index = graphRef.current.length - 1; index >= 0; index--) {
      const node = graphRef.current[index];
      if (node.kind === 'document' && !shownDocuments.some(document => document.id === node.id)) continue;
      const hitRadius = Math.max(node.radius + 6, node.kind === 'document' ? 6 : node.radius + 4);
      if ((node.x - x) ** 2 + (node.y - y) ** 2 <= hitRadius ** 2) return node;
    }
    return null;
  };

  const selectNode = async (node: GraphNode | null) => {
    if (!node?.document) {
      setSelected(null);
      return;
    }
    try {
      const document = await request<MemoryDocument>(`/api/memory/documents/${encodeURIComponent(node.id)}`);
      setSelected(document);
      selectedIdRef.current = document.id;
      renderGraphRef.current();
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load this memory document.');
    }
  };

  const focusNode = (node: GraphNode) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.max(0.7, Math.min(2.2, transformRef.current.scale * 1.7));
    transformRef.current = {
      x: canvas.clientWidth / 2 - node.x * scale,
      y: canvas.clientHeight / 2 - node.y * scale,
      scale,
    };
    renderGraphRef.current();
  };

  const resetMap = () => {
    const canvas = canvasRef.current;
    const nodes = graphRef.current;
    if (!canvas || !nodes.length) return;
    const bounds = nodes.reduce((result, node) => ({
      minX: Math.min(result.minX, node.x),
      maxX: Math.max(result.maxX, node.x),
      minY: Math.min(result.minY, node.y),
      maxY: Math.max(result.maxY, node.y),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.max(0.3, Math.min(1.2, 1, (canvas.clientWidth - 76) / graphWidth, (canvas.clientHeight - 76) / graphHeight));
    transformRef.current = {
      x: canvas.clientWidth / 2 - (bounds.minX + bounds.maxX) / 2 * scale,
      y: canvas.clientHeight / 2 - (bounds.minY + bounds.maxY) / 2 * scale,
      scale,
    };
    renderGraphRef.current();
  };

  const saveImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) {
        setError('The memory map image could not be created.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `symbiote-memory-map-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  const updateZoom = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const transform = transformRef.current;
    const nextScale = Math.max(0.3, Math.min(3.5, transform.scale * factor));
    const centerX = canvas.clientWidth / 2;
    const centerY = canvas.clientHeight / 2;
    const ratio = nextScale / transform.scale;
    transformRef.current = {
      x: centerX - (centerX - transform.x) * ratio,
      y: centerY - (centerY - transform.y) * ratio,
      scale: nextScale,
    };
    renderGraphRef.current();
  };

  const stats = data?.stats;
  const hoveredNode = hoveredId ? graphRef.current.find(node => node.id === hoveredId) : null;
  const hoveredDocumentCount = hoveredNode
    ? graphEdgesRef.current.filter(edge => edge.kind === 'structure' && edge.source === hoveredNode.id).length
    : 0;
  const hoveredSimilarCount = hoveredNode
    ? graphEdgesRef.current.filter(edge => edge.source === hoveredNode.id || edge.target === hoveredNode.id).length
    : 0;
  const sessionCount = data?.nodes.filter(node => node.side === 'sessions').length ?? 0;
  const projectCount = data?.nodes.filter(node => node.side === 'projects').length ?? 0;
  const documentCount = data?.nodes.length ? data.nodes.length - sessionCount - projectCount : 0;

  return (
    <div className="page memory-page">
      <header className="memory-heading">
        <div><div className="eyebrow">PERSISTENT KNOWLEDGE · LIVE SIMILARITY</div><h1>Memory map</h1><p>Indexed from {data?.storage ?? '.vdb/'} · Knowledge, sessions, and project work stay distinct and connect through semantic similarity.</p></div>
        <button className="button button-secondary memory-export" type="button" onClick={saveImage} disabled={!data?.nodes.length}><Download size={15} />Save as image</button>
      </header>

      {error && <div className="notice notice-error memory-error" role="alert"><span>{error}</span><button type="button" className="icon-button small" onClick={() => void loadGraph(true)} aria-label="Retry memory map"><Activity size={14} /></button></div>}

      <section className="memory-overview" aria-label="Memory index statistics">
        <div><span>VDB DOCUMENTS</span><strong>{stats?.documentCount ?? '—'}</strong></div>
        <div><span>KNOWLEDGE</span><strong>{documentCount.toLocaleString()}</strong></div>
        <div><span>SESSION MEMORY</span><strong>{sessionCount.toLocaleString()}</strong></div>
        <div><span>PROJECT MEMORY</span><strong>{projectCount.toLocaleString()}</strong></div>
        <div><span>VOCABULARY</span><strong>{stats?.termCount.toLocaleString() ?? '—'}</strong></div>
        <div><span>INDEX SIZE</span><strong>{stats ? formatBytes(stats.diskBytes) : '—'}</strong></div>
      </section>

      <section className="memory-map-card surface-card">
        <div className="memory-toolbar">
          <label className="search-field memory-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a memory…" aria-label="Search memory map" />{query && <button className="icon-button small" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button>}</label>
          <label className="memory-source-filter"><span className="sr-only">Filter by source</span><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}><option value="all">All sources</option><option value="vdb">.vdb vector store</option><option value="projects">Projects</option>{sources.map(source => <option key={source} value={source}>{source}</option>)}</select></label>
          <span className={`memory-refresh-label${refreshing ? ' is-refreshing' : ''}`}>{refreshing && <ActivityOrb label="Synchronizing memory" compact loading />}{refreshing ? 'SYNCING' : stats ? `${shownDocuments.length.toLocaleString()} / ${stats.documentCount.toLocaleString()} NODES` : loading ? 'INDEXING' : 'NO INDEX'}</span>
        </div>
        <div className="memory-map-shell" ref={shellRef}>
          {loading && <div className="memory-loading"><ActivityOrb label="Loading indexed knowledge" loading /><span>Loading indexed knowledge…</span></div>}
          {!loading && !data?.nodes.length && <div className="memory-empty">No indexed knowledge yet. Memory documents, sessions, and project files appear here as they are synchronized.</div>}
          <canvas
            ref={canvasRef}
            className="memory-canvas"
            role="img"
            aria-label="Interactive similarity map of indexed memory. The system connects separate knowledge and session-memory fields, with closer dots representing more similar documents."
            onPointerDown={event => {
              const node = getPointerNode(event);
              pointerRef.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, nodeId: node?.id ?? null, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              const point = pointerRef.current;
              if (point) {
                const dx = event.clientX - point.x;
                const dy = event.clientY - point.y;
                if (Math.abs(event.clientX - point.startX) + Math.abs(event.clientY - point.startY) > 4) point.moved = true;
                if (point.nodeId && point.moved) {
                  const node = graphRef.current.find(item => item.id === point.nodeId);
                  if (node) {
                    node.x += dx / transformRef.current.scale;
                    node.y += dy / transformRef.current.scale;
                    node.anchorX = node.x;
                    node.anchorY = node.y;
                  }
                } else if (point.moved) {
                  transformRef.current.x += dx;
                  transformRef.current.y += dy;
                }
                point.x = event.clientX;
                point.y = event.clientY;
                renderGraphRef.current();
              } else {
                const node = getPointerNode(event);
                event.currentTarget.style.cursor = node ? 'pointer' : 'grab';
                const nextHoveredId = node?.id ?? null;
                const bounds = shellRef.current?.getBoundingClientRect();
                setHoverPosition(node ? {
                  x: Math.min(event.clientX - (bounds?.left ?? 0) + 14, Math.max(8, (bounds?.width ?? 300) - 290)),
                  y: Math.min(event.clientY - (bounds?.top ?? 0) + 14, Math.max(8, (bounds?.height ?? 180) - 245)),
                } : null);
                if (hoveredIdRef.current !== nextHoveredId) {
                  hoveredIdRef.current = nextHoveredId;
                  setHoveredId(nextHoveredId);
                  renderGraphRef.current();
                }
              }
            }}
            onPointerUp={event => {
              const pointer = pointerRef.current;
              if (pointer && !pointer.moved) void selectNode(getPointerNode(event));
              pointerRef.current = null;
            }}
            onDoubleClick={event => {
              const node = getPointerNode(event);
              if (node) {
                focusNode(node);
                void selectNode(node);
              }
            }}
            onPointerLeave={() => {
              if (!pointerRef.current) {
                hoveredIdRef.current = null;
                setHoveredId(null);
                setHoverPosition(null);
                renderGraphRef.current();
              }
            }}
            onPointerCancel={() => { pointerRef.current = null; }}
            onWheel={event => {
              event.preventDefault();
              updateZoom(event.deltaY < 0 ? 1.1 : 0.9);
            }}
          />
          {data?.nodes.length ? (
            <>
              <button className="memory-legend-toggle" type="button" onClick={() => setLegendOpen(open => !open)} aria-expanded={legendOpen} aria-label={legendOpen ? 'Hide graph legend' : 'Show graph legend'} title={legendOpen ? 'Hide legend' : 'Show legend'}>
                {legendOpen ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              {legendOpen && <div className="memory-map-legend"><span><i className="legend-dot legend-docs" />Knowledge</span><span><i className="legend-dot legend-sessions" />Sessions</span><span><i className="legend-dot legend-projects" />Projects</span><span><i className="legend-vdb" />.vdb storage</span><span><i className="legend-link" />Similarity</span></div>}
              <div className="memory-zoom-controls">
                <button type="button" onClick={() => updateZoom(1.2)} aria-label="Zoom in"><Plus size={15} /></button>
                <button type="button" onClick={() => updateZoom(0.84)} aria-label="Zoom out"><Minus size={15} /></button>
                <button type="button" onClick={resetMap} aria-label="Fit map to view"><Maximize2 size={14} /></button>
              </div>
            </>
          ) : null}
          {hoveredNode && hoverPosition && (
            <aside className="memory-hover-card" style={{ left: hoverPosition.x, top: hoverPosition.y }} aria-live="polite">
              <strong>{hoveredNode.label}</strong>
              <span>{hoveredNode.source ?? hoveredNode.kind} · {hoveredNode.side} · {hoveredNode.document?.storage ?? 'graph node'}</span>
              {hoveredNode.document?.excerpt && <p>{hoveredNode.document.excerpt}</p>}
              <small>{hoveredNode.kind === 'shard' ? `${hoveredDocumentCount} documents · ` : ''}{hoveredSimilarCount} connections{hoveredNode.document?.role ? ` · ${hoveredNode.document.role}` : ''}{hoveredNode.document?.timestamp ? ` · ${new Date(hoveredNode.document.timestamp).toLocaleString()}` : ''}{hoveredNode.document?.sessionId ? ` · session ${hoveredNode.document.sessionId}` : ''}</small>
              {hoveredNode.document && <button type="button" className="memory-node-send" disabled={sendingNodeId === hoveredNode.document.id} onClick={async event => {
                event.stopPropagation();
                setSendingNodeId(hoveredNode.document!.id);
                setSendError('');
                try {
                  await onSendNode(hoveredNode.document!);
                } catch (failure) {
                  setSendError(failure instanceof Error ? failure.message : 'Memory context could not be sent.');
                } finally {
                  setSendingNodeId(null);
                }
              }}><Send size={12} />{sendingNodeId === hoveredNode.document.id ? 'Sending…' : 'Ask agent about this'}</button>}
              {sendError && <small className="memory-node-error" role="alert">{sendError}</small>}
            </aside>
          )}
        </div>
        {selected && (
          <aside className="memory-detail" aria-label="Selected memory document">
            <div className="memory-detail-heading"><div><div className="eyebrow">{selected.source} · {selected.role}</div><h2>{selected.label}</h2></div><button className="icon-button small" type="button" onClick={() => { setSelected(null); selectedIdRef.current = null; renderGraphRef.current(); }} aria-label="Close memory details"><X size={15} /></button></div>
            <p>{selected.text}</p>
            <div className="memory-detail-meta"><span>{new Date(selected.timestamp).toLocaleString()}</span>{selected.sessionId && <span>Session {selected.sessionId}</span>}</div>
          </aside>
        )}
        <div className="memory-card-footer"><span><i className="memory-live-dot" />Shared VDB · {refreshing ? 'updating' : 'refreshes every 30 seconds'}</span><span>Drag to explore · Scroll to zoom · Select a node for its source</span></div>
      </section>

    </div>
  );
}

export default MemoryMap;
