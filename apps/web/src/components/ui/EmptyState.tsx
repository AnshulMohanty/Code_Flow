interface EmptyStateProps {
  title: string;
  message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="state-box">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
