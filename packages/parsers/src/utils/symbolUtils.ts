export function isPascalCase(name: string) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

export function isReactHookName(name: string) {
  return /^use[A-Z][A-Za-z0-9]*$/.test(name);
}

export function uniquePush<T>(items: T[], item: T, key: (value: T) => string) {
  if (!items.some((existing) => key(existing) === key(item))) {
    items.push(item);
  }
}
