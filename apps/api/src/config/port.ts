/**
 * Which port the API binds, and where that number came from.
 *
 * Render, Railway, Fly and Heroku all assign the port at boot and pass it as `PORT`; a service
 * that ignores it binds somewhere the platform's proxy is not looking and is marked unhealthy with
 * no useful error. `API_PORT` stays the explicit operator choice for a self-hosted deployment, and
 * it WINS: someone who set it meant it, and honouring `PORT` over it would silently change an
 * existing deployment.
 *
 * That makes "both set" a real misconfiguration rather than a preference — on a managed host it
 * means the platform's port is being ignored — so it is reported rather than resolved quietly.
 * `NaN` is the failure this replaces: `Number(process.env.API_PORT || 4000)` on a typo produced
 * `NaN`, and `listen(NaN)` binds a RANDOM free port, which looks like it worked.
 */
export interface PortResolution {
  readonly port: number;
  readonly source: "explicit" | "platform" | "default";
  /** Human-readable problems: an unusable value that was skipped, or an ignored platform port. */
  readonly warnings: readonly string[];
}

const MIN_PORT = 1;
const MAX_PORT = 65_535;

function readPort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // `Number` accepts "1e3", " 12 " and "0x50"; a port is decimal digits and nothing else.
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_PORT && value <= MAX_PORT ? value : null;
}

export interface ResolvePortInput {
  /** The service's own variable — `API_PORT`. */
  readonly explicit: string | undefined;
  /** The platform-assigned `PORT`. */
  readonly platform: string | undefined;
  readonly fallback: number;
  /** Names used in the warnings, so the message says which variable to go and fix. */
  readonly explicitName: string;
}

export function resolvePort(input: ResolvePortInput): PortResolution {
  const warnings: string[] = [];
  const explicit = readPort(input.explicit);
  const platform = readPort(input.platform);

  if (input.explicit !== undefined && input.explicit.trim() !== "" && explicit === null) {
    warnings.push(
      `${input.explicitName}="${input.explicit}" is not a port between ${MIN_PORT} and ${MAX_PORT}; ignoring it.`,
    );
  }
  if (input.platform !== undefined && input.platform.trim() !== "" && platform === null) {
    warnings.push(`PORT="${input.platform}" is not a port between ${MIN_PORT} and ${MAX_PORT}; ignoring it.`);
  }

  if (explicit !== null) {
    if (platform !== null && platform !== explicit) {
      warnings.push(
        `${input.explicitName}=${explicit} overrides the platform-assigned PORT=${platform}. ` +
          `On a managed host (Render, Railway, Fly, Heroku) that binds a port the proxy is not ` +
          `routing to, and the service will be reported unhealthy — unset ${input.explicitName} there.`,
      );
    }
    return { port: explicit, source: "explicit", warnings };
  }
  if (platform !== null) {
    return { port: platform, source: "platform", warnings };
  }
  return { port: input.fallback, source: "default", warnings };
}
