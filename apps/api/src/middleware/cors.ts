import type { NextFunction, Request, Response } from "express";

/**
 * Minimal, origin-reflecting CORS for the browser SPA (REST + the SSE progress stream).
 *
 * - Development (NODE_ENV !== "production"): allow any origin served on the Vite web dev port
 *   (default 5173, override via WEB_PORT). This covers the Vite `Local` origin
 *   (http://localhost:5173) AND the `Network` origins it also binds (LAN IPs on the same port)
 *   without hardcoding machine-specific addresses.
 * - Production: allow ONLY the explicit comma-separated allowlist in CORS_ORIGINS. No wildcard.
 *
 * The matched Origin is reflected exactly (never "*") with `Vary: Origin`, and OPTIONS preflight
 * is answered 204. Requests without an Origin header (same-origin, curl, the test suite) pass
 * through untouched, so this is a no-op for them.
 */
export function createCorsMiddleware() {
  const isProd = process.env.NODE_ENV === "production";
  const allowlist = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // `||` (not `??`): an empty WEB_PORT (present-but-blank in .env) must fall back to the default.
  const devWebPort = (process.env.WEB_PORT || "5173").trim();

  function isAllowed(origin: string): boolean {
    if (allowlist.includes(origin)) return true;
    if (isProd) return false;
    try {
      return new URL(origin).port === devWebPort;
    } catch {
      return false;
    }
  }

  return function cors(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin;
    if (origin && isAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      // Answer the browser's preflight for an allowed origin; non-allowed OPTIONS falls through.
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
    }
    next();
  };
}
