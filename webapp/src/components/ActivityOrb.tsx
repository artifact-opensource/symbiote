import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { getLoadingOrbState } from './activity-orb-state';

interface ActivityOrbProps {
  label: string;
  state?: OrbState;
  compact?: boolean;
  loading?: boolean;
}

export default function ActivityOrb({ label, state = 'working', compact = false, loading = false }: ActivityOrbProps) {
  return (
    <ThinkingOrb
      state={loading ? getLoadingOrbState() : state}
      size={20}
      role="img"
      aria-label={label}
      className={`activity-orb${compact ? ' activity-orb-compact' : ''}`}
      style={compact ? { width: 14, height: 14 } : undefined}
    />
  );
}
