export default function BrowserLoading({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <span
      className={`browser-loading${compact ? ' browser-loading-compact' : ''}`}
      role="img"
      aria-label={label}
    >
      <span className="browser-loading-track" />
      <span className="browser-loading-orbit"><i /></span>
      <span className="browser-loading-core" />
    </span>
  );
}
