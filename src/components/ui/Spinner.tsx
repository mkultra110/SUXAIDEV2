interface SpinnerProps {
  size?: number;
  color?: string;
}

export function Spinner({ size = 16, color = 'currentColor' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        borderTopColor: 'transparent',
        display: 'inline-block',
        animation: 'suxai-spin 0.7s linear infinite',
        opacity: 0.9,
      }}
    />
  );
}
