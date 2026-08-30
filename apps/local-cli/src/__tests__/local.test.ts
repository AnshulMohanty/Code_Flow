import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeLocal, LOCAL_MIN_SIMILARITY, LOCAL_SIMILARITY_MEASURED, queryLocal } from "../analyzeLocal.js";
import { parseArgs } from "../index.js";

/**
 * V3-P5 task 4 acceptance: a small fixture repository analysed FULLY OFFLINE — no keys, no network —
 * with the same grounding the hosted path enforces.
 *
 * This test writes a real fixture repo to a temp directory and runs the real pipeline over it. That
 * is deliberate rather than mocking the filesystem: the whole claim of local mode is that it works on
 * a developer's actual disk, and a faked fs would test everything except the part that is new.
 *
 * It is still HERMETIC in the sense that matters — no key, no socket, no provider. The only I/O is to
 * a temp directory this test creates and removes.
 */

let repoDir = "";

/** A tiny but REALISTIC repo: a package.json (so Orient has something), an entry point, a class with
 *  a method, an importer, and an unimported file — enough for imports, calls and an isolated node. */
const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture-app", version: "1.0.0", main: "src/index.ts" }, null, 2),
  "README.md": "# fixture-app\n\nA tiny app used to prove local-first analysis works offline.\n",
  "src/index.ts": [
    "import { AuthService } from './auth';",
    "import { connectDb } from './db';",
    "",
    "export function main() {",
    "  const auth = new AuthService();",
    "  connectDb();",
    "  return auth.login('alice');",
    "}",
  ].join("\n"),
  "src/auth.ts": [
    "import { hash } from './util';",
    "",
    "/** Issues and verifies session tokens. */",
    "export class AuthService {",
    "  login(user: string): string {",
    "    return hash(user);",
    "  }",
    "}",
  ].join("\n"),
  "src/db.ts": ["export function connectDb() {", "  return { connected: true };", "}"].join("\n"),
  "src/util.ts": ["export function hash(value: string): string {", "  return value.split('').reverse().join('');", "}"].join("\n"),
  "src/orphan.ts": ["export function unusedHelper() {", "  return 42;", "}"].join("\n"),
};

