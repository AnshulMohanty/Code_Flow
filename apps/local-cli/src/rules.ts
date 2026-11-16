import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "@codeflow/shared-types";

/**
 * ARCHITECTURE RULES — boundaries a codebase means to keep, checked against the RESOLVED graph.
 *
 * Written in a committed `codeflow.rules.json` at the repository root:
 *
 *   { "rules": [
 *       { "name": "web never imports the worker", "from": "apps/web/**", "forbid": "apps/worker/**" },
 *       { "name": "domain stays pure", "from": "src/domain/**", "forbid": ["src/infra/**", "src/http/**"],
 *         "except": ["src/infra/types.ts"] } ] }
 *
 * Checked against resolved edges, so a forbidden dependency is caught however it is written — a
 * relative path, a tsconfig alias, a workspace package name, a Go module path, a Java same-package use.
 * A text search for the import string would miss most of those. Type-only imports count: they still
 * couple the code, which is what a boundary is about.
 *
 * Globs: `**` any number of directories, `*` within one segment, `?` one character.
 */

export interface ArchitectureRule {
  name: string;
  from: string | string[];
  forbid: string | string[];
  /** Targets that are allowed even though they match `forbid`. */
  except?: string[];
}

export interface RuleViolation {
  rule: string;
  from: string;
  to: string;
  specifier: string;
}

export const RULES_FILE = "codeflow.rules.json";

/** Loads `codeflow.rules.json`. No file ⇒ no rules (not an error); a malformed file IS an error. */
export async function loadRules(repoPath: string): Promise<{ rules: ArchitectureRule[]; errors: string[] }> {
  let text: string;
  try {
    text = await readFile(path.join(repoPath, RULES_FILE), "utf8");
  } catch {
    return { rules: [], errors: [] };
  }
  return parseRules(text);
}

export function parseRules(text: string): { rules: ArchitectureRule[]; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { rules: [], errors: [`${RULES_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const list = (json as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) return { rules: [], errors: [`${RULES_FILE} needs a "rules" array`] };
  const rules: ArchitectureRule[] = [];
  const errors: string[] = [];
  list.forEach((entry, index) => {
    const rule = entry as Partial<ArchitectureRule>;
    const globs = (value: unknown) => (typeof value === "string" ? [value] : Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null);
    if (typeof rule.name !== "string" || !rule.name.trim()) return errors.push(`rule #${index + 1}: "name" must be a non-empty string`);
    if (!globs(rule.from)?.length) return errors.push(`rule "${rule.name}": "from" must be a glob or a list of globs`);
    if (!globs(rule.forbid)?.length) return errors.push(`rule "${rule.name}": "forbid" must be a glob or a list of globs`);
    if (rule.except !== undefined && !globs(rule.except)) return errors.push(`rule "${rule.name}": "except" must be a list of globs`);
    rules.push(rule as ArchitectureRule);
  });
  return { rules, errors };
}

/**
 * Every edge that breaks a rule. `onlyFrom` limits the check to edges leaving those files — what a
 * pull request introduced or touched — so a PR is not blamed for violations it did not write.
 */
export function checkRules(result: AnalysisResult, rules: readonly ArchitectureRule[], onlyFrom?: ReadonlySet<string>): RuleViolation[] {
  const compiled = rules.map((rule) => ({
    name: rule.name,
    from: toRegexes(rule.from),
    forbid: toRegexes(rule.forbid),
    except: toRegexes(rule.except ?? []),
  }));
  const violations: RuleViolation[] = [];
  const seen = new Set<string>();
  for (const edge of result.graph?.edges ?? []) {
    if (onlyFrom && !onlyFrom.has(edge.from)) continue;
    for (const rule of compiled) {
      if (!rule.from.some((re) => re.test(edge.from))) continue;
      if (!rule.forbid.some((re) => re.test(edge.to))) continue;
      if (rule.except.some((re) => re.test(edge.to))) continue;
      const key = `${rule.name}\u0000${edge.from}\u0000${edge.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ rule: rule.name, from: edge.from, to: edge.to, specifier: edge.specifier });
    }
  }
  return violations.sort((a, b) => a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function toRegexes(globs: string | readonly string[]): RegExp[] {
  return (typeof globs === "string" ? [globs] : globs).map(globToRegex);
}

/** `apps/web/**` → /^apps\/web\/.*$/ ; `src/*.ts` → /^src\/[^/]*\.ts$/ */
export function globToRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches everything below.
        const slash = glob[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += /[\\^$.|+()[\]{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}
