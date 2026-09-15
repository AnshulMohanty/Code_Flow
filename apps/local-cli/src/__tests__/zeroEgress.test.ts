import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE ZERO-EGRESS GUARANTEE, CHECKED RATHER THAN ASSERTED.
 *
 * The README tells people to run `npx codeflow-local .` on a private repository. That is a promise
 * about where their source code goes, and a promise like that is worth exactly as much as the thing
 * that enforces it. A comment saying "no network" survives the refactor that adds one.
 *
 * WHAT THIS ACTUALLY PROVES. It walks the CLI's real transitive import graph — starting at
 * `src/index.ts` and following every relative and `@codeflow/*` edge into the workspace packages —
 * and fails if any reachable module imports a network capability or reads a provider key. It is a
 * SOURCE-graph check, which is the right level: the property is decided by what the code can reach,
 * not by what a particular bundle happened to include.
 *
 * WHAT IT DOES NOT PROVE, stated so nobody reads more into a green test than is there:
 *   - it cannot see a network call made through a Node builtin this list does not name;
 *   - it cannot see one made by `web-tree-sitter`, the one external runtime dependency (a WASM
 *     parser, which has no reason to open a socket, but "no reason to" is not "cannot");
 *   - it says nothing about what a future dependency might do.
 * It is a strong check on the code this project owns, which is the part this project can promise.
 */

/** `apps/local-cli/src` — this file lives in `src/__tests__`. */
const CLI_ROOT = path.resolve(__dirname, "..");
/** The monorepo root. Three levels up from `src`, not two — `src` -> `local-cli` -> `apps` -> root. */
const REPO_ROOT = path.resolve(CLI_ROOT, "../../..");
/** `apps/local-cli` — where package.json is. */
const PACKAGE_ROOT = path.resolve(CLI_ROOT, "..");

/** Node builtins that can reach a network, plus the fetch-shaped globals. */
const NETWORK_MODULES = [
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:dns",
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "undici",
  "node-fetch",
  "axios",
  "got",
  "ws",
];

/** Provider keys. A local CLI has no business reading one; if it can, it can also send one. */
const KEY_PATTERN = /process\.env\.[A-Z_]*(?:API_KEY|_TOKEN|SECRET)/;

/** `fetch(` / `new WebSocket(` / `XMLHttpRequest`, as CALLS rather than as the word in a comment. */
const NETWORK_CALL_PATTERN = /(?:^|[^.\w])(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/;

/**
 * Every `from "<specifier>"` in a file, INCLUDING multi-line imports.
 *
 * Anchoring this to `import` on the same line was the first version, and it matched almost nothing —
 * most imports in these packages span several lines — so the walk reached two files and every
 * assertion below passed vacuously. That is the failure the "reaches a real import graph" test
 * exists to catch, and it caught it.
 */
const IMPORT_SOURCE = /from\s+["']([^"']+)["']/g;

/** Workspace package name -> its source root. */
const WORKSPACE_ROOTS: Record<string, string> = {
  "@codeflow/analyzers": path.join(REPO_ROOT, "packages/analyzers/src"),
  "@codeflow/config": path.join(REPO_ROOT, "packages/config/src"),
  "@codeflow/graph": path.join(REPO_ROOT, "packages/graph/src"),
  "@codeflow/parsers": path.join(REPO_ROOT, "packages/parsers/src"),
  "@codeflow/retrieval": path.join(REPO_ROOT, "packages/retrieval/src"),
  "@codeflow/shared-types": path.join(REPO_ROOT, "packages/shared-types/src"),
};

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a specifier to a source file, or null when it is external / unresolvable. */
async function resolveSpecifier(fromFile: string, specifier: string): Promise<string | null> {
  if (specifier.startsWith(".")) {
    // TypeScript ESM writes `./x.js` and means `./x.ts`.
    const base = path.resolve(path.dirname(fromFile), specifier).replace(/\.js$/, "");
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (await exists(candidate)) return candidate;
    }
    return null;
  }
  const root = WORKSPACE_ROOTS[specifier];
  if (root) return path.join(root, "index.ts");
  return null;
}

/** Every module reachable from the CLI entrypoint, excluding tests. */
async function importGraph(): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [path.join(CLI_ROOT, "index.ts")];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    seen.set(file, source);

    // Every `from "..."` in the file. A pattern anchored to `import` on the SAME LINE misses every
    // multi-line import — which is most of them here, and made the first version of this walk reach
    // two files and pass vacuously. That is exactly what the "reaches a real import graph"
    // assertion below exists to catch.
    for (const match of source.matchAll(IMPORT_SOURCE)) {
      const resolved = await resolveSpecifier(file, match[1]);
      if (resolved && !resolved.includes("__tests__")) queue.push(resolved);
    }
    for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      const resolved = await resolveSpecifier(file, match[1]);
      if (resolved && !resolved.includes("__tests__")) queue.push(resolved);
    }
  }
  return seen;
}

