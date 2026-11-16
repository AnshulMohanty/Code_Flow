import { describe, expect, it } from "vitest";
import { createGoResolver, parseGoManifest, type GoFileFacts, type GoUse } from "../stages/goResolver.js";
import type { ImportResolution } from "../stages/moduleResolver.js";

interface GoFile {
  pkg?: string;
  decls?: string[];
  imports?: string[];
}

async function resolverFor(goFiles: Record<string, GoFile>, manifests: Record<string, string> = {}) {
  const facts = new Map<string, GoFileFacts>(
    Object.entries(goFiles).map(([path, file]) => [
      path,
      {
        packageName: file.pkg,
        declarations: (file.decls ?? []).map((name) => ({ name })),
        imports: (file.imports ?? []).map((source) => ({ source })),
      },
    ]),
  );
  return createGoResolver({
    files: [...Object.keys(goFiles), ...Object.keys(manifests)].sort(),
    read: async (path) => manifests[path] ?? null,
    facts,
  });
}

const use = (symbol: string): GoUse => ({ binding: symbol.split(".")[0], symbol });
const spec = (source: string, name?: string) => ({ source, specifiers: name ? [name] : [] });
const targets = (resolution: ImportResolution) => (resolution.status === "resolved" ? resolution.targets.map((t) => t.target) : resolution.status);

const MODULE = { "go.mod": "module github.com/acme/app\n\ngo 1.22\n" };

describe("Go resolver — import path → package → declaring file", () => {
  const files: Record<string, GoFile> = {
    "cmd/app/main.go": { pkg: "main", decls: ["main"] },
    "store/store.go": { pkg: "store", decls: ["Store", "New"] },
    "store/open.go": { pkg: "store", decls: ["Open", "init"] },
    "store/close.go": { pkg: "store", decls: ["Close"] },
    "store/store_test.go": { pkg: "store", decls: ["TestOpen", "helper"] },
    "store/testdata/fixture.go": { pkg: "fixture", decls: ["Fixture"] },
    "internal/yaml/parse.go": { pkg: "yamlv3", decls: ["Parse"] },
  };

  it("points the edge at the file declaring the name used, not at every file in the package", async () => {
    const r = await resolverFor(files, MODULE);
    const resolution = r.resolve("cmd/app/main.go", spec("github.com/acme/app/store"), [use("store.Open"), use("store.Close")]);
    expect(resolution).toEqual({
      status: "resolved",
      targets: [
        { target: "store/close.go", bindings: ["store"], symbols: ["store.Close"] },
        { target: "store/open.go", bindings: ["store"], symbols: ["store.Open"] },
      ],
    });
  });

  it("falls back to one representative file when no used name matches", async () => {
    const r = await resolverFor(files, MODULE);
    // `store.go` is named after the package — the conventional home of its doc and main type.
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/store"), [use("store.missing")]))).toEqual(["store/store.go"]);
  });

  it("binds by the target's package clause, not the directory name, and honours aliases", async () => {
    const r = await resolverFor(files, MODULE);
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/internal/yaml"), [use("yamlv3.Parse")]))).toEqual([
      "internal/yaml/parse.go",
    ]);
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/store", "db"), [use("db.Close")]))).toEqual(["store/close.go"]);
  });

  it("a blank import depends on the package's init files; a dot import on bare names", async () => {
    const r = await resolverFor(files, MODULE);
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/store", "_"), []))).toEqual(["store/open.go"]);
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/store", "."), [{ binding: "New", symbol: "New" }]))).toEqual([
      "store/store.go",
    ]);
  });

  it("standard library and third-party modules are external; a missing in-module package is broken", async () => {
    const r = await resolverFor(files, MODULE);
    expect(r.resolve("cmd/app/main.go", spec("net/http"), []).status).toBe("external");
    expect(r.resolve("cmd/app/main.go", spec("github.com/spf13/cobra"), []).status).toBe("external");
    expect(r.resolve("cmd/app/main.go", spec("github.com/acme/app/gone"), []).status).toBe("unresolved");
    expect(r.resolve("cmd/app/main.go", spec("github.com/acme/application"), []).status).toBe("external");
  });

  it("never targets _test.go files; an EXPLICIT import still reaches testdata and _-prefixed packages", async () => {
    const r = await resolverFor({ ...files, "gen/_ignored/other/other.go": { pkg: "other", decls: ["X"] } }, MODULE);
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/store"), [use("store.helper")]))).toEqual(["store/store.go"]);
    // `./...` skips these directories, but `go list` resolves an explicit import into them (Kubernetes does this).
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/store/testdata"), []))).toEqual(["store/testdata/fixture.go"]);
    expect(targets(r.resolve("cmd/app/main.go", spec("github.com/acme/app/gen/_ignored/other"), []))).toEqual(["gen/_ignored/other/other.go"]);
  });

  it("an external test package resolves to the package under test", async () => {
    const r = await resolverFor({ ...files, "store/x_test.go": { pkg: "store_test" } }, MODULE);
    expect(targets(r.resolve("store/x_test.go", spec("github.com/acme/app/store"), [use("store.Open")]))).toEqual(["store/open.go"]);
  });
});

