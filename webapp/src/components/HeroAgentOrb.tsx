import { ThinkingOrb } from 'thinking-orbs';
import { getActivityLabel, getActivityOrbState, type AgentActivity } from './activity-orb-state';

interface HeroAgentOrbProps {
  x: number;
  y: number;
  activity: AgentActivity;
}

const ORB_SIZE = 64;
const ORB_VIEWBOX_SIZE = 124;

export default function HeroAgentOrb({ x, y, activity }: HeroAgentOrbProps) {
  const idle = activity === 'listening';
  return (
    <foreignObject
      x={x - ORB_VIEWBOX_SIZE / 2}
      y={y - ORB_VIEWBOX_SIZE / 2}
      width={ORB_VIEWBOX_SIZE}
      height={ORB_VIEWBOX_SIZE}
    >
      <div className="hero-agent-orb">
        <ThinkingOrb
          state={idle ? 'breathing' : getActivityOrbState(activity)}
          size={ORB_SIZE}
          aria-label={`Symbiote ${idle ? 'idle' : getActivityLabel(activity)}`}
          style={{ width: ORB_VIEWBOX_SIZE, height: ORB_VIEWBOX_SIZE }}
        />
      </div>
    </foreignObject>
  );
}