describe("codeflow-local sends nothing anywhere", () => {
  it("reaches a real import graph at all (a check that finds nothing proves nothing)", async () => {
    const graph = await importGraph();
    // If resolution silently broke, every assertion below would pass vacuously. This is the guard
    // on the guard: the CLI genuinely pulls in the parser, graph and retrieval packages.
    expect(graph.size).toBeGreaterThan(20);
    const files = [...graph.keys()].join("|").split(path.sep).join("/");
    expect(files).toMatch(/packages\/parsers\/src/);
    expect(files).toMatch(/packages\/graph\/src/);
    expect(files).toMatch(/packages\/retrieval\/src/);
  });

  it("imports NO network module anywhere in that graph", async () => {
    const offenders: string[] = [];
    for (const [file, source] of await importGraph()) {
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (NETWORK_MODULES.includes(match[1])) {
          offenders.push(`${path.relative(REPO_ROOT, file)} imports ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches EXACTLY two fetch-capable modules, both via the analyzers barrel, and no others", async () => {
    /**
     * THIS TEST DOCUMENTS A CORRECTION.
     *
     * `analyzeLocal.ts` used to claim there was "no HTTP client, no socket and no provider key
     * anywhere in this module's import graph". That was not true, and this check is what found it:
     * the CLI imports `@codeflow/analyzers` for the pipeline stages, and that package's BARREL
     * re-exports `llmClient.ts` and `embeddingClient.ts`, both of which call `fetch`.
     *
     * Nothing was leaking — see the two tests below, which are the ones that matter — but the claim
     * was stronger than the evidence, which on a privacy guarantee is the wrong direction to be
     * wrong in. The honest statement is: two fetch-capable modules are REACHABLE through a barrel,
     * the CLI never references anything in them, and the shipped bundle contains neither.
     *
     * Pinned as an exact list rather than an allowance, so a THIRD one cannot appear quietly.
     */
    const offenders: string[] = [];
    for (const [file, source] of await importGraph()) {
      // Comments stripped first: several of these modules discuss fetch at length in their header
      // notes, and a check that trips on prose is a check people delete.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
      if (NETWORK_CALL_PATTERN.test(code)) {
        offenders.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
      }
    }
    expect(offenders.sort()).toEqual([
      "packages/analyzers/src/embedding/embeddingClient.ts",
      "packages/analyzers/src/llm/llmClient.ts",
    ]);
  });

  it("never REFERENCES a provider client — the CLI cannot construct one, let alone call it", async () => {
    // Reachability through a barrel is not use. This is the property that decides whether a local
    // run can send anything: the CLI's own modules name no constructor that could open a socket.
    const PROVIDER_CONSTRUCTORS =
      /create(?:Anthropic|Gemini|Voyage|GeminiEmbedding)Client|create(?:Llm|Embedding)ClientFromEnv/;
    for (const file of ["index.ts", "analyzeLocal.ts"]) {
      const source = await readFile(path.join(CLI_ROOT, file), "utf8");
      expect(PROVIDER_CONSTRUCTORS.test(source), `${file} references a provider client`).toBe(false);
    }
  });

  it("ships a bundle containing NO fetch call, no provider client and no provider hostname", async () => {
    /**
     * THE STRONGEST CHECK HERE, because it is about the artifact a user actually installs rather
     * than about the source graph it was built from. Rollup drops the unreferenced provider clients,
     * so the published file has no network capability in it at all — which is a property anyone can
     * verify on their own machine by grepping the file they downloaded, and the reason the bundle is
     * deliberately NOT minified.
     */
    const bundle = await readFile(path.join(PACKAGE_ROOT, "bundle/codeflow-local.mjs"), "utf8");
    expect(bundle).not.toMatch(/\bfetch\s*\(/);
    expect(bundle).not.toMatch(/createAnthropicClient|createGeminiClient|createVoyageClient/);
    expect(bundle).not.toMatch(/api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.voyageai\.com/);
    // And the imports it does declare are node builtins plus the one WASM parser.
    const imports = [...bundle.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier.startsWith("node:") || specifier === "web-tree-sitter").toBe(true);
    }
  });

  it("reads NO provider key anywhere in that graph", async () => {
    const offenders: string[] = [];
    for (const [file, source] of await importGraph()) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
      if (KEY_PATTERN.test(code)) offenders.push(path.relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("declares only two runtime dependencies, and neither is a network client", async () => {
    // The published package installs exactly what this lists. A network client could not get in
    // without appearing here.
    const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@vscode/tree-sitter-wasm", "web-tree-sitter"]);
    expect(pkg.name).toBe("codeflow-local");
    expect(pkg.bin["codeflow-local"]).toMatch(/bundle/);
  });

  it("ships only the bundle, so a consumer never installs the private workspace packages", async () => {
    const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(pkg.files).toEqual(["bundle"]);
    // Every @codeflow/* package is `private: true` and unpublished; a published package that asked
    // for them would fail at install, which is the whole reason the bundle exists.
    for (const name of Object.keys(pkg.dependencies)) {
      expect(name.startsWith("@codeflow/")).toBe(false);
    }
  });
});

describe("the CLI source tree has no surprises", () => {
  it("contains only the two modules it is supposed to", async () => {
    const files = (await readdir(CLI_ROOT)).filter((name) => name.endsWith(".ts"));
    expect(files.sort()).toEqual(["analyzeLocal.ts", "index.ts"]);
  });
});