describe("Go resolver — module layouts", () => {
  it("nested modules and local replace directives (the Kubernetes staging layout)", async () => {
    const r = await resolverFor(
      {
        "pkg/api/server.go": { pkg: "api", decls: ["Serve"] },
        "staging/src/k8s.io/client/rest/client.go": { pkg: "rest", decls: ["Client"] },
      },
      {
        "go.mod": "module k8s.io/kubernetes\n\nreplace (\n\tk8s.io/client => ./staging/src/k8s.io/client // local\n\tk8s.io/other v1.0.0 => k8s.io/fork v1.0.1\n)\nreplace k8s.io/escape => ../outside\n",
        "staging/src/k8s.io/client/go.mod": "module k8s.io/client\n",
      },
    );
    expect(targets(r.resolve("pkg/api/server.go", spec("k8s.io/client/rest"), [use("rest.Client")]))).toEqual([
      "staging/src/k8s.io/client/rest/client.go",
    ]);
    expect(r.resolve("pkg/api/server.go", spec("k8s.io/other/x"), []).status).toBe("external");
    expect(r.resolve("pkg/api/server.go", spec("k8s.io/escape/x"), []).status).toBe("external");
  });

  it("go.work replace directives are honoured", async () => {
    const r = await resolverFor(
      { "a/main.go": { pkg: "main" }, "libs/util/util.go": { pkg: "util", decls: ["Do"] } },
      { "go.work": "go 1.22\nuse ./a\nreplace example.com/util => ./libs/util\n", "a/go.mod": "module example.com/a\n" },
    );
    expect(targets(r.resolve("a/main.go", spec("example.com/util"), [use("util.Do")]))).toEqual(["libs/util/util.go"]);
  });

  it("GOPATH-era repo with no go.mod: infers the checkout prefix from the imports", async () => {
    const r = await resolverFor({
      "main.go": { pkg: "main", imports: ["github.com/old/tool/lib", "github.com/old/tool/lib/parse", "github.com/other/util"] },
      "lib/lib.go": { pkg: "lib", decls: ["Run"], imports: ["github.com/old/tool/lib/parse"] },
      "lib/parse/parse.go": { pkg: "parse", decls: ["Parse"] },
      "util/util.go": { pkg: "util", decls: ["Help"] },
    });
    expect(targets(r.resolve("main.go", spec("github.com/old/tool/lib"), [use("lib.Run")]))).toEqual(["lib/lib.go"]);
    // A single coincidental match (another project's `util`) is not enough to claim a prefix.
    expect(r.resolve("main.go", spec("github.com/other/util"), []).status).toBe("external");
  });

  it("GOPATH inference keeps ONE prefix: a coincidental runner-up must not shadow it (etcd v3.3)", async () => {
    // `…/etcdserver/auth` also matches the top-level `auth/`, voting for `github.com/coreos/etcd/etcdserver`.
    const r = await resolverFor({
      "main.go": {
        pkg: "main",
        imports: [
          "github.com/coreos/etcd/etcdserver/auth",
          "github.com/coreos/etcd/etcdserver/auth",
          "github.com/coreos/etcd/etcdserver/stats",
          "github.com/coreos/etcd/pkg/types",
        ],
      },
      "auth/store.go": { pkg: "auth", decls: ["Store"] },
      "etcdserver/auth/auth.go": { pkg: "auth", decls: ["Auth"] },
      "etcdserver/stats/stats.go": { pkg: "stats", decls: ["Stats"] },
      "pkg/types/types.go": { pkg: "types", decls: ["ID"] },
    });
    expect(targets(r.resolve("main.go", spec("github.com/coreos/etcd/etcdserver/stats"), []))).toEqual(["etcdserver/stats/stats.go"]);
    expect(targets(r.resolve("main.go", spec("github.com/coreos/etcd/etcdserver/auth"), []))).toEqual(["etcdserver/auth/auth.go"]);
  });

  it("a longer root without the package falls through to a shorter root that has it", async () => {
    const r = await resolverFor(
      {
        "main.go": { pkg: "main" },
        "tools/gen/gen.go": { pkg: "gen", decls: ["Gen"] },
      },
      { "go.mod": "module example.com/x\n", "tools/go.mod": "module example.com/x/tools\n" },
    );
    // `tools/` is its own module but holds no `cmd` package; the root module does not either → broken.
    expect(r.resolve("main.go", spec("example.com/x/tools/cmd"), []).status).toBe("unresolved");
    expect(targets(r.resolve("main.go", spec("example.com/x/tools/gen"), []))).toEqual(["tools/gen/gen.go"]);
  });

  it("a checked-in GOPATH (`src/<import path>`) resolves directly", async () => {
    const r = await resolverFor({
      "src/github.com/acme/x/main.go": { pkg: "main" },
      "src/github.com/acme/x/lib/lib.go": { pkg: "lib", decls: ["Go"] },
    });
    expect(targets(r.resolve("src/github.com/acme/x/main.go", spec("github.com/acme/x/lib"), [use("lib.Go")]))).toEqual([
      "src/github.com/acme/x/lib/lib.go",
    ]);
  });
});

