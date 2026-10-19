/// <reference path="../types/d3-force-3d.d.ts" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import { forceCollide, forceX, forceY, forceZ } from 'd3-force-3d';
import type { GraphData, LinkObject, NodeObject } from 'three-forcegraph';
import * as THREE from 'three';
import { Activity, ChevronDown, CircleHelp, Download, Maximize2, Minus, Plus, RefreshCw, Search, Send, X } from 'lucide-react';
import type { MemoryDocument, MemoryGraphData, MemoryGraphNode, MemoryNodeContext } from '../types';
import ActivityOrb from './ActivityOrb';

type MemoryRequest = <T>(endpoint: string, options?: RequestInit) => Promise<T>;
type Side = 'system' | 'documents' | 'sessions' | 'projects';
type NodeKind = 'system' | 'domain' | 'source' | 'document';
type GraphNode = NodeObject & {
  id: string;
  label: string;
  kind: NodeKind;
  side: Side;
  source?: string;
  parentId?: string;
  targetX: number;
  targetY: number;
  targetZ: number;
  documentCount?: number;
  document?: MemoryGraphNode;
  val: number;
};
type GraphEdge = LinkObject<GraphNode> & {
  source: string | GraphNode;
  target: string | GraphNode;
  similarity: number;
  kind: 'structure' | 'similarity';
  layoutDistance?: number;
};
type GraphInstance = ForceGraph3DInstance<GraphNode, GraphEdge>;

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

function initialPosition(id: string, center: { x: number; y: number; z: number }, radius = 0): { x: number; y: number; z: number } {
  let state = stableHash(id);
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const vertical = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const spread = radius * Math.cbrt(random());
  const horizontal = Math.sqrt(1 - vertical * vertical) * spread;
  return {
    x: center.x + horizontal * Math.cos(angle),
    y: center.y + vertical * spread,
    z: center.z + horizontal * Math.sin(angle),
  };
}

function endpointId(endpoint: string | number | GraphNode): string {
  return typeof endpoint === 'object' ? endpoint.id : String(endpoint);
}

function graphBackgroundColor(color: string): string {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(color);
  if (!srgb) return color;
  const channels = srgb.slice(1, 4).map(channel => Math.round(Math.min(1, Math.max(0, Number(channel))) * 255));
  return `rgb(${channels.join(', ')})`;
}

function graphSignature(data: MemoryGraphData): string {
  const fingerprint = JSON.stringify([
    data.stats.lastIndexed,
    data.stats.documentCount,
    data.nodes.map(node => [node.id, node.timestamp, node.source, node.side, node.namespace, node.metadata]),
    data.edges.map(edge => [edge.source, edge.target, edge.similarity]),
  ]);
  return `${data.stats.lastIndexed}:${stableHash(fingerprint)}`;
}

function nodeColor(node: GraphNode): string {
  if (node.kind === 'system') return MEMORY_COLORS.symbiote;
  if (node.kind === 'source') return MEMORY_COLORS.vdb;
  if (node.side === 'documents') return MEMORY_COLORS.knowledge;
  if (node.side === 'sessions') return MEMORY_COLORS.sessions;
  if (node.side === 'projects') return MEMORY_COLORS.projects;
  return MEMORY_COLORS.knowledge;
}

