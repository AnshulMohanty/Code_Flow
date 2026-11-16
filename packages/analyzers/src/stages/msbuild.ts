/**
 * Just enough of MSBuild to know what a C# project contains and sees: its source files, its
 * ProjectReferences, and its project-level global usings (`<Using Include="Acme.Core" />`, the SDK's way to
 * write `global using` in the project file).
 *
 * Evaluated as MSBuild does, in two passes: first properties and imports in document order (the nearest
 * Directory.Build.props, the .csproj, what it imports, the nearest Directory.Build.targets), then items with
 * the final properties. Conditions of the form `'$(Prop)' == 'value'` / `!=` (quoted or not), joined by
 * `and`/`or`, are evaluated; anything else counts as true.
 *
 * Which files a project compiles: an SDK-style project (or one with a wildcard Compile item) owns every .cs
 * file under its directory; an old-style project owns exactly the files its Compile items list. A
 * ProjectReference whose path needs an unknown MSBuild variable marks the project `open` (sees everything).
 */

export interface MsbuildProject {
  /** Directory of the .csproj ("" at the repository root). */
  dir: string;
  /** Owns every .cs file under `dir` (SDK default items, or a wildcard Compile item). */
  globs: boolean;
  /** Files listed by explicit Compile items (repository paths). */
  compiles: Set<string>;
  /** Directories of the referenced projects. */
  references: Set<string>;
  /** A reference could not be followed: treat the project as seeing everything. */
  open: boolean;
  /** Namespaces imported for every file of the project. */
  usings: Set<string>;
  /** `<Using Include="X.Y" Alias="Z" />` → Z → X.Y. */
  aliases: Map<string, string>;
}

type Read = (path: string) => Promise<string | null>;

/** `$(MSBuildThisFileDirectory)` expands to this marker + the repository path, so it is never re-based. */
const ROOTED = "\u0001";

const ELEMENT = /<(PropertyGroup|ItemGroup)\b([^>]*)>([\s\S]*?)<\/\1>|<Import\b([^>]*?)\/?>/gi;