describe("Go resolver — same-package names", () => {
  it("finds a name declared by another file of the same package; tests see test helpers, sources do not", async () => {
    const r = await resolverFor(
      {
        "store/store.go": { pkg: "store", decls: ["Store"] },
        "store/open.go": { pkg: "store", decls: ["Open"] },
        "store/helpers_test.go": { pkg: "store", decls: ["fixture"] },
        "store/open_test.go": { pkg: "store", decls: ["TestOpen"] },
      },
      MODULE,
    );
    expect(r.samePackage("store/open.go", "Store")).toBe("store/store.go");
    expect(r.samePackage("store/open.go", "Open")).toBeUndefined(); // its own declaration
    expect(r.samePackage("store/open.go", "fixture")).toBeUndefined();
    expect(r.samePackage("store/open_test.go", "fixture")).toBe("store/helpers_test.go");
    expect(r.samePackage("store/open_test.go", "Open")).toBe("store/open.go");
  });
});

describe("parseGoManifest", () => {
  it("reads module, single and block replaces, quoted module paths and comments", () => {
    expect(
      parseGoManifest('module "example.com/x" // the module\nreplace a => ./a\nreplace (\n b v1 => ../b\n c => d v2\n)\n'),
    ).toEqual({ module: "example.com/x", replaces: [{ module: "a", path: "./a" }, { module: "b", path: "../b" }] });
  });
});