function buildGraph(data: MemoryGraphData, documents: MemoryGraphNode[]): GraphData<GraphNode, GraphEdge> {
  const documentIds = new Set(documents.map(document => document.id));
  const similarityEdges = data.edges.filter(edge =>
    edge.source !== edge.target
      && documentIds.has(edge.source)
      && documentIds.has(edge.target)
      && Number.isFinite(edge.similarity)
      && edge.similarity >= 0.7
      && edge.similarity <= 1,
  ).sort((left, right) =>
    right.similarity - left.similarity || left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  );
  const sourceGroups = new Map<string, MemoryGraphNode[]>();
  for (const document of documents) {
    const key = `${document.side}\0${document.source}`;
    const group = sourceGroups.get(key) ?? [];
    group.push(document);
    sourceGroups.set(key, group);
  }

  const nodes: GraphNode[] = [];
  const links: GraphEdge[] = [];
  const addNode = (node: Omit<GraphNode, 'x' | 'y' | 'z'>, target: { x: number; y: number; z: number }, spread = 0) => {
    nodes.push({ ...node, ...target, ...initialPosition(node.id, target, spread) });
  };
  const addLink = (source: string, target: string, similarity: number, kind: GraphEdge['kind'], layoutDistance?: number) => {
    links.push({ source, target, similarity, kind, layoutDistance });
  };

  const rootPosition = { x: 0, y: 270, z: 0 };
  addNode({ id: 'system', label: 'SYMBIOTE', kind: 'system', side: 'system', val: 1.5, targetX: rootPosition.x, targetY: rootPosition.y, targetZ: rootPosition.z }, rootPosition);
  const sideLabels: Array<{ id: Exclude<Side, 'system'>; label: string; x: number }> = [
    { id: 'documents', label: 'KNOWLEDGE', x: -360 },
    { id: 'sessions', label: 'SESSIONS', x: 0 },
    { id: 'projects', label: 'PROJECTS', x: 360 },
  ];
  for (const side of sideLabels) {
    const groups = [...sourceGroups.entries()]
      .filter(([, group]) => group[0].side === side.id)
      .sort(([left], [right]) => left.localeCompare(right));
    if (!groups.length) continue;

    const domainPosition = { x: side.x, y: 130, z: 0 };
    const domainId = `domain:${side.id}`;
    addNode({ id: domainId, label: side.label, kind: 'domain', side: side.id, parentId: 'system', val: 0.8, targetX: domainPosition.x, targetY: domainPosition.y, targetZ: domainPosition.z }, domainPosition);
    addLink('system', domainId, 0.5, 'structure', 165);
    const columns = Math.ceil(Math.sqrt(groups.length));
    const rows = Math.ceil(groups.length / columns);
    groups.forEach(([, group], index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const sourcePosition = {
        x: side.x + (column - (columns - 1) / 2) * 300,
        y: -20,
        z: (row - (rows - 1) / 2) * 270,
      };
      const source = group[0].source;
      const hubId = `source:${encodeURIComponent(side.id)}:${encodeURIComponent(source)}`;
      const spread = Math.min(150, 18 + Math.sqrt(group.length) * 5);
      addNode({
        id: hubId,
        label: `${source.toUpperCase()} · ${group.length}`,
        kind: 'source',
        side: side.id,
        source,
        parentId: domainId,
        val: 0.75,
        documentCount: group.length,
        targetX: sourcePosition.x,
        targetY: sourcePosition.y,
        targetZ: sourcePosition.z,
      }, sourcePosition);
      addLink(domainId, hubId, 0.65, 'structure', 95);
      for (const document of group) {
        const documentPosition = initialPosition(document.id, sourcePosition, spread);
        addNode({
          id: document.id,
          label: document.label,
          kind: 'document',
          side: side.id,
          source: document.source,
          parentId: hubId,
          document,
          targetX: documentPosition.x,
          targetY: documentPosition.y,
          targetZ: documentPosition.z,
          val: document.storage === 'vdb' ? 0.24 : 0.18,
        }, documentPosition);
        addLink(hubId, document.id, 0.78, 'structure', Math.max(24, spread * 0.72));
      }
    });
  }

  const bestNeighbors = new Map<string, typeof similarityEdges>();
  for (const edge of similarityEdges) {
    for (const id of [edge.source, edge.target]) {
      const neighbors = bestNeighbors.get(id) ?? [];
      if (neighbors.length < 3) {
        neighbors.push(edge);
        bestNeighbors.set(id, neighbors);
      }
    }
  }
  const selectedEdges = new Map<string, (typeof similarityEdges)[number]>();
  for (const neighbors of bestNeighbors.values()) {
    for (const edge of neighbors) {
      const key = edge.source < edge.target ? `${edge.source}\0${edge.target}` : `${edge.target}\0${edge.source}`;
      const previous = selectedEdges.get(key);
      if (!previous || edge.similarity > previous.similarity) selectedEdges.set(key, edge);
    }
  }
  for (const edge of selectedEdges.values()) addLink(edge.source, edge.target, edge.similarity, 'similarity');
  return { nodes, links };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MemoryMap({ request, onSendNode }: { request: MemoryRequest; onSendNode: (context: MemoryNodeContext, question: string) => Promise<void> }) {
  const graphMountRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const visibleDocumentIdsRef = useRef(new Set<string>());
  const visibleNodeIdsRef = useRef(new Set<string>());
  const nodePositionsRef = useRef(new Map<string, { x: number; y: number; z: number }>());
  const pinnedPositionsRef = useRef(new Map<string, { x: number; y: number; z: number }>());
  const dataSignatureRef = useRef('');
  const didAutoFitRef = useRef(false);
  const hoverTimeoutRef = useRef<number | null>(null);
  const [data, setData] = useState<MemoryGraphData | null>(null);
  const [selected, setSelected] = useState<MemoryDocument | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [sendingNodeId, setSendingNodeId] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');

  const loadGraph = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const graph = await request<MemoryGraphData>('/api/memory/graph');
      const signature = graphSignature(graph);
      if (signature !== dataSignatureRef.current) {
        dataSignatureRef.current = signature;
        setData(graph);
      }
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !hoveredNodeRef.current && !selectedIdRef.current) void loadGraph();
    }, 45_000);
    return () => window.clearInterval(timer);
  }, [loadGraph]);

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data?.nodes ?? []) counts.set(node.source, (counts.get(node.source) ?? 0) + 1);
    return [...counts].sort(([left], [right]) => left.localeCompare(right));
  }, [data]);
  const queryLower = query.trim().toLowerCase();
  const shownDocuments = useMemo(() => (data?.nodes ?? []).filter(node =>
    (sourceFilter === 'all'
      || sourceFilter === `side:${node.side}`
      || sourceFilter === `source:${encodeURIComponent(node.source)}`)
    && (!queryLower || `${node.label} ${node.source} ${node.excerpt}`.toLowerCase().includes(queryLower)),
  ), [data, queryLower, sourceFilter]);
  const graphData = useMemo(() => data ? buildGraph(data, data.nodes) : null, [data]);
  const inspectedNode = hoveredNode ?? (selectedIdRef.current
    ? graphData?.nodes.find(node => node.id === selectedIdRef.current) ?? null
    : null);
  const similarityNeighbors = useMemo(() => {
    if (!inspectedNode?.document) return [];
    const documentsById = new Map((data?.nodes ?? []).map(node => [node.id, node]));
    return (graphData?.links ?? [])
      .filter(link => link.kind === 'similarity'
        && (endpointId(link.source) === inspectedNode.id || endpointId(link.target) === inspectedNode.id))
      .map(link => {
        const id = endpointId(link.source) === inspectedNode.id ? endpointId(link.target) : endpointId(link.source);
        const document = documentsById.get(id);
        return document ? {
          id,
          label: document.label,
          source: document.source,
          side: document.side,
          role: document.role,
          similarity: link.similarity,
        } : null;
      })
      .filter((neighbor): neighbor is NonNullable<typeof neighbor> => neighbor !== null)
      .sort((left, right) => right.similarity - left.similarity);
  }, [data, graphData, inspectedNode]);
  const similarityAverage = similarityNeighbors.length
    ? similarityNeighbors.reduce((sum, neighbor) => sum + neighbor.similarity, 0) / similarityNeighbors.length
    : 0;
  const inspectorDocument = inspectedNode?.document;
  const inspectorContext: MemoryNodeContext | null = inspectedNode ? {
    selected: {
      id: inspectedNode.id,
      label: inspectedNode.label,
      kind: inspectedNode.kind,
      side: inspectedNode.side,
      source: inspectedNode.source,
      storage: inspectorDocument?.storage ?? data?.storage,
      role: inspectorDocument?.role,
      timestamp: inspectorDocument?.timestamp ?? data?.stats.lastIndexed,
      sessionId: inspectorDocument?.sessionId,
      namespace: inspectorDocument?.namespace,
      metadata: inspectorDocument?.metadata,
      excerpt: inspectorDocument?.excerpt ?? `${inspectedNode.documentCount ?? 0} documents in this ${inspectedNode.kind} location.`,
      text: selected?.id === inspectedNode.id ? selected.text : undefined,
      documentCount: inspectedNode.documentCount,
    },
    similarity: {
      threshold: 0.7,
      count: similarityNeighbors.length,
      average: similarityAverage,
      highest: similarityNeighbors[0]?.similarity ?? 0,
      neighbors: similarityNeighbors,
    },
  } : null;

  const selectNode = useCallback(async (node: GraphNode | null) => {
    if (!node?.document) {
      setSelected(null);
      selectedIdRef.current = null;
      graphRef.current?.refresh();
      return;
    }
    try {
      const document = await request<MemoryDocument>(`/api/memory/documents/${encodeURIComponent(node.id)}`);
      setSelected(document);
      selectedIdRef.current = node.id;
      graphRef.current?.refresh();
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load this memory document.');
    }
  }, [request]);

  const submitQuestion = async () => {
    if (!inspectorContext || !inspectedNode || !question.trim() || sendingNodeId) return;
    setSendingNodeId(inspectedNode.id);
    setSendError('');
    try {
      await onSendNode(inspectorContext, question.trim());
      setQuestion('');
      setQuestionOpen(false);
    } catch (failure) {
      setSendError(failure instanceof Error ? failure.message : 'The memory question could not be sent.');
    } finally {
      setSendingNodeId(null);
    }
  };

  const focusNeighbor = (id: string) => {
    const node = graphData?.nodes.find(candidate => candidate.id === id);
    if (!node) return;
    focusedIdRef.current = node.id;
    hoveredNodeRef.current = node;
    setHoveredNode(node);
    setInspectorCollapsed(false);
    setQuestionOpen(false);
    void selectNode(node);
    const point = { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 };
    graphRef.current?.cameraPosition({ x: point.x, y: point.y, z: point.z + 120 }, point, 500);
  };

  useEffect(() => {
    const mount = graphMountRef.current;
    if (!mount) return;

    const graph = new ForceGraph3D(mount, {
      controlType: 'orbit',
      rendererConfig: { antialias: true, alpha: true, preserveDrawingBuffer: true },
    }) as unknown as GraphInstance;
    const sphereGeometry = new THREE.SphereGeometry(1, 8, 8);
    const materials = new Map(
      Object.values(MEMORY_COLORS).map(color => [color, new THREE.MeshStandardMaterial({ color, roughness: 0.68 })]),
    );
    const linkMaterials = new Map<string, THREE.LineBasicMaterial>();
    const getLinkMaterial = (link: GraphEdge) => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--appearance-icon').trim() || MEMORY_COLORS.knowledge;
      const focusedId = focusedIdRef.current ?? selectedIdRef.current;
      const focused = !!focusedId && (endpointId(link.source) === focusedId || endpointId(link.target) === focusedId);
      const key = `${color}:${focused ? 'focus' : 'context'}`;
      let material = linkMaterials.get(key);
      if (!material) {
        material = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: focused ? 0.82 : 0.1,
          depthWrite: false,
        });
        linkMaterials.set(key, material);
      }
      return material;
    };
    graphRef.current = graph;
    graph
      .backgroundColor(graphBackgroundColor(getComputedStyle(mount.parentElement ?? mount).backgroundColor) || '#f8f7f2')
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel(node => `${node.label} · ${node.source ?? node.kind} · ${node.side}`)
      .nodeColor(node => nodeColor(node))
      .nodeVal(node => node.val)
      .nodeRelSize(3)
      .nodeResolution(8)
      .nodeVisibility(node => visibleNodeIdsRef.current.has(node.id))
      .nodeThreeObject(node => {
        const material = materials.get(nodeColor(node));
        if (!material) throw new Error(`Missing memory graph material for ${nodeColor(node)}.`);
        const mesh = new THREE.Mesh(sphereGeometry, material);
        mesh.scale.setScalar(3 * Math.cbrt(node.val));
        return mesh;
      })
      .linkSource('source')
      .linkTarget('target')
      .linkVisibility(link => {
        if (!visibleNodeIdsRef.current.has(endpointId(link.source)) || !visibleNodeIdsRef.current.has(endpointId(link.target))) return false;
        const focusId = focusedIdRef.current ?? selectedIdRef.current;
        const source = typeof link.source === 'object' ? link.source : null;
        const target = typeof link.target === 'object' ? link.target : null;
        const documentLink = source?.kind === 'document' || target?.kind === 'document';
        if (documentLink) return !!focusId && (endpointId(link.source) === focusId || endpointId(link.target) === focusId);
        if (link.kind === 'similarity') return !!focusId && (endpointId(link.source) === focusId || endpointId(link.target) === focusId);
        return true;
      })
      .linkMaterial(getLinkMaterial)
      .linkWidth(link => {
        const focusedId = focusedIdRef.current ?? selectedIdRef.current;
        return focusedId && (endpointId(link.source) === focusedId || endpointId(link.target) === focusedId) ? 1 : 0.5;
      })
      .linkResolution(4)
      .cooldownTicks(140)
      .cooldownTime(1200)
      .d3AlphaDecay(0.055)
      .d3VelocityDecay(0.42)
      .onNodeHover(node => {
        if (hoverTimeoutRef.current !== null) {
          window.clearTimeout(hoverTimeoutRef.current);
          hoverTimeoutRef.current = null;
        }
        focusedIdRef.current = node?.id ?? null;
        if (node) {
          hoveredNodeRef.current = node;
          setHoveredNode(node);
          setInspectorCollapsed(false);
        }
        else {
          hoverTimeoutRef.current = window.setTimeout(() => {
            hoveredNodeRef.current = null;
            setHoveredNode(selectedIdRef.current
              ? graph.graphData().nodes.find(candidate => candidate.id === selectedIdRef.current) ?? null
              : null);
            hoverTimeoutRef.current = null;
          }, 300);
        }
        graph.refresh();
      })
      .onNodeClick((node, event) => {
        focusedIdRef.current = node.id;
        hoveredNodeRef.current = node;
        setHoveredNode(node);
        if (event.detail > 1) {
          const point = { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 };
          graph.cameraPosition({ x: point.x, y: point.y, z: point.z + 120 }, point, 500);
        }
        void selectNode(node);
      })
      .onNodeDragEnd(node => {
        if (typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') return;
        const position = { x: node.x, y: node.y, z: node.z };
        node.targetX = node.x;
        node.targetY = node.y;
        node.targetZ = node.z;
        node.fx = node.x;
        node.fy = node.y;
        node.fz = node.z;
        nodePositionsRef.current.set(node.id, position);
        pinnedPositionsRef.current.set(node.id, position);
      })
      .onBackgroundClick(() => {
        focusedIdRef.current = null;
        hoveredNodeRef.current = null;
        void selectNode(null);
        setHoveredNode(null);
        graph.refresh();
      })
      .onEngineStop(() => {
        if (!didAutoFitRef.current) {
          didAutoFitRef.current = true;
          graph.zoomToFit(400, 36);
        }
      });

    graph.d3Force('link')
      ?.distance((link: GraphEdge) => link.kind === 'similarity' ? (1 - link.similarity) * 120 : link.layoutDistance ?? 80)
      .strength((link: GraphEdge) => link.kind === 'similarity' ? link.similarity ** 2 : 0.14);
    graph.d3Force('charge')?.strength(-120).distanceMax(280);
    graph.d3Force('center')?.strength(0.012);
    graph.d3Force('collide', forceCollide<GraphNode>(node => node.kind === 'document' ? 4.5 : node.val * 5 + 4).strength(0.72).iterations(1));
    graph.d3Force('x', forceX<GraphNode>(node => node.targetX).strength(0.075));
    graph.d3Force('y', forceY<GraphNode>(node => node.targetY).strength(0.075));
    graph.d3Force('z', forceZ<GraphNode>(node => node.targetZ).strength(0.075));

    const resize = () => {
      const bounds = mount.getBoundingClientRect();
      graph.width(Math.max(1, Math.floor(bounds.width)));
      graph.height(Math.max(1, Math.floor(bounds.height)));
      if (didAutoFitRef.current) graph.zoomToFit(250, 36, node => visibleNodeIdsRef.current.has(node.id));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    window.addEventListener('resize', resize);
    graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    resize();
    const syncAppearance = () => {
      const background = getComputedStyle(mount.parentElement ?? mount).backgroundColor;
      const secondary = getComputedStyle(document.documentElement).getPropertyValue('--appearance-icon').trim() || MEMORY_COLORS.knowledge;
      graph.backgroundColor(graphBackgroundColor(background) || '#f8f7f2');
      for (const material of linkMaterials.values()) material.color.set(secondary);
      graph.refresh();
    };
    const appearanceObserver = new MutationObserver(syncAppearance);
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });

    return () => {
      observer.disconnect();
      appearanceObserver.disconnect();
      window.removeEventListener('resize', resize);
      if (hoverTimeoutRef.current !== null) window.clearTimeout(hoverTimeoutRef.current);
      sphereGeometry.dispose();
      for (const material of materials.values()) material.dispose();
      for (const material of linkMaterials.values()) material.dispose();
      graph._destructor();
      graphRef.current = null;
    };
  }, [selectNode]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    visibleDocumentIdsRef.current = new Set(shownDocuments.map(node => node.id));
    const visibleIds = new Set<string>();
    const nodesById = new Map((graphData?.nodes ?? []).map(node => [node.id, node]));
    const scopedView = sourceFilter !== 'all' || queryLower.length > 0;
    for (const id of visibleDocumentIdsRef.current) {
      let current = nodesById.get(id);
      while (current && !visibleIds.has(current.id)) {
        if (!scopedView || (current.kind !== 'system' && current.kind !== 'domain')) visibleIds.add(current.id);
        current = current.parentId ? nodesById.get(current.parentId) : undefined;
      }
    }
    visibleNodeIdsRef.current = visibleIds;
    if (hoveredNodeRef.current && !visibleIds.has(hoveredNodeRef.current.id)) {
      focusedIdRef.current = null;
      hoveredNodeRef.current = null;
      setHoveredNode(null);
    }
    if (selectedIdRef.current && !visibleIds.has(selectedIdRef.current)) {
      selectedIdRef.current = null;
      setSelected(null);
    }
    const positions = nodePositionsRef.current;
    for (const node of graph.graphData().nodes) {
      if (typeof node.x === 'number' && Number.isFinite(node.x)
        && typeof node.y === 'number' && Number.isFinite(node.y)
        && typeof node.z === 'number' && Number.isFinite(node.z)) {
        positions.set(node.id, { x: node.x, y: node.y, z: node.z });
      }
    }
    const visibleNodes = (graphData?.nodes ?? [])
      .filter(node => visibleIds.has(node.id))
      .map(node => {
        const pinned = pinnedPositionsRef.current.get(node.id);
        const previous = scopedView ? undefined : positions.get(node.id);
        if (pinned) return { ...node, ...pinned, fx: pinned.x, fy: pinned.y, fz: pinned.z };
        return previous ? { ...node, ...previous } : node;
      });
    const visibleLinks = (graphData?.links ?? []).filter(link =>
      visibleIds.has(endpointId(link.source)) && visibleIds.has(endpointId(link.target)),
    );
    for (const node of visibleNodes) {
      if (typeof node.x === 'number' && Number.isFinite(node.x)
        && typeof node.y === 'number' && Number.isFinite(node.y)
        && typeof node.z === 'number' && Number.isFinite(node.z)) {
        positions.set(node.id, { x: node.x, y: node.y, z: node.z });
      }
    }
    didAutoFitRef.current = true;
    graph.graphData({ nodes: visibleNodes, links: visibleLinks });
    const frame = window.requestAnimationFrame(() => {
      if (visibleIds.size) graph.zoomToFit(320, 44, node => visibleIds.has(node.id));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shownDocuments, graphData, sourceFilter, queryLower]);

  const resetMap = () => {
    didAutoFitRef.current = true;
    graphRef.current?.zoomToFit(400, 36, node => visibleNodeIdsRef.current.has(node.id));
  };

  const updateZoom = (factor: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    const camera = graph.cameraPosition();
    graph.cameraPosition({
      x: camera.x * factor,
      y: camera.y * factor,
      z: camera.z * factor,
    }, undefined, 250);
  };

  const saveImage = () => {
    const canvas = graphRef.current?.renderer().domElement;
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
      window.document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };

  const stats = data?.stats;
  const sessionCount = data?.nodes.filter(node => node.side === 'sessions').length ?? 0;
  const projectCount = data?.nodes.filter(node => node.side === 'projects').length ?? 0;
  const documentCount = data?.nodes.length ? data.nodes.length - sessionCount - projectCount : 0;

  return (
    <div className="page memory-page">
      <header className="memory-heading">
        <div><div className="eyebrow">PERSISTENT KNOWLEDGE · LIVE SIMILARITY</div><h1>Memory map</h1><p>Indexed from {data?.storage ?? '.vdb/'} · Explore knowledge, sessions, and project memory in three dimensions.</p></div>
        <div className="memory-heading-actions">
          <button className="button button-secondary" type="button" onClick={() => void loadGraph(true)} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'memory-refresh-spin' : ''} />{refreshing ? 'Refreshing…' : 'Refresh index'}</button>
          <button className="button button-secondary memory-export" type="button" onClick={saveImage} disabled={!data?.nodes.length}><Download size={15} />Save as image</button>
        </div>
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
          <label className="memory-source-filter"><span className="sr-only">Filter by source</span><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)} aria-label="Filter memory graph"><option value="all">All sources</option><optgroup label="Memory locations"><option value="side:documents">Knowledge</option><option value="side:sessions">Sessions</option><option value="side:projects">Projects</option></optgroup><optgroup label="Exact VDB sources">{sources.map(([source, count]) => <option key={source} value={`source:${encodeURIComponent(source)}`}>{source} · {count.toLocaleString()}</option>)}</optgroup></select></label>
          <span className={`memory-refresh-label${refreshing ? ' is-refreshing' : ''}`}>{refreshing && <ActivityOrb label="Synchronizing memory" compact loading />}{refreshing ? 'SYNCING' : stats ? `${shownDocuments.length.toLocaleString()} / ${stats.documentCount.toLocaleString()} NODES` : loading ? 'INDEXING' : 'NO INDEX'}</span>
        </div>
        <div className="memory-map-shell">
          <div
            ref={graphMountRef}
            className="memory-graph3d"
            role="application"
            aria-label="Interactive three-dimensional similarity graph of indexed memory. Drag to rotate, scroll to zoom, and select a node to inspect its source."
          />
          {loading && <div className="memory-loading"><ActivityOrb label="Loading indexed knowledge" loading /><span>Loading indexed knowledge…</span></div>}
          {!loading && !data?.nodes.length && <div className="memory-empty">No indexed knowledge yet. Memory documents, sessions, and project files appear here as they are synchronized.</div>}
          {!loading && data?.nodes.length && !shownDocuments.length && <div className="memory-empty">No memory sources match this filter.</div>}
          {data?.nodes.length ? <div className="memory-zoom-controls">
            <button type="button" onClick={() => updateZoom(0.8)} aria-label="Zoom in"><Plus size={15} /></button>
            <button type="button" onClick={() => updateZoom(1.25)} aria-label="Zoom out"><Minus size={15} /></button>
            <button type="button" onClick={resetMap} aria-label="Fit map to view"><Maximize2 size={14} /></button>
          </div> : null}
          {inspectedNode && inspectorContext && (
            <aside
              className={`memory-inspector${inspectorCollapsed ? ' memory-inspector-collapsed' : ''}`}
              aria-label="Memory node details"
              aria-live="polite"
              onPointerEnter={() => {
                if (hoverTimeoutRef.current !== null) {
                  window.clearTimeout(hoverTimeoutRef.current);
                  hoverTimeoutRef.current = null;
                }
                focusedIdRef.current = inspectedNode.id;
                graphRef.current?.refresh();
              }}
              onPointerLeave={() => {
                focusedIdRef.current = null;
                graphRef.current?.refresh();
                if (hoverTimeoutRef.current !== null) window.clearTimeout(hoverTimeoutRef.current);
                hoverTimeoutRef.current = window.setTimeout(() => {
                  hoveredNodeRef.current = null;
                  setHoveredNode(selectedIdRef.current
                    ? graphRef.current?.graphData().nodes.find(node => node.id === selectedIdRef.current) ?? null
                    : null);
                  hoverTimeoutRef.current = null;
                }, 300);
              }}
            >
              <div className="memory-inspector-header">
                <button className="memory-inspector-title" type="button" onClick={() => setInspectorCollapsed(collapsed => !collapsed)} aria-expanded={!inspectorCollapsed} aria-label={inspectorCollapsed ? 'Expand memory details' : 'Collapse memory details'}>
                  <span className="memory-inspector-kicker">{inspectedNode.kind} · {inspectedNode.side}</span>
                  <strong>{inspectedNode.label}</strong>
                  <ChevronDown size={15} />
                </button>
                <button className="memory-inspector-help" type="button" aria-label={questionOpen ? 'Close memory question' : 'Ask the agent about this node'} aria-expanded={questionOpen} onClick={() => { setInspectorCollapsed(false); setQuestionOpen(open => !open); }}><CircleHelp size={16} /></button>
              </div>
              {!inspectorCollapsed && (
                <div className="memory-inspector-body">
                  <div className="memory-inspector-facts">
                    <div><span>SOURCE</span><strong>{inspectedNode.source ?? 'Symbiote'}</strong></div>
                    <div><span>STORAGE</span><strong>{inspectorDocument?.storage ?? (inspectedNode.kind === 'source' ? 'VDB source' : data?.storage ?? 'Graph')}</strong></div>
                    {inspectedNode.documentCount !== undefined && <div><span>DOCUMENTS</span><strong>{inspectedNode.documentCount.toLocaleString()}</strong></div>}
                    {inspectorDocument?.role && <div><span>ROLE</span><strong>{inspectorDocument.role}</strong></div>}
                    {inspectorDocument?.timestamp && <div><span>INDEXED</span><strong>{new Date(inspectorDocument.timestamp).toLocaleString()}</strong></div>}
                    {inspectorDocument?.sessionId && <div><span>SESSION</span><strong>{inspectorDocument.sessionId}</strong></div>}
                    {inspectorDocument?.namespace && <div className="memory-inspector-fact-wide"><span>NAMESPACE</span><strong>{inspectorDocument.namespace}</strong></div>}
                  </div>
                  {(selected?.id === inspectedNode.id ? selected.text : inspectorDocument?.excerpt) && (
                    <p className="memory-inspector-excerpt">{selected?.id === inspectedNode.id ? selected.text : inspectorDocument?.excerpt}</p>
                  )}
                  {similarityNeighbors.length > 0 && (
                    <section className="memory-similarity-analysis" aria-label="Programmatic similarity analysis">
                      <header><strong>Semantic similarities</strong><span>TF–IDF cosine · threshold 70%</span></header>
                      <div className="memory-similarity-metrics">
                        <div><span>MATCHES</span><strong>{similarityNeighbors.length}</strong></div>
                        <div><span>AVERAGE</span><strong>{(similarityAverage * 100).toFixed(1)}%</strong></div>
                        <div><span>STRONGEST</span><strong>{(similarityNeighbors[0].similarity * 100).toFixed(1)}%</strong></div>
                      </div>
                      <div className="memory-similarity-list">
                        {similarityNeighbors.map((neighbor, index) => <button type="button" key={neighbor.id} onClick={() => focusNeighbor(neighbor.id)}>
                          <span className="memory-similarity-rank">{String(index + 1).padStart(2, '0')}</span>
                          <span className="memory-similarity-copy"><strong>{neighbor.label}</strong><small>{neighbor.source} · {neighbor.side} · {neighbor.role}</small></span>
                          <b>{(neighbor.similarity * 100).toFixed(1)}%</b>
                        </button>)}
                      </div>
                    </section>
                  )}
                  {inspectorDocument?.metadata && Object.keys(inspectorDocument.metadata).length > 0 && (
                    <section className="memory-inspector-metadata"><span>DOCUMENT METADATA</span>
                      {Object.entries(inspectorDocument.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                    </section>
                  )}
                  {questionOpen && <form className="memory-question-form" onSubmit={event => { event.preventDefault(); void submitQuestion(); }}>
                    <input value={question} onChange={event => setQuestion(event.target.value)} aria-label="Question for the agent" placeholder="Ask about this memory…" autoFocus />
                    <button type="submit" aria-label="Send memory question" title="Send" disabled={!question.trim() || sendingNodeId !== null}><Send size={15} /></button>
                  </form>}
                  {sendError && <div className="memory-node-error" role="alert">{sendError}</div>}
                </div>
              )}
            </aside>
          )}
        </div>
        <div className="memory-card-footer"><span><i className="memory-live-dot" />Shared VDB · updates when idle every 45 seconds</span><span>Drag to rotate · Scroll to zoom · Drag a node to pin it</span></div>
      </section>
    </div>
  );
}

export default MemoryMap;