beforeAll(async () => {
  repoDir = await mkdtemp(path.join(tmpdir(), "codeflow-local-"));
  for (const [relative, contents] of Object.entries(FIXTURE)) {
    const target = path.join(repoDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}, 60_000);

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

describe("analyzeLocal — a real repository, fully offline", () => {
  it("analyses the working tree with NO key and NO network", async () => {
    const analysis = await analyzeLocal({ repoPath: repoDir });

    // Every deterministic stage ran and completed.
    const byStage = new Map(analysis.stages.map((entry) => [entry.stage, entry.status]));
    for (const stage of ["ingest", "orient", "map-structure", "inventory", "connect", "analyze", "rag"]) {
      expect(byStage.get(stage)).toBe("completed");
    }

    // The graph is real: 6 source files plus the docs/config the walker picked up.
    const nodes = analysis.result.graph?.nodes.map((node) => node.id) ?? [];
    expect(nodes).toContain("src/index.ts");
    expect(nodes).toContain("src/auth.ts");
    expect(nodes).toContain("src/orphan.ts");

    // Real edges, resolved on-device by the tree-sitter parser.
    const edges = (analysis.result.graph?.edges ?? []).map((edge) => `${edge.from}>${edge.to}`);
    expect(edges).toContain("src/index.ts>src/auth.ts");
    expect(edges).toContain("src/auth.ts>src/util.ts");

    // Symbols, with the class the parser found.
    const symbols = (analysis.result.inventory?.symbols ?? []).map((symbol) => symbol.name);
    expect(symbols).toContain("AuthService");

    // And metrics computed from that graph.
    expect(analysis.result.metrics?.summary.fileCount).toBeGreaterThan(0);
  }, 120_000);

  it("has NO AI summary, and says so rather than faking one", async () => {
    // Synthesis needs an LLM and there is no keyless local one. Degrading it into something that
    // looks like a summary would be worse than its absence.
    const analysis = await analyzeLocal({ repoPath: repoDir });
    expect(analysis.result.ai?.synthesis).toBeUndefined();
    expect(analysis.stages.map((entry) => entry.stage)).not.toContain("synthesize");
  }, 120_000);

  it("builds a searchable index ON DISK, in a file a human can read", async () => {
    const indexDir = path.join(repoDir, ".codeflow-index");
    const analysis = await analyzeLocal({ repoPath: repoDir, indexDir });
    expect(analysis.chunkCount).toBeGreaterThan(0);
    expect(analysis.namespace).toBeTruthy();

    // The store is a JSON file — which is what makes "zero egress" inspectable rather than asserted.
    const namespaceFile = path.join(indexDir, `${analysis.namespace!.replace(/[^a-zA-Z0-9._@-]+/g, "_")}.vectors.json`);
    const parsed = JSON.parse(await readFile(namespaceFile, "utf8")) as {
      fileFormat: number;
      embeddingModel: string;
      records: Array<{ id: string; vector: number[] }>;
    };
    expect(parsed.fileFormat).toBe(1);
    // Named so a local index can never be mistaken for a hosted one.
    expect(parsed.embeddingModel).toBe("codeflow-local-bow");
    expect(parsed.records.length).toBe(analysis.chunkCount);
    // Real, L2-normalised vectors.
    const norm = Math.sqrt(parsed.records[0].vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
  }, 120_000);

  it("the namespace records that this is a LOCAL index", async () => {
    // `provider: "local"` flows into the namespace, so a local index and a hosted one cannot collide
    // in a shared store.
    const analysis = await analyzeLocal({ repoPath: repoDir });
    expect(analysis.namespace).toContain("codeflow-local-bow");
  }, 120_000);

  it("--no-index still produces a complete deterministic analysis", async () => {
    const analysis = await analyzeLocal({ repoPath: repoDir, skipIndex: true });
    expect(analysis.chunkCount).toBe(0);
    expect(analysis.result.graph?.nodes.length).toBeGreaterThan(0);
    expect(analysis.result.metrics).toBeDefined();
  }, 120_000);

  it("is DETERMINISTIC — two runs produce identical slices", async () => {
    // Directory order is filesystem-dependent, so the walker sorts; without that this would fail
    // intermittently on some machines and pass on others.
    const first = await analyzeLocal({ repoPath: repoDir, skipIndex: true });
    const second = await analyzeLocal({ repoPath: repoDir, skipIndex: true });
    expect(JSON.stringify(second.result.graph)).toBe(JSON.stringify(first.result.graph));
    expect(JSON.stringify(second.result.inventory)).toBe(JSON.stringify(first.result.inventory));
    expect(JSON.stringify(second.result.metrics)).toBe(JSON.stringify(first.result.metrics));
  }, 120_000);

  it("skips node_modules and .git rather than walking them", async () => {
    await mkdir(path.join(repoDir, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(repoDir, "node_modules", "left-pad", "index.js"), "module.exports = 1;", "utf8");
    const analysis = await analyzeLocal({ repoPath: repoDir, skipIndex: true });
    expect((analysis.result.graph?.nodes ?? []).some((node) => node.id.includes("node_modules"))).toBe(false);
  }, 120_000);
});

describe("queryLocal — grounded retrieval, offline", () => {
  it("finds the code that answers a question, with real line ranges", async () => {
    const indexDir = path.join(repoDir, ".codeflow-query");
    const analysis = await analyzeLocal({ repoPath: repoDir, indexDir });
    const answer = await queryLocal({
      result: analysis.result,
      indexDir,
      question: "AuthService login hash",
      k: 3,
    });

    expect(answer.refused).toBe(false);
    expect(answer.chunks.length).toBeGreaterThan(0);
    // GROUNDING holds offline exactly as it does hosted: every chunk resolves to a real file and a
    // real line range within it.
    const nodeIds = new Set((analysis.result.graph?.nodes ?? []).map((node) => node.id));
    for (const chunk of answer.chunks) {
      expect(nodeIds.has(chunk.fileId)).toBe(true);
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    expect(answer.chunks.some((chunk) => chunk.fileId === "src/auth.ts")).toBe(true);
  }, 120_000);

  it("returns the GROUNDED CODE, not prose — there is no local model to summarise", async () => {
    const indexDir = path.join(repoDir, ".codeflow-query2");
    const analysis = await analyzeLocal({ repoPath: repoDir, indexDir });
    const answer = await queryLocal({ result: analysis.result, indexDir, question: "hash", k: 2 });
    // The chunk text is the FILE's text, verbatim — not a paraphrase.
    const hit = answer.chunks.find((chunk) => chunk.fileId === "src/util.ts");
    if (hit) expect(FIXTURE["src/util.ts"]).toContain(hit.text.split("\n")[0]);
  }, 120_000);

  it("keeps the similarity-floor REFUSAL offline", async () => {
    // "Nothing here is relevant" is a real answer, and an offline tool must not start guessing just
    // because there is no provider to blame.
    const indexDir = path.join(repoDir, ".codeflow-query3");
    const analysis = await analyzeLocal({ repoPath: repoDir, indexDir });
    const answer = await queryLocal({
      result: analysis.result,
      indexDir,
      question: "kubernetes helm chart ingress annotations",
      k: 3,
    });
    expect(answer.refused || answer.chunks.length === 0).toBe(true);
    // And the reason it refuses: the best match is COLLISION NOISE, not signal.
    expect(answer.topScore).toBeLessThan(LOCAL_MIN_SIMILARITY);
  }, 120_000);

  it("sets the floor ABOVE the embedder's measured noise level", async () => {
    // The bug this locks down: the floor was originally 0.05 and an entirely off-topic query scored
    // 0.0506 — feature hashing into 256 dimensions never returns a true zero for unrelated text, so
    // the floor had been set AT the noise level and the refusal had quietly stopped refusing.
    expect(LOCAL_MIN_SIMILARITY).toBeGreaterThan(LOCAL_SIMILARITY_MEASURED.offTopic);
    expect(LOCAL_MIN_SIMILARITY).toBeLessThan(LOCAL_SIMILARITY_MEASURED.onTopic);
    // With real headroom on both sides, not merely ordered.
    expect(LOCAL_MIN_SIMILARITY / LOCAL_SIMILARITY_MEASURED.offTopic).toBeGreaterThan(2);
  });

  it("refuses when there is no index at all", async () => {
    const analysis = await analyzeLocal({ repoPath: repoDir, skipIndex: true });
    const answer = await queryLocal({ result: analysis.result, indexDir: repoDir, question: "anything" });
    expect(answer.refused).toBe(true);
    expect(answer.chunks).toEqual([]);
  }, 120_000);
});

describe("parseArgs", () => {
  it("separates a command, positionals and flags", () => {
    const parsed = parseArgs(["analyze", "./repo", "--out", "result.json"]);
    expect(parsed.command).toBe("analyze");
    expect(parsed.positional).toEqual(["./repo"]);
    expect(parsed.flags.out).toBe("result.json");
  });

  it("treats a flag with no following value as boolean", () => {
    // Which is what lets `--no-index` and `--out FILE` coexist without declaring a schema.
    const parsed = parseArgs(["analyze", "./repo", "--no-index"]);
    expect(parsed.flags["no-index"]).toBe(true);
  });

  it("accepts --flag=value", () => {
    expect(parseArgs(["ask", "./repo", "--index-dir=/tmp/x"]).flags["index-dir"]).toBe("/tmp/x");
  });

  it("keeps a multi-word question as positionals the caller can rejoin", () => {
    const parsed = parseArgs(["ask", "./repo", "how", "does", "auth", "work"]);
    expect(parsed.positional.slice(1).join(" ")).toBe("how does auth work");
  });

  it("handles no arguments at all", () => {
    expect(parseArgs([]).command).toBeUndefined();
  });
});
