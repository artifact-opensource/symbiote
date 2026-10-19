import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { getActivityLabel, getActivityOrbState, type AgentActivity } from './activity-orb-state';

interface HeroAgentOrbProps {
  x: number;
  y: number;
  activity: AgentActivity;
}

const ORB_SIZE = 64;
const INITIAL_ORB_VIEWBOX_SIZE = 124;

export default function HeroAgentOrb({ x, y, activity }: HeroAgentOrbProps) {
  const orbContainerRef = useRef<HTMLDivElement>(null);
  const [orbViewboxSize, setOrbViewboxSize] = useState(INITIAL_ORB_VIEWBOX_SIZE);
  const idle = activity === 'listening';

  useEffect(() => {
    const svg = orbContainerRef.current?.closest('svg');
    if (!(svg instanceof SVGSVGElement)) return;

    const updateSize = () => {
      const bounds = svg.getBoundingClientRect();
      const viewBox = svg.viewBox.baseVal;
      const scale = Math.min(bounds.width / viewBox.width, bounds.height / viewBox.height);
      if (scale <= 0) return;

      const nextSize = Math.ceil(ORB_SIZE / scale);
      setOrbViewboxSize(current => current === nextSize ? current : nextSize);
    };

    const observer = new ResizeObserver(updateSize);
    observer.observe(svg);
    updateSize();
    return () => observer.disconnect();
  }, []);

  return (
    <foreignObject
      x={x - orbViewboxSize / 2}
      y={y - orbViewboxSize / 2}
      width={orbViewboxSize}
      height={orbViewboxSize}
    >
      <div ref={orbContainerRef} className="hero-agent-orb">
        <ThinkingOrb
          state={idle ? 'searching' : getActivityOrbState(activity)}
          size={ORB_SIZE}
          aria-label={`Symbiote ${idle ? 'idle' : getActivityLabel(activity)}`}
          style={{ width: orbViewboxSize, height: orbViewboxSize }}
        />
      </div>
    </foreignObject>
  );
}
