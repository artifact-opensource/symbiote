import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, Satellite, Layers, Maximize2, Minus, Plus } from 'lucide-react';
import ActivityOrb from './ActivityOrb';

type LayerMode = 'dark' | 'satellite' | 'terrain';

interface Marker { id: string; lat: number; lng: number; label?: string; color?: string; }

/** Mercator projection — standard for web maps, preserves local shapes. */
function mercatorX(lng: number): number { return lng * Math.PI / 180; }
function mercatorY(lat: number): number {
  const s = Math.sin(lat * Math.PI / 180);
  return Math.log((1 + s) / (1 - s)) / 2;
}

/** Convert lat/lng to pixel coords at current zoom. */
function latLngToPixel(lat: number, lng: number, zoom: number): [number, number] {
  const x = mercatorX(lng);
  const y = mercatorY(lat);
  return [
    (x * Math.pow(2, zoom)) / (2 * Math.PI),
    ((Math.PI - y) * Math.pow(2, zoom)) / (2 * Math.PI),
  ];
}

const TILE_SIZE = 256;
const TILE_URLS = {
  dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  terrain: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
};

export default function IntelligenceMap({ markers }: {
  markers: Marker[];
  onSelectMarker: (m: Marker) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<LayerMode>('dark');
  const [zoom, setZoom] = useState(2);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loadingTiles, setLoadingTiles] = useState(false);

  const stateRef = useRef({ zoom, offset, mode });
  stateRef.current = { zoom, offset, mode };

  const tileCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const tileLoading = useRef<Set<string>>(new Set());

  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const getTileUrl = useCallback((z: number, x: number, y: number) =>
    TILE_URLS[stateRef.current.mode].replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), []);

  const loadTile = useCallback((z: number, x: number, y: number) => {
    const key = `${z}/${x}/${y}`;
    if (tileCache.current.has(key) || tileLoading.current.has(key)) return;
    tileLoading.current.add(key);
    setLoadingTiles(true);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = getTileUrl(z, x, y);
    img.onload = () => {
      tileCache.current.set(key, img);
      tileLoading.current.delete(key);
      setLoadingTiles(false);
      draw();
    };
    img.onerror = () => {
      tileLoading.current.delete(key);
      setLoadingTiles(false);
    };
  }, [getTileUrl]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const container = containerRef.current;
    const cw = container?.clientWidth ?? canvas.width / dpr;
    const ch = container?.clientHeight ?? canvas.height / dpr;

    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    ctx.scale(dpr, dpr);

    const { zoom: z, offset: off } = stateRef.current;

    // Background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, cw, ch);

    const baseScale = TILE_SIZE * Math.pow(2, z);
    const baseOffsetX = cw / 2 + off.x;
    const baseOffsetY = ch / 2 + off.y;

    // Visible tile range
    const topLeft = latLngToPixel(85.0511, -180, z);
    const bottomRight = latLngToPixel(-85.0511, 180, z);

    const startCol = Math.floor((topLeft[0] * cw / baseScale) / TILE_SIZE);
    const endCol = Math.ceil((bottomRight[0] * cw / baseScale) / TILE_SIZE);
    const startRow = Math.floor((topLeft[1] * ch / baseScale) / TILE_SIZE);
    const endRow = Math.ceil((bottomRight[1] * ch / baseScale) / TILE_SIZE);

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const tx = col * TILE_SIZE;
        const ty = row * TILE_SIZE;
        const screenX = tx - (off.x % TILE_SIZE + TILE_SIZE) % TILE_SIZE;
        const screenY = ty - (off.y % TILE_SIZE + TILE_SIZE) % TILE_SIZE;
        if (screenX < -TILE_SIZE || screenX > cw || screenY < -TILE_SIZE || screenY > ch) continue;

        const key = `${z}/${col}/${row}`;
        const cached = tileCache.current.get(key);
        if (cached && cached.complete && cached.naturalWidth > 0) {
          ctx.drawImage(cached, screenX, screenY, TILE_SIZE, TILE_SIZE);
        } else if (!cached) {
          loadTile(z, col, row);
        }
      }
    }

    // Draw markers
    for (const marker of markers) {
      const [mx, my] = latLngToPixel(marker.lat, marker.lng, z);
      const px = mx * cw / baseScale + baseOffsetX;
      const py = my * ch / baseScale + baseOffsetY;
      if (px < 0 || px > cw || py < 0 || py > ch) continue;

      // Pulse ring
      const pulseR = 8 + Math.sin(Date.now() / 400 + marker.id.charCodeAt(0)) * 2;
      ctx.beginPath();
      ctx.arc(px, py, pulseR, 0, Math.PI * 2);
      ctx.fillStyle = marker.color ?? (hoveredId === marker.id ? 'rgba(255,215,0,0.4)' : 'rgba(255,69,0,0.3)');
      ctx.fill();

      // Pin body
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = marker.color ?? '#ff4500';
      ctx.fill();
      ctx.strokeStyle = hoveredId === marker.id ? '#ffd700' : 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Label
      if (marker.label) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 3;
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.strokeText(marker.label, px, py + 10);
        ctx.fillText(marker.label, px, py + 10);
      }
    }
  }, [markers, hoveredId, loadTile]);

  // Redraw loop
  useEffect(() => {
    draw();
    const raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  const handlePointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const dragStart = dragStartRef.current;
    if (dragging && dragStart) {
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;
      setOffset(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY,
      }));
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    } else {
      const { zoom: z } = stateRef.current;
      const hit = findMarkerAt(mx, my, z, rect);
      setHoveredId(hit?.id ?? null);
      canvasRef.current!.style.cursor = hit ? 'pointer' : 'grab';
    }
  };

  const handlePointerUp = () => {
    setDragging(false);
    dragStartRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setZoom(prev => Math.max(0, Math.min(8, prev + delta)));
  };

  const findMarkerAt = (mx: number, my: number, z: number, rect: DOMRect): Marker | null => {
    const { offset: off } = stateRef.current;
    const baseScale = TILE_SIZE * Math.pow(2, z);
    const baseOffsetX = rect.width / 2 + off.x;
    const baseOffsetY = rect.height / 2 + off.y;

    for (const m of markers) {
      const [px, py] = latLngToPixel(m.lat, m.lng, z);
      const screenX = px * rect.width / baseScale + baseOffsetX;
      const screenY = py * rect.height / baseScale + baseOffsetY;
      const dx = mx - screenX;
      const dy = my - screenY;
      if (dx * dx + dy * dy < 100) return m;
    }
    return null;
  };

  const resetView = () => {
    setZoom(2);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="intelligence-map-container">
      <div ref={containerRef} className="intelligence-map-canvas-wrap" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#0a0a0f' }}>
        <canvas
          ref={canvasRef}
          className="intelligence-map-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          style={{ touchAction: 'none', cursor: 'grab', width: '100%', height: '100%' }}
        />
        {loadingTiles && (
          <div className="intelligence-map-loading">
            <ActivityOrb label="Rendering map layers" compact loading />
            <span>Loading tiles…</span>
          </div>
        )}
        <div className="intelligence-map-overlay">
          <button className="intelligence-map-btn" onClick={resetView} title="Reset view"><Maximize2 size={14} /></button>
          <div className="intelligence-map-info">
            <span><Layers size={13} />{mode.toUpperCase()} · Z{zoom}</span>
            <span>{markers.length} markers</span>
          </div>
        </div>
      </div>
      <div className="intelligence-map-controls">
        <div className="intelligence-map-layer-switch">
          <button className={`intelligence-map-layer ${mode === 'dark' ? 'active' : ''}`} onClick={() => { setMode('dark'); }}><Layers size={14} /></button>
          <button className={`intelligence-map-layer ${mode === 'satellite' ? 'active' : ''}`} onClick={() => { setMode('satellite'); }}><Satellite size={14} /></button>
          <button className={`intelligence-map-layer ${mode === 'terrain' ? 'active' : ''}`} onClick={() => { setMode('terrain'); }}><MapPin size={14} /></button>
        </div>
        <div className="intelligence-map-zoom">
          <button className="intelligence-map-zoom-btn" onClick={() => setZoom(z => Math.max(0, z - 1))}><Minus size={14} /></button>
          <button className="intelligence-map-zoom-btn" onClick={() => setZoom(z => Math.min(8, z + 1))}><Plus size={14} /></button>
        </div>
      </div>
    </div>
  );
}
