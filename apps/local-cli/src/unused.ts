import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * UNREFERENCED FILES — source files nothing else in the repository depends on.
 *
 * In an old codebase the expensive question is "is anything still using this?", and people keep dead
 * code because nobody can answer it. The resolved graph can, for the languages where a file is the
 * unit of use: JavaScript/TypeScript, Python, and C/C++ HEADERS. It is deliberately conservative:
 *   - Java and C# types are often reached by reflection or a framework (`@Component`, DI), and a Go
 *     file is always used through its package — so those are not judged per file here;
 *   - a C/C++ source file is compiled and linked, never included, so only headers are judged;
 *   - entry points and the files frameworks and tools load by CONVENTION (index, `__init__.py`,
 *     configs, Next.js routes, scripts, examples, fixtures, migrations, stories) are never listed.
 * What remains still needs a human: a dynamic `import()` with a computed path, a plugin loaded by
 * name, or a file another repository imports is invisible to a static graph. The report says so.
 */

export interface UnreferencedFile {
  path: string;
  language: string;
  lines: number;
}

const JUDGED_LANGUAGES = new Set(["TypeScript", "JavaScript", "Python"]);
const HEADER = /\.(h|hh|hpp|hxx|h\+\+)$/i;

const CONVENTION_FILE =
  /(^|\/)(index|main|__init__|__main__|conftest|setup|manage|wsgi|asgi|app|server|cli)\.[^/]+$|\.d\.ts$|\.config\.[^/]+$|\.stories\.[^/]+$|(^|\/)(vite-env|env|global|globals)\.d\.ts$/;
const CONVENTION_DIR =
  /(^|\/)(scripts?|bin|examples?|samples?|docs?|benchmarks?|bench|fixtures?|__fixtures__|__mocks__|e2e|cypress|playwright|\.storybook|migrations?|tools?|public|static|assets)\//;

/**
 * Files a `package.json` RUNS rather than imports: `"eval": "tsx src/cli.ts"`, `"bin": "dist/index.js"`,
 * `"main"`. Paths are taken relative to that package.json; a built path maps back to its source
 * (`dist/x.js` → `src/x.ts`). Without this, every CLI script in a workspace reads as dead.
 */
export function filesRunByPackageJson(manifests: ReadonlyArray<{ path: string; json: Record<string, unknown> }>, files: ReadonlySet<string>): Set<string> {
  const used = new Set<string>();
  for (const { path: manifestPath, json } of manifests) {
    const dir = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1) : "";
    const values: string[] = [];
    for (const field of ["main", "module", "bin", "scripts"]) {
      const value = json[field];
      if (typeof value === "string") values.push(value);
      else if (value && typeof value === "object") values.push(...Object.values(value).filter((v): v is string => typeof v === "string"));
    }
    for (const value of values) {
      for (const token of value.split(/[\s"'=]+/)) {
        if (!/\.[cm]?[jt]sx?$|\.py$/.test(token)) continue;
        const clean = token.replace(/^\.\//, "");
        const candidates = [clean, clean.replace(/^(dist|build|lib|out)\//, "src/").replace(/\.([cm]?)js$/, ".$1ts"), clean.replace(/\.([cm]?)js$/, ".$1ts")];
        for (const candidate of candidates) if (files.has(`${dir}${candidate}`)) used.add(`${dir}${candidate}`);
      }
    }
  }
  return used;
}
/** Next.js / SvelteKit / Remix route files, loaded by their path. */
const ROUTE_FILE = /(^|\/)(pages|app|routes)\/(.*\/)?([^/]+)\.[cm]?[jt]sx?$|(^|\/)(page|layout|route|loading|error|not-found|template|default|middleware)\.[cm]?[jt]sx?$/;

export function findUnreferenced(result: AnalysisResult, alsoUsed: ReadonlySet<string> = new Set()): { files: UnreferencedFile[]; judged: number } {
  const referenced = new Set<string>(alsoUsed);
  for (const edge of result.graph?.edges ?? []) if (edge.from !== edge.to) referenced.add(edge.to);
  for (const edge of result.graph?.cpgEdges ?? []) if (edge.from !== edge.to) referenced.add(edge.to);
  const entryPoints = new Set([
    ...(result.entryPoints ?? []).map((entry) => entry.fileId),
    ...(result.inventory?.entryPoints ?? []).map((entry) => entry.filePath),
  ]);

  const judged = (result.graph?.nodes ?? []).filter(
    (node) =>
      node.layer === "source" &&
      (JUDGED_LANGUAGES.has(node.language) || ((node.language === "C" || node.language === "C++") && HEADER.test(node.id))) &&
      !entryPoints.has(node.id) &&
      !CONVENTION_FILE.test(node.id) &&
      !CONVENTION_DIR.test(node.id) &&
      !ROUTE_FILE.test(node.id),
  );
  const files = judged
    .filter((node) => !referenced.has(node.id))
    .map((node) => ({ path: node.id, language: node.language, lines: node.lines }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files, judged: judged.length };
}
