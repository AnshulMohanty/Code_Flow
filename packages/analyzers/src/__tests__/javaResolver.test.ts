import { describe, expect, it } from "vitest";
import { createJavaResolver, type JavaFileFacts } from "../stages/javaResolver.js";
import type { ImportResolution } from "../stages/moduleResolver.js";

interface JavaFile {
  pkg?: string;
  types?: string[];
  refs?: string[];
  locals?: string[];
  headers?: string[];
  qualified?: string[];
  imports?: Array<string | { source: string; isStatic: true }>;
}

function resolverFor(files: Record<string, JavaFile>) {
  const facts = new Map<string, JavaFileFacts>(
    Object.entries(files).map(([path, file]) => [
      path,
      {
        packageName: file.pkg,
        declarations: (file.types ?? []).map((name) => ({ name })),
        typeRefs: file.refs ?? [],
        localTypes: file.locals ?? file.types ?? [],
        headerRefs: file.headers ?? [],
        qualifiedRefs: file.qualified ?? [],
        imports: (file.imports ?? []).map((entry) => (typeof entry === "string" ? { source: entry } : entry)),
      },
    ]),
  );
  return createJavaResolver({ files: Object.keys(files), facts });
}

const targets = (resolution: ImportResolution) => (resolution.status === "resolved" ? resolution.targets.map((t) => t.target) : resolution.status);
const single = (source: string) => ({ source, specifiers: [source.split(".").pop()!] });

const REPO: Record<string, JavaFile> = {
  "src/main/java/com/acme/util/Strings.java": { pkg: "com.acme.util", types: ["Strings"] },
  "src/main/java/com/acme/util/Checks.java": { pkg: "com.acme.util", types: ["Checks"] },
  "src/main/java/com/acme/model/User.java": { pkg: "com.acme.model", types: ["User"] },
  "src/main/java/com/acme/model/Order.java": { pkg: "com.acme.model", types: ["Order"] },
  "src/main/java/com/acme/app/Helper.java": { pkg: "com.acme.app", types: ["Helper"] },
  "src/main/java/com/acme/app/App.java": { pkg: "com.acme.app", types: ["App"], refs: ["Helper", "User", "Strings", "List"] },
};

describe("Java resolver — javac's name-resolution order", () => {
  it("single-type, nested and static imports reach the declaring file", () => {
    const r = resolverFor(REPO);
    expect(targets(r.resolve("src/main/java/com/acme/app/App.java", single("com.acme.util.Strings")))).toEqual(["src/main/java/com/acme/util/Strings.java"]);
    expect(targets(r.resolve("src/main/java/com/acme/app/App.java", single("com.acme.util.Strings.Helper")))).toEqual(["src/main/java/com/acme/util/Strings.java"]);
    expect(targets(r.resolve("src/main/java/com/acme/app/App.java", { ...single("com.acme.util.Checks.notNull"), isStatic: true }))).toEqual([
      "src/main/java/com/acme/util/Checks.java",
    ]);
  });

  it("an on-demand import reaches only the types actually used", () => {
    const r = resolverFor(REPO);
    expect(targets(r.resolve("src/main/java/com/acme/app/App.java", { source: "com.acme.model.*", specifiers: [] }))).toEqual([
      "src/main/java/com/acme/model/User.java",
    ]);
  });

  it("a same-package type is a dependency with no import", () => {
    const r = resolverFor(REPO);
    expect(r.implicit("src/main/java/com/acme/app/App.java")).toEqual([
      { target: "src/main/java/com/acme/app/Helper.java", specifier: "com.acme.app.Helper", bindings: ["Helper"] },
    ]);
  });

  it("the file's own types and single-type imports outrank the same package", () => {
    const r = resolverFor({
      ...REPO,
      "src/main/java/com/acme/app/Other.java": { pkg: "com.acme.app", types: ["Other", "Helper"], refs: ["Helper"] },
      "src/main/java/com/acme/app/Imp.java": { pkg: "com.acme.app", types: ["Imp"], refs: ["Helper"], imports: ["com.acme.util.Helper"] },
    });
    expect(r.implicit("src/main/java/com/acme/app/Other.java")).toEqual([]);
    expect(r.implicit("src/main/java/com/acme/app/Imp.java")).toEqual([]);
  });

  it("a nested type does not shadow a name in its class header (commons-lang CompareToBuilder)", () => {
    const r = resolverFor({
      "b/Builder.java": { pkg: "b", types: ["Builder"] },
      "b/CompareToBuilder.java": { pkg: "b", types: ["CompareToBuilder"], refs: ["Builder"], locals: ["Builder", "CompareToBuilder"], headers: ["Builder"] },
    });
    expect(r.implicit("b/CompareToBuilder.java").map((d) => d.target)).toEqual(["b/Builder.java"]);
  });

  it("fully qualified uses resolve directly", () => {
    const r = resolverFor({ ...REPO, "x/Q.java": { pkg: "x", types: ["Q"], qualified: ["com.acme.model.Order.STATUS"] } });
    expect(r.implicit("x/Q.java")).toEqual([{ target: "src/main/java/com/acme/model/Order.java", specifier: "com.acme.model.Order", bindings: [] }]);
  });

  it("external vs broken: a missing type in OUR package is broken; a sibling library package is external", () => {
    const r = resolverFor(REPO);
    expect(r.resolve("src/main/java/com/acme/app/App.java", single("java.util.List")).status).toBe("external");
    expect(r.resolve("src/main/java/com/acme/app/App.java", single("com.acme.util.Gone")).status).toBe("unresolved");
    // Guava declares com.google.common.* packages; Truth (another library) is not one of them.
    expect(r.resolve("src/main/java/com/acme/app/App.java", single("com.acme.truth.Truth")).status).toBe("external");
  });

  it("indexes by declared package, not path: legacy Ant layouts and duplicates pick the nearest", () => {
    const r = resolverFor({
      "src/main/org/apache/tools/ant/Task.java": { pkg: "org.apache.tools.ant", types: ["Task"] },
      "src/etc/testcases/src1/B.java": { types: ["B"] },
      "src/etc/testcases/src2/B.java": { types: ["B"] },
      "src/etc/testcases/src2/A.java": { types: ["A"], refs: ["B"] },
      "src/main/org/apache/tools/ant/taskdefs/Copy.java": { pkg: "org.apache.tools.ant.taskdefs", types: ["Copy"] },
    });
    expect(targets(r.resolve("src/main/org/apache/tools/ant/taskdefs/Copy.java", single("org.apache.tools.ant.Task")))).toEqual([
      "src/main/org/apache/tools/ant/Task.java",
    ]);
    expect(r.implicit("src/etc/testcases/src2/A.java").map((d) => d.target)).toEqual(["src/etc/testcases/src2/B.java"]);
  });
});
