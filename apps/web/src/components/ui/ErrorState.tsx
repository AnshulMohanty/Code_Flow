interface ErrorStateProps {
  title?: string;
  message: string;
}

export function ErrorState({ title = "Something needs attention", message }: ErrorStateProps) {
  return (
    <div className="state-box state-error">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
