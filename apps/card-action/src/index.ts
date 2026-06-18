export function createCardActionPlaceholder() {
  // TODO: Port the legacy card action from card/ after the shared analyzer package exists.
  return {
    service: "codeflow-card-action",
    status: "placeholder",
  } as const;
}
