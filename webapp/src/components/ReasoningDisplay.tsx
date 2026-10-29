import ActivityOrb from './ActivityOrb';
import { getActivityLabel, getActivityOrbState, type AgentActivity } from './activity-orb-state';

interface ReasoningDisplayProps {
  activity: AgentActivity;
  toolLabel?: string;
  compact?: boolean;
}

export default function ReasoningDisplay({ activity, compact = false }: ReasoningDisplayProps) {
  const label = getActivityLabel(activity);
  return (
    <div className={`message-live-activity${compact ? ' message-live-activity-compact' : ''}`} role="status" aria-live="polite">
      <ActivityOrb state={getActivityOrbState(activity)} label={label} compact />
      <span>{label}</span>
    </div>
  );
}
