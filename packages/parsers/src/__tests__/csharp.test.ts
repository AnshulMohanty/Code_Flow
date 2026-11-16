import { describe, expect, it } from "vitest";
import { extractCpgFacts } from "../treesitter/cpg.js";
import { selectBranches } from "../treesitter/csharp.js";
import { initTreeSitter } from "../treesitter/runtime.js";
import { TREE_SITTER_PARSER_VERSION } from "../types.js";
import { scanCSharpUsings } from "../utils/importScan.js";

await initTreeSitter({ languages: ["csharp"] });

const facts = (content: string, path = "src/App/File.cs") => extractCpgFacts({ path, content });

describe("C# — usings, namespaces, declarations", () => {
  const SOURCE = `global using Acme.Shared;
using System;
using static Acme.Util.Checks;
using J = Acme.Json.Serializer;
namespace Acme.App.Web;
using Wrappers;

[ApiController]
[Route("api/users")]
public partial class UsersController : ControllerBase, IUsers<User>
{
    [HttpGet("{id}")]
    public Task<UserDto> Get(int id) => null;
    class Nested {}
}
public class Cache<TKey, TValue> {}
`;
  const f = facts(SOURCE);

  it("reads plain, static, alias and global usings, and where each is written", () => {
    expect(f.engine).toBe(TREE_SITTER_PARSER_VERSION);
    expect(f.imports.map(({ source, isStatic, alias, global, scope }) => [source, Boolean(isStatic), alias ?? "", Boolean(global), scope ?? ""])).toEqual([
      ["Acme.Shared", false, "", true, ""],
      ["System", false, "", false, ""],
      ["Acme.Util.Checks", true, "", false, ""],
      ["Acme.Json.Serializer", false, "J", false, ""],
      // Written after the file-scoped namespace: looked up from Acme.App.Web outwards.
      ["Wrappers", false, "", false, "Acme.App.Web"],
    ]);
    expect(f.imports.every((entry) => entry.lazy)).toBe(true); // the CLR loads types on first use
  });

  it("declares top-level types fully qualified, generic ones with their arity; nested types by their outer type", () => {
    expect(f.namespaces).toEqual(["Acme.App.Web"]);
    expect(f.declarations!.map((d) => d.name)).toEqual(["Acme.App.Web.UsersController", "Acme.App.Web.Cache`2"]);
    expect(f.nestedTypes).toEqual([{ outer: "Acme.App.Web.UsersController", name: "Nested" }]);
  });

  it("names an attribute by its class (`[ApiController]` is ApiControllerAttribute) and keeps generic arity", () => {
    expect(f.typeRefs).toEqual(expect.arrayContaining(["ApiControllerAttribute", "RouteAttribute", "HttpGetAttribute", "ControllerBase", "IUsers`1", "User", "Task`1", "UserDto"]));
    expect(f.typeRefs).not.toContain("ApiController");
  });

  it("finds ASP.NET Core routes", () => {
    expect(f.routes.map(({ method, path }) => [method, path])).toEqual([
      ["ALL", "/api/users"],
      ["GET", "/{id}"],
    ]);
  });
});

describe("C# — type uses", () => {
  it("collects types in casts, patterns, typeof, nameof and generic arguments — not method names", () => {
    const f = facts(`namespace N;
class C {
  void M(object o) {
    if (o is Admin a || o is not Guest || o is Box<int>) {}
    var x = o as Casted;
    var t = typeof(Open<,>);
    var n = nameof(Named) + nameof(Holder<int>);
    var m = Mapper.Map<Dto>(o);
  }
}`);
    expect(f.typeRefs).toEqual(expect.arrayContaining(["Admin", "Guest", "Box`1", "Casted", "Open`2", "Named", "Holder`1", "Dto"]));
    expect(f.typeRefs).not.toContain("Map");
    expect(f.typeRefs).not.toContain("Map`1");
    expect(f.accessRefs).toEqual(["Mapper"]);
  });

  it("keeps `Name.Member` roots apart, and records members that could be that Name instead", () => {
    const f = facts(`namespace N;
class C {
  static readonly AsyncPolicy<int> AsyncPolicy = null;
  Formatting Formatting { get; set; }
  void M() { AsyncPolicy.Execute(); var f = Formatting.Indented; Helper.Run(); }
}`);
    // `Formatting` is already a type use (the property's type), so it is not an access-only name.
    expect(f.typeRefs).toEqual(expect.arrayContaining(["AsyncPolicy`1", "Formatting"]));
    expect(f.accessRefs).toEqual(["AsyncPolicy", "Helper"]);
    // `Formatting Formatting` is "Color Color": it does not hide the type Formatting.
    expect(f.memberNames).toEqual(["AsyncPolicy"]);
  });

  it("reads a dotted chain written as member access as a qualified name", () => {
    const f = facts(`namespace Acme.Tests;
class C { void M() { Polly.Utils.TypeNameFormatter.Format(null); var z = Json.Formatting.Indented; } }`);
    expect(f.qualifiedRefs).toEqual(expect.arrayContaining(["Polly.Utils.TypeNameFormatter.Format", "Json.Formatting.Indented"]));
  });

  it("a part of a partial type that names its own type depends on the other parts", () => {
    const f = facts(`namespace N;
public partial class Policy { Policy Self() => (Policy)this; }
public class Plain { Plain Me() => this; }`);
    expect(f.partialSelfRefs).toEqual(["Policy"]);
    expect(f.localTypes).toEqual(["Plain", "Policy"]);
  });
});

describe("C# — `#if` that splits a construct", () => {
  const SOURCE = `namespace Serilog;
public interface ILogger
{
    ILogger ForContext(IEnricher enricher)
#if FEATURE_DEFAULT_INTERFACE
        => new LoggerConfiguration().CreateLogger()
#elif FEATURE_OTHER
        => Other.Make()
#endif
    ;
}
`;

  it("parses each branch on its own and merges the facts", () => {
    const f = facts(SOURCE, "src/Serilog/ILogger.cs");
    expect(f.declarations!.map((d) => d.name)).toEqual(["Serilog.ILogger"]);
    expect(f.typeRefs).toEqual(expect.arrayContaining(["IEnricher", "LoggerConfiguration"]));
    expect(f.accessRefs).toEqual(["Other"]); // from the #elif branch
  });

  it("keeps line numbers when blanking the other branches", () => {
    const first = selectBranches(SOURCE, 0).split("\n");
    const second = selectBranches(SOURCE, 1).split("\n");
    expect(first).toHaveLength(SOURCE.split("\n").length);
    expect(first[5]).toContain("LoggerConfiguration");
    expect(first[7]).toBe("");
    expect(second[5]).toBe("");
    expect(second[7]).toContain("Other.Make");
  });
});

describe("C# — regex fallback", () => {
  it("scans usings by line", () => {
    expect(scanCSharpUsings("global using A.B;\nusing static C.D;\nusing E = F.G;\n")).toEqual([
      { target: "A.B", kind: "namespace", global: true, line: 1 },
      { target: "C.D", kind: "static", global: false, line: 2 },
      { target: "F.G", kind: "alias", alias: "E", global: false, line: 3 },
    ]);
  });
});