export async function readCSharpProjects(files: readonly string[], read: Read): Promise<Map<string, MsbuildProject>> {
  const fileSet = new Set(files);
  const cache = new Map<string, Promise<string | null>>();
  const load = (path: string) => {
    let text = cache.get(path);
    if (!text) cache.set(path, (text = fileSet.has(path) ? read(path) : Promise.resolve(null)));
    return text;
  };
  const nearest = (dir: string, name: string): string | undefined => {
    for (let current: string | undefined = dir; current !== undefined; current = current === "" ? undefined : dirname(current)) {
      const candidate = current ? `${current}/${name}` : name;
      if (fileSet.has(candidate)) return candidate;
    }
    return undefined;
  };

  const projects = new Map<string, MsbuildProject>();
  for (const manifest of files.filter((path) => path.toLowerCase().endsWith(".csproj")).sort()) {
    const dir = dirname(manifest);
    const project = projects.get(dir) ?? { dir, globs: false, compiles: new Set(), references: new Set(), open: false, usings: new Set(), aliases: new Map() };
    projects.set(dir, project);
    const manifestText = await load(manifest);
    if (manifestText === null) {
      project.open = true;
      project.globs = true;
      continue;
    }
    const sdk = /<Project\b[^>]*\bSdk\s*=/i.test(manifestText) || /<Import\b[^>]*\bSdk\s*=/i.test(manifestText);

    // Pass 1: properties and imports, in document order.
    const props = new Map<string, string>([["MSBuildProjectDirectory", dir], ["Configuration", "Debug"], ["Platform", "AnyCPU"]]);
    const itemGroups: Array<{ attributes: string; body: string; thisDir: string }> = [];
    const seen = new Set<string>();
    const evaluate = async (path: string | undefined): Promise<void> => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      const text = await load(path);
      if (text === null) return;
      const thisDir = dirname(path);
      for (const match of text.matchAll(ELEMENT)) {
        if (match[1]?.toLowerCase() === "propertygroup") {
          if (!condition(match[2], props, thisDir)) continue;
          for (const property of match[3].matchAll(/<(\w+)((?:\s+\w+\s*=\s*"[^"]*")*)\s*>([^<]*)<\/\1>/g)) {
            if (!condition(property[2], props, thisDir)) continue;
            props.set(property[1], expand(property[3].trim(), props, thisDir));
          }
        } else if (match[1]) itemGroups.push({ attributes: match[2], body: match[3], thisDir });
        else if (match[4] !== undefined && !/\bSdk\s*=/i.test(match[4]) && condition(match[4], props, thisDir)) {
          const written = /\bProject\s*=\s*"([^"]+)"/i.exec(match[4])?.[1];
          if (!written) continue;
          if (/GetPathOfFileAbove/i.test(written)) {
            const name = /'([^']+)'/.exec(written)?.[1];
            await evaluate(name && thisDir ? nearest(dirname(thisDir), name.split("/").pop()!) : undefined);
          } else await evaluate(resolvePath(thisDir, expand(written, props, thisDir)));
        }
      }
    };
    await evaluate(nearest(dir, "Directory.Build.props"));
    await evaluate(manifest);
    await evaluate(nearest(dir, "Directory.Build.targets"));

    const defaultItems = !/^false$/i.test(props.get("EnableDefaultItems") ?? "") && !/^false$/i.test(props.get("EnableDefaultCompileItems") ?? "");
    project.globs ||= sdk && defaultItems;

    // Pass 2: items, with the final properties.
    for (const group of itemGroups) {
      if (!condition(group.attributes, props, group.thisDir)) continue;
      for (const item of group.body.matchAll(/<(Using|ProjectReference|Compile)\b([^>]*?)\/?>/g)) {
        const attributes = attributesOf(item[2]);
        const itemCondition = attributes.get("condition");
        if (itemCondition && !condition(` Condition="${itemCondition}"`, props, group.thisDir)) continue;
        const include = attributes.get("include") ? expand(attributes.get("include")!, props, group.thisDir) : undefined;
        const remove = attributes.get("remove");
        if (item[1] === "Compile") {
          for (const entry of (include ?? "").split(";").map((part) => part.trim()).filter(Boolean)) {
            if (entry.includes("*")) project.globs = true;
            else {
              const path = resolvePath(dir, entry);
              if (path) project.compiles.add(path);
            }
          }
          continue;
        }
        if (item[1] === "ProjectReference") {
          for (const reference of (include ?? "").split(";").map((entry) => entry.trim()).filter(Boolean)) {
            // Relative to the PROJECT, even when written in an imported file.
            const target = resolvePath(dir, reference);
            if (target) project.references.add(dirname(target));
            else project.open = true;
          }
          continue;
        }
        if (remove) {
          project.usings.delete(remove.trim());
          continue;
        }
        if (!include || attributes.get("static")?.toLowerCase() === "true") continue;
        const alias = attributes.get("alias");
        if (alias) project.aliases.set(alias, include.trim());
        else project.usings.add(include.trim());
      }
    }
  }
  return projects;
}

function attributesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) out.set(match[1].toLowerCase(), match[2]);
  return out;
}

function expand(text: string, props: Map<string, string>, thisDir: string): string {
  return text.replace(/\$\((\w+)\)/g, (_, name: string) =>
    /^MSBuildThisFileDirectory$/i.test(name) ? `${ROOTED}${thisDir ? `${thisDir}/` : ""}` : (props.get(name) ?? ""),
  );
}

/** `Condition="'$(X)' == 'y' and $(Z) != ''"`; anything this cannot read counts as true. */
function condition(attributes: string, props: Map<string, string>, thisDir: string): boolean {
  const raw = /\bCondition\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
  if (!raw) return true;
  if (/\$\(\[/.test(raw)) return true; // property functions: not evaluated
  const text = expand(raw, props, thisDir);
  if (/[()]/.test(text)) return true;
  const operand = String.raw`(?:'([^']*)'|([^\s'=!<>]*))`;
  const clause = new RegExp(String.raw`^\s*${operand}\s*(==|!=)\s*${operand}\s*$`);
  const test = (part: string): boolean => {
    const match = clause.exec(part);
    if (!match) return true;
    const left = (match[1] ?? match[2] ?? "").toLowerCase();
    const right = (match[4] ?? match[5] ?? "").toLowerCase();
    return match[3] === "==" ? left === right : left !== right;
  };
  return text.split(/\s+or\s+/i).some((alternative) => alternative.split(/\s+and\s+/i).every(test));
}

/** A path written in an MSBuild file, relative to `baseDir` (or already repository-rooted), or undefined. */
function resolvePath(baseDir: string, written: string): string | undefined {
  const trimmed = written.replace(/\\/g, "/").trim();
  const rooted = trimmed.lastIndexOf(ROOTED);
  const path = rooted === -1 ? trimmed : trimmed.slice(rooted + 1);
  if (!path || path.includes("$(") || path.includes("*") || path.startsWith("/")) return undefined;
  const parts = baseDir && rooted === -1 ? baseDir.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
