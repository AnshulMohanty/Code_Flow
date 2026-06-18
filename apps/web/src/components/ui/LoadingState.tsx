interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = "Preparing CodeFlow workspace..." }: LoadingStateProps) {
  return (
    <div className="state-box">
      <div className="loading-dot" />
      <p>{message}</p>
    </div>
  );
}
