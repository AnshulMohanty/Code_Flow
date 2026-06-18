// Runtime config — DEFAULT (empty) shipped in the build. The web container's entrypoint
// OVERWRITES this file at start from $API_BASE_URL, so one image works across environments.
// In dev, an empty config falls back to VITE_API_BASE_URL / the localhost default.
window.__CODEFLOW_CONFIG__ = {};
