import { ThinkingOrb } from 'thinking-orbs';
import { getActivityLabel, getActivityOrbState, type AgentActivity } from './activity-orb-state';

interface HeroAgentOrbProps {
  x: number;
  y: number;
  activity: AgentActivity;
}

export default function HeroAgentOrb({ x, y, activity }: HeroAgentOrbProps) {
  return (
    <foreignObject x={x - 32} y={y - 32} width={64} height={64}>
      <div className="hero-agent-orb">
        <ThinkingOrb
          state={getActivityOrbState(activity)}
          size={64}
          aria-label={`Symbiote ${getActivityLabel(activity)}`}
        />
      </div>
    </foreignObject>
  );
}
