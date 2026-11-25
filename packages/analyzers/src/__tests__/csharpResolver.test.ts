import { describe, expect, it } from "vitest";
import type { Inventory, PipelineContext, PipelineInput, RepoFile, RepoGraph, RepoStructure } from "@codeflow/shared-types";
import { createConnectStage } from "../stages/connect.js";
import { readCSharpProjects } from "../stages/msbuild.js";

// C# name resolution, end to end (tree-sitter facts → resolver → graph): one test per language or build rule
// the Roslyn benchmark taught us. Each repository is a few in-memory files.

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

async function graphOf(files: Record<string, string>): Promise<RepoGraph> {
  const repoFiles: RepoFile[] = Object.entries(files).map(([path, content]) => ({
    path,
    ext: path.slice(path.lastIndexOf(".")).toLowerCase(),
    role: "source",
    language: path.endsWith(".cs") ? "C#" : "Unknown",
    sizeBytes: content.length,
  }));
  const structure: RepoStructure = { layout: "flat", files: repoFiles, fileCount: repoFiles.length };
  const inventory: Inventory = { symbols: [], entryPoints: [], symbolCount: 0, loc: {} };
  const ctx: PipelineContext = {
    repoPath: "/repo",
    commitSha: "sha",
    prior: { structure, inventory },
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
  const stage = createConnectStage({ readFile: async (_root, path) => files[path] ?? null, now: () => 1000 });
  const { partial } = await stage.run(input, ctx);
  return partial.graph!;
}

/** "from → to" pairs, by file path. */
async function edgesOf(files: Record<string, string>): Promise<string[]> {
  const graph = await graphOf(files);
  return graph.edges.map((edge) => `${edge.from} -> ${edge.to}`).sort();
}

const SDK = (references: string[] = [], extra = "") =>
  `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>${references.map((r) => `<ProjectReference Include="${r}" />`).join("")}</ItemGroup>${extra}</Project>`;

describe("C# — namespaces and usings", () => {
  it("same and enclosing namespaces need no using; a using imports only the types actually used", async () => {
    const edges = await edgesOf({
      "Acme/Core/Repo.cs": "namespace Acme.Core { public class Repo {} }",
      "Acme/Core/Data/Store.cs": "namespace Acme.Core.Data { public class Store { Repo r; Peer p; } }",
      "Acme/Core/Data/Peer.cs": "namespace Acme.Core.Data { public class Peer {} }",
      "Acme/Models/User.cs": "namespace Acme.Models { public class User {} }",
      "Acme/Models/Order.cs": "namespace Acme.Models { public class Order {} }",
      "Acme/App.cs": "using System;\nusing Acme.Models;\nnamespace Acme.App { class App { User u; } }",
    });
    expect(edges).toEqual([
      "Acme/App.cs -> Acme/Models/User.cs",
      "Acme/Core/Data/Store.cs -> Acme/Core/Data/Peer.cs",
      "Acme/Core/Data/Store.cs -> Acme/Core/Repo.cs",
    ]);
  });

  it("a using written inside a namespace is looked up from that namespace outwards (MediatR's `using Wrappers;`)", async () => {
    const edges = await edgesOf({
      "src/Wrappers/Wrapper.cs": "namespace MediatR.Wrappers;\npublic class Wrapper {}",
      "src/Mediator.cs": "namespace MediatR;\nusing Wrappers;\npublic class Mediator { Wrapper w; }",
    });
    expect(edges).toEqual(["src/Mediator.cs -> src/Wrappers/Wrapper.cs"]);
  });

  it("a dotted name binds its first part in the nearest enclosing namespace; a namespace found first is not a type", async () => {
    const edges = await edgesOf({
      "Examples/Handler.cs": "namespace Acme.Examples.ExceptionHandler;\npublic class ServerHandler {}",
      "Examples/Overrides.cs": "namespace Acme.Examples.ExceptionHandler.Overrides;\npublic class ServerHandler : ExceptionHandler.ServerHandler {}",
      "Tests/Fixture.cs": "namespace Acme.Tests.TestAssembly;\npublic class Fixture { public const int N = 1; }",
      "Core/TestAssembly.cs": "namespace Acme.Core;\npublic class TestAssembly {}",
      "Tests/Mock.cs": "using Acme.Core;\nnamespace Acme.Tests;\nclass Mock { int n = TestAssembly.Fixture.N; }",
    });
    expect(edges).toEqual(["Examples/Overrides.cs -> Examples/Handler.cs", "Tests/Mock.cs -> Tests/Fixture.cs"]);
  });

  it("`Name.Member` is a field or property when the type (or a base class) declares one by that name", async () => {
    const edges = await edgesOf({
      "src/AsyncPolicy.cs": "namespace P;\npublic class AsyncPolicy {}\npublic class AsyncPolicy<T> {}",
      "src/Bench.cs": "namespace P;\nclass Bench { static readonly AsyncPolicy<int> AsyncPolicy = null; void Run() { AsyncPolicy.Execute(); } }",
      "src/Base.cs": "namespace P;\nclass Base { protected Dialog Dialog; }\npublic class Dialog { public static void Show() {} }",
      "src/Derived.cs": "namespace P;\nclass Derived : Base { void F() { Dialog.Show(); } }",
    });
    // Bench depends on AsyncPolicy<int> through the field's type; `AsyncPolicy.Execute()` is the field.
    // Derived reaches Base.cs both as its base class and through `Dialog.Show()` ("Color Color": the
    // inherited field is typed Dialog, so the static call still names the type, declared in Base.cs).
    expect(edges).toEqual(["src/Bench.cs -> src/AsyncPolicy.cs", "src/Derived.cs -> src/Base.cs"]);
  });

  it("generic arity separates types: `Policy` and `Policy<T>` are different", async () => {
    const edges = await edgesOf({
      "src/Policy.cs": "namespace P;\npublic class Policy {}",
      "src/PolicyT.cs": "namespace P;\npublic class Policy<TResult> {}",
      "src/UsesGeneric.cs": "namespace P;\nclass A { Policy<int> p; }",
      "src/UsesPlain.cs": "namespace P;\nclass B { Policy p; }",
    });
    expect(edges).toEqual(["src/UsesGeneric.cs -> src/PolicyT.cs", "src/UsesPlain.cs -> src/Policy.cs"]);
  });

  it("attributes name their `…Attribute` class", async () => {
    const edges = await edgesOf({
      "src/RowAttribute.cs": "namespace T;\npublic class RowAttribute : System.Attribute {}",
      "src/Test.cs": "namespace T;\npublic class Test {}",
      "src/Uses.cs": "namespace T;\nclass Uses { [Row] void M() {} }",
    });
    expect(edges).toEqual(["src/Uses.cs -> src/RowAttribute.cs"]);
  });
});

describe("C# — partial and nested types", () => {
  it("a part naming its own type depends on the other parts; a nested type lives in the part that declares it", async () => {
    const edges = await edgesOf({
      "src/Wrap.cs": "namespace P;\npublic partial class Wrap { string N => nameof(Wrap); }",
      "src/Wrap.Keys.cs": "namespace P;\npublic partial class Wrap { public class Keys {} }",
      "src/Wrap.Other.cs": "namespace P;\npublic partial class Wrap { int x; }",
      "src/User.cs": "namespace P;\nclass User { Wrap.Keys k; }",
    });
    // `Wrap.Keys` names Wrap (every part) and Keys (its own part), as the compiler binds both names.
    expect(edges).toEqual([
      "src/User.cs -> src/Wrap.Keys.cs",
      "src/User.cs -> src/Wrap.Other.cs",
      "src/User.cs -> src/Wrap.cs",
      "src/Wrap.cs -> src/Wrap.Keys.cs",
      "src/Wrap.cs -> src/Wrap.Other.cs",
    ]);
  });

  it("a nested type of a base class is found without qualification (Newtonsoft's `State.PostValue`)", async () => {
    const edges = await edgesOf({
      "src/JsonReader.cs": "namespace J;\npublic abstract class JsonReader { protected internal enum State { Start, PostValue } }",
      "src/JsonTextReader.cs": "namespace J;\npublic class JsonTextReader : JsonReader { void F() { var s = State.PostValue; } }",
    });
    expect(edges).toEqual(["src/JsonTextReader.cs -> src/JsonReader.cs"]);
  });
});

describe("C# — projects", () => {
  it("a file sees its own project and the projects it references — not an unrelated project's same-named type", async () => {
    const edges = await edgesOf({
      "src/Lib/Lib.csproj": SDK(),
      "src/Lib/Clock.cs": "namespace Acme;\npublic class Clock {}",
      "test/Perf/Perf.csproj": SDK(),
      "test/Perf/Some.cs": "namespace Acme.Tests;\npublic static class Some {}",
      "test/Unit/Unit.csproj": SDK(["..\\..\\src\\Lib\\Lib.csproj"]),
      "test/Unit/Some.cs": "namespace Acme.Tests;\npublic static class Some {}",
      "test/Unit/ClockTests.cs": "namespace Acme.Tests;\nclass ClockTests { Clock c; void F() { Some.Thing(); } }",
    });
    expect(edges).toEqual(["test/Unit/ClockTests.cs -> src/Lib/Clock.cs", "test/Unit/ClockTests.cs -> test/Unit/Some.cs"]);
  });

  it("source the build takes as a NuGet package (a PackageReference) is not an edge", async () => {
    const edges = await edgesOf({
      "src/Contracts/Contracts.csproj": SDK(),
      "src/Contracts/IRequest.cs": "namespace MediatR;\npublic interface IRequest {}",
      "src/MediatR/MediatR.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="MediatR.Contracts" /></ItemGroup></Project>`,
      "src/MediatR/ISender.cs": "namespace MediatR;\npublic interface ISender { void Send(IRequest r); }",
    });
    expect(edges).toEqual([]);
  });

  it("an old-style project compiles exactly its Compile items: a linked file counts, an unlisted one and sample .csproj data do not", async () => {
    const edges = await edgesOf({
      "src/core/core.csproj": `<Project ToolsVersion="3.5" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><ItemGroup>
        <Compile Include="Reflect.cs" /><Compile Include="..\\framework\\AsyncRegion.cs"><Link>AsyncRegion.cs</Link></Compile>
        <Compile Include="resources\\TestResource.cs" /></ItemGroup></Project>`,
      "src/core/Reflect.cs": "using Fw;\nnamespace Core { class Reflect { AsyncRegion r; TestResource t; } }",
      "src/core/AsyncRegion.cs": "namespace Core { class AsyncRegion {} }",
      "src/core/resources/sample.csproj": `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><ItemGroup><Compile Include="Class1.cs" /></ItemGroup></Project>`,
      "src/core/resources/TestResource.cs": "namespace Core { class TestResource {} }",
      "src/framework/framework.csproj": `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><ItemGroup><Compile Include="AsyncRegion.cs" /></ItemGroup></Project>`,
      "src/framework/AsyncRegion.cs": "namespace Fw { class AsyncRegion {} }",
    });
    // core/AsyncRegion.cs is in no project; the linked framework copy is what core compiles.
    expect(edges).toEqual(["src/core/Reflect.cs -> src/core/resources/TestResource.cs", "src/core/Reflect.cs -> src/framework/AsyncRegion.cs"]);
  });

  it("a type in the file's own project wins over a referenced project's type of the same name", async () => {
    const edges = await edgesOf({
      "src/Core/Core.csproj": SDK(),
      "src/Core/Controller.cs": "namespace Polly.CircuitBreaker;\ninternal sealed class Controller<T> {}",
      "src/Legacy/Legacy.csproj": SDK(["../Core/Core.csproj"]),
      "src/Legacy/Controller.cs": "namespace Polly.CircuitBreaker;\ninternal abstract class Controller<T> {}",
      "src/Legacy/Advanced.cs": "namespace Polly.CircuitBreaker;\nclass Advanced<T> : Controller<T> {}",
    });
    expect(edges).toEqual(["src/Legacy/Advanced.cs -> src/Legacy/Controller.cs"]);
  });

  it("project-level global usings (`<Using Include>`, also from Directory.Build.targets and imported files) apply to that project only", async () => {
    const edges = await edgesOf({
      "Directory.Build.targets": `<Project><Import Project="$(MSBuildThisFileDirectory)eng/$(ProjectType).targets" Condition="$(ProjectType) != ''" />
        <ItemGroup Condition="'$(IncludeHelpers)' == 'true'"><Using Include="Acme.Helpers" /></ItemGroup></Project>`,
      "eng/Test.targets": `<Project><PropertyGroup><IncludeHelpers>true</IncludeHelpers></PropertyGroup></Project>`,
      "src/Lib/Lib.csproj": SDK(),
      "src/Lib/Helpers/Ttl.cs": "namespace Acme.Helpers;\npublic class Ttl {}",
      "src/Lib/Uses.cs": "namespace Acme;\nclass Uses { Ttl t; }",
      "test/T/T.csproj": SDK(["../../src/Lib/Lib.csproj"], "<PropertyGroup><ProjectType>Test</ProjectType></PropertyGroup>"),
      "test/T/Spec.cs": "namespace Acme.Specs;\nclass Spec { Ttl t; }",
    });
    expect(edges).toEqual(["test/T/Spec.cs -> src/Lib/Helpers/Ttl.cs"]);
  });

  it("reads references, usings and Compile items from the project files", async () => {
    const files: Record<string, string> = {
      "Directory.Build.props": `<Project><PropertyGroup><Shared>Acme.Shared</Shared></PropertyGroup></Project>`,
      "src/A/A.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\B\\B.csproj" /><Using Include="$(Shared)" /><Using Include="X.Y" Alias="Z" /><Using Include="S" Static="true" /></ItemGroup></Project>`,
      "src/B/B.csproj": `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><ItemGroup><ProjectReference Include="$(Unknown)\\C.csproj" /><Compile Include="One.cs" /></ItemGroup></Project>`,
    };
    const projects = await readCSharpProjects(Object.keys(files), async (path) => files[path] ?? null);
    expect(projects.get("src/A")).toMatchObject({ globs: true, open: false, references: new Set(["src/B"]), usings: new Set(["Acme.Shared"]), aliases: new Map([["Z", "X.Y"]]) });
    expect(projects.get("src/B")).toMatchObject({ globs: false, open: true, compiles: new Set(["src/B/One.cs"]) });
  });
});
