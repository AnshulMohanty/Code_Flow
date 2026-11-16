// Ground truth for C# name resolution, from Roslyn (the C# compiler).
//
// Each .csproj is compiled the way MSBuild hands it to the compiler: its Compile items (SDK globbing with
// Include/Remove, or a legacy project's explicit list, imports and Directory.Build.props included), its
// ProjectReferences (as compilation references), implicit and <Using> global usings, and the preprocessor
// symbols of EACH target framework (with DefineConstants under TargetFramework conditions). Every name
// written in the source is then bound by the compiler; when it binds to a type declared in this repository,
// the edge file -> every file declaring that type is recorded (all parts of a partial type; for a nested type,
// the files declaring the nested type itself). The truth is the union over
// target frameworks, so code behind `#if NET8_0` counts. NuGet packages are not restored: names into them
// do not bind, which is right — they are not repository edges.
//
// Usage: CSharpTruth <repo>     (JSON on stdout; CSHARP_TRUTH_EXPLAIN=<path part> prints that file's bindings
//        to stderr)
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

static class Program
{
    static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase) { ".git", "bin", "obj", "node_modules", ".vs" };
    static string Root = "";
    static List<string> AllCs = new();
    static readonly Dictionary<string, Project> Projects = new();
    static readonly Dictionary<string, CSharpCompilation> Compilations = new();
    static readonly HashSet<string> Building = new();
    static readonly Dictionary<string, SyntaxTree> Trees = new();
    static List<MetadataReference> CoreRefs = new();
    static List<MetadataReference> AspNetRefs = new();
    static readonly SortedDictionary<string, SortedSet<string>> Edges = new(StringComparer.Ordinal);
    /// Edges into source the build takes from a NuGet PACKAGE of this same repository (MediatR's library
    /// uses MediatR.Contracts by PackageReference). Kept apart: the compiler binds to the package.
    static readonly SortedDictionary<string, SortedSet<string>> ViaOwnPackage = new(StringComparer.Ordinal);
    static readonly Dictionary<string, HashSet<string>> PackageFiles = new();
    static int ParseErrors, Compiles;
    static readonly string? Explain = Environment.GetEnvironmentVariable("CSHARP_TRUTH_EXPLAIN") is { Length: > 0 } e ? e : null;

    static int Main(string[] args)
    {
        Root = Path.GetFullPath(args[0]).TrimEnd('/');
        AllCs = Walk(Root).Where(p => p.EndsWith(".cs", StringComparison.Ordinal)).ToList();
        LoadReferences();
        var projectFiles = Walk(Root).Where(p => p.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var path in projectFiles) Projects[path] = new Project(path);
        // Every target framework, in both Debug and Release (`#if DEBUG` code is real code too).
        foreach (var project in Projects.Values)
            foreach (var tfm in project.Tfms)
                foreach (var configuration in new[] { "Debug", "Release" })
                {
                    var key = Target(tfm, configuration);
                    var compilation = Compile(project, key);
                    if (compilation != null) Collect(project, key, compilation);
                }
        var inProject = Projects.Values.SelectMany(p => p.Tfms.SelectMany(t => p.Files(Target(t, "Debug")).Concat(p.Files(Target(t, "Release"))))).ToHashSet();
        foreach (var file in inProject) Edges.TryAdd(Rel(file), new SortedSet<string>(StringComparer.Ordinal));
        var output = new
        {
            projects = Projects.Count,
            compilations = Compiles,
            files = inProject.Count,
            filesInNoProject = AllCs.Count(f => !inProject.Contains(f)),
            parseErrors = ParseErrors,
            edges = Edges.ToDictionary(e => e.Key, e => e.Value.ToArray()),
            viaOwnPackage = ViaOwnPackage.Where(e => e.Value.Count > 0).ToDictionary(e => e.Key, e => e.Value.ToArray()),
        };
        Console.Out.Write(JsonSerializer.Serialize(output));
        return 0;
    }

    static IEnumerable<string> Walk(string dir)
    {
        var stack = new Stack<string>();
        stack.Push(dir);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            IEnumerable<string> entries;
            try { entries = Directory.EnumerateFileSystemEntries(current).OrderBy(e => e, StringComparer.Ordinal).ToList(); }
            catch { continue; }
            foreach (var entry in entries)
            {
                var info = new FileInfo(entry);
                if (info.LinkTarget != null) continue;
                if (Directory.Exists(entry)) { if (!SkipDirs.Contains(Path.GetFileName(entry))) stack.Push(entry); }
                else yield return entry;
            }
        }
    }

    static string Rel(string path) => Path.GetRelativePath(Root, path).Replace('\\', '/');

    /// A build target: "<target framework>|<configuration>".
    static string Target(string tfm, string configuration) => tfm + "|" + configuration;
    static string TfmOf(string target) => target.Split('|')[0];
    static string ConfigurationOf(string target) => target.Contains('|') ? target.Split('|')[1] : "Debug";

    static void LoadReferences()
    {
        // Reference assemblies from the SDK's targeting packs (the runtime's own assemblies as a fallback).
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var dotnetRoot = Path.GetFullPath(Path.Combine(runtimeDir, "..", "..", ".."));
        CoreRefs = Refs(Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")) ?? RefsIn(runtimeDir);
        AspNetRefs = Refs(Path.Combine(dotnetRoot, "packs", "Microsoft.AspNetCore.App.Ref"))
            ?? (Directory.Exists(Path.Combine(dotnetRoot, "shared", "Microsoft.AspNetCore.App"))
                ? RefsIn(Directory.GetDirectories(Path.Combine(dotnetRoot, "shared", "Microsoft.AspNetCore.App")).OrderBy(d => d).Last())
                : new List<MetadataReference>());
    }

    static List<MetadataReference>? Refs(string pack)
    {
        if (!Directory.Exists(pack)) return null;
        var version = Directory.GetDirectories(pack).OrderBy(d => d).LastOrDefault();
        var refDir = version == null ? null : Directory.GetDirectories(Path.Combine(version, "ref")).OrderBy(d => d).LastOrDefault();
        return refDir == null ? null : RefsIn(refDir);
    }

    static List<MetadataReference> RefsIn(string dir)
    {
        var refs = new List<MetadataReference>();
        foreach (var dll in Directory.GetFiles(dir, "*.dll"))
        {
            try { refs.Add(MetadataReference.CreateFromFile(dll)); } catch { }
        }
        return refs;
    }

    static CSharpCompilation? Compile(Project project, string target)
    {
        var tfm = TfmOf(target);
        var configuration = ConfigurationOf(target);
        var key = project.Path + "|" + target;
        if (Compilations.TryGetValue(key, out var done)) return done;
        if (!Building.Add(key)) return null; // a reference cycle
        var eval = project.Eval(target);
        var symbols = PreprocessorSymbols(project.IsSdk, tfm, configuration, eval.Props);
        var options = new CSharpParseOptions(LanguageVersion.Preview, DocumentationMode.None, SourceCodeKind.Regular, symbols);
        var symbolKey = string.Join(";", symbols.OrderBy(s => s, StringComparer.Ordinal));
        var trees = new List<SyntaxTree>();
        foreach (var file in eval.Compile)
        {
            var treeKey = file + "|" + symbolKey;
            if (!Trees.TryGetValue(treeKey, out var tree))
            {
                tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file), options, path: file);
                if (tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) ParseErrors++;
                Trees[treeKey] = tree;
            }
            trees.Add(tree);
        }
        var globals = GlobalUsings(project, eval);
        if (globals.Length > 0) trees.Add(CSharpSyntaxTree.ParseText(globals, options, path: "/__codeflow_truth__/GlobalUsings.g.cs"));
        var references = new List<MetadataReference>(CoreRefs);
        if (project.UsesAspNet(eval)) references.AddRange(AspNetRefs);
        // Project references are transitive in MSBuild: A → B → C lets A use C's types.
        var closure = new List<(Project, string)>();
        var visited = new HashSet<string> { project.Path };
        void Visit(Project from, string fromTarget)
        {
            foreach (var reference in from.Eval(fromTarget).ProjectReferences)
            {
                if (!Projects.TryGetValue(reference, out var referenced) || !visited.Add(referenced.Path)) continue;
                var referencedTarget = Target(BestTfm(referenced, TfmOf(fromTarget)), configuration);
                closure.Add((referenced, referencedTarget));
                Visit(referenced, referencedTarget);
            }
        }
        Visit(project, target);
        // A PackageReference to a package this repository builds: compile against its source, but record
        // the edges apart (ViaOwnPackage). Package references flow through project references too.
        var packages = new HashSet<string>(eval.PackageReferences, StringComparer.OrdinalIgnoreCase);
        foreach (var (referenced, referencedTarget) in closure) packages.UnionWith(referenced.Eval(referencedTarget).PackageReferences);
        var packageFiles = new HashSet<string>(StringComparer.Ordinal);
        foreach (var package in packages)
        {
            var source = Projects.Values.FirstOrDefault(p => p != project && p.PackageId.Equals(package, StringComparison.OrdinalIgnoreCase));
            if (source == null || !visited.Add(source.Path)) continue;
            var sourceTarget = Target(BestTfm(source, tfm), configuration);
            closure.Add((source, sourceTarget));
            packageFiles.UnionWith(source.Files(sourceTarget));
        }
        PackageFiles[key] = packageFiles;
        foreach (var (referenced, referencedTarget) in closure)
        {
            var compiled = Compile(referenced, referencedTarget);
            if (compiled != null) references.Add(compiled.ToMetadataReference());
        }
        var compilation = CSharpCompilation.Create(
            eval.Props.GetValueOrDefault("AssemblyName") is { Length: > 0 } name ? name : Path.GetFileNameWithoutExtension(project.Path),
            trees,
            references,
            Signed(project, eval, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, concurrentBuild: true)));
        Compiles++;
        Building.Remove(key);
        Compilations[key] = compilation;
        return compilation;
    }

    /// Sign as the build does (SignAssembly + AssemblyOriginatorKeyFile), so InternalsVisibleTo between signed
    /// assemblies holds. Public signing needs only the public key.
    static CSharpCompilationOptions Signed(Project project, Evaluation eval, CSharpCompilationOptions options)
    {
        var key = eval.Props.GetValueOrDefault("AssemblyOriginatorKeyFile", "");
        if (!eval.Props.GetValueOrDefault("SignAssembly", "").Equals("true", StringComparison.OrdinalIgnoreCase) || key.Length == 0) return options;
        var path = Path.GetFullPath(Path.Combine(project.Dir, key.Replace('\\', '/')));
        return File.Exists(path) ? options.WithCryptoKeyFile(path).WithPublicSign(true).WithStrongNameProvider(new DesktopStrongNameProvider()) : options;
    }

    static void Collect(Project project, string target, CSharpCompilation compilation)
    {
        var own = project.Files(target).ToHashSet();
        var viaPackage = PackageFiles.GetValueOrDefault(project.Path + "|" + target) ?? new HashSet<string>();
        foreach (var tree in compilation.SyntaxTrees)
        {
            if (!own.Contains(tree.FilePath)) continue;
            var from = Rel(tree.FilePath);
            if (!Edges.TryGetValue(from, out var targets)) Edges[from] = targets = new SortedSet<string>(StringComparer.Ordinal);
            if (!ViaOwnPackage.TryGetValue(from, out var packageTargets)) ViaOwnPackage[from] = packageTargets = new SortedSet<string>(StringComparer.Ordinal);
            var model = compilation.GetSemanticModel(tree);
            foreach (var name in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>())
            {
                if (name is IdentifierNameSyntax { IsVar: true }) continue; // `var` binds to the INFERRED type
                var info = model.GetSymbolInfo(name);
                var symbol = info.Symbol;
                // Refused only for access (InternalsVisibleTo a signed assembly; this rebuild is unsigned): the
                // name still denotes that type.
                if (symbol == null && info.CandidateReason == CandidateReason.Inaccessible && info.CandidateSymbols.Length == 1) symbol = info.CandidateSymbols[0];
                // Old-framework code (a .NET 2.0 polyfill of `Func<T>`) is compiled here against MODERN reference
                // assemblies, so it can clash with the framework's own type. On its real framework that type does
                // not exist: the in-repo one is meant.
                if (symbol == null && info.CandidateReason == CandidateReason.Ambiguous)
                {
                    var inRepo = info.CandidateSymbols.Where(c => c.Locations.Any(l => l.IsInSource)).ToList();
                    if (inRepo.Count == 1 && info.CandidateSymbols.Length > 1) symbol = inRepo[0];
                }
                // An attribute name binds to the attribute's constructor.
                if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } ctor && name.FirstAncestorOrSelf<AttributeSyntax>() != null) symbol = ctor.ContainingType;
                if (symbol is not INamedTypeSymbol type) continue;
                type = type.OriginalDefinition;
                foreach (var reference in type.DeclaringSyntaxReferences)
                {
                    var file = reference.SyntaxTree.FilePath;
                    if (file == tree.FilePath || !file.StartsWith(Root + "/", StringComparison.Ordinal)) continue;
                    if (Explain != null && from.Contains(Explain, StringComparison.Ordinal))
                        Console.Error.WriteLine($"{from}:{name.GetLocation().GetLineSpan().StartLinePosition.Line + 1} {name} -> {Rel(file)} [{target}]");
                    (viaPackage.Contains(file) ? packageTargets : targets).Add(Rel(file));
                }
            }
        }
    }

    static string GlobalUsings(Project project, Evaluation eval)
    {
        var usings = new List<string>();
        var implicitUsings = eval.Props.GetValueOrDefault("ImplicitUsings", "");
        if (project.IsSdk && (implicitUsings.Equals("enable", StringComparison.OrdinalIgnoreCase) || implicitUsings.Equals("true", StringComparison.OrdinalIgnoreCase)))
        {
            usings.AddRange(new[] { "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks" }.Select(n => $"global using global::{n};"));
            if (project.Sdk.Contains("Web", StringComparison.OrdinalIgnoreCase))
                usings.AddRange(new[] { "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing", "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging" }.Select(n => $"global using global::{n};"));
        }
        foreach (var item in eval.Usings)
        {
            if (item.Static) usings.Add($"global using static global::{item.Name};");
            else if (item.Alias.Length > 0) usings.Add($"global using {item.Alias} = global::{item.Name};");
            else usings.Add($"global using global::{item.Name};");
        }
        return string.Join("\n", usings.Distinct());
    }

    // ── Target frameworks → the SDK's preprocessor symbols ─────────────────────────────────────────────

    static readonly string[] NetFrameworkVersions = { "20", "30", "35", "40", "45", "451", "452", "46", "461", "462", "47", "471", "472", "48", "481" };
    static readonly string[] NetCoreAppVersions = { "1.0", "1.1", "2.0", "2.1", "2.2", "3.0", "3.1" };
    static readonly string[] NetStandardVersions = { "1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "2.0", "2.1" };

    static List<string> PreprocessorSymbols(bool sdk, string tfm, string configuration, Dictionary<string, string> props)
    {
        var symbols = new HashSet<string>(StringComparer.Ordinal);
        foreach (var constant in props.GetValueOrDefault("DefineConstants", "").Split(';', ',', ' '))
            if (Regex.IsMatch(constant.Trim(), @"^[A-Za-z_]\w*$")) symbols.Add(constant.Trim());
        if (!sdk) return symbols.ToList();
        if (configuration == "Debug") symbols.Add("DEBUG");
        symbols.Add("TRACE");
        var (id, version) = ParseTfm(tfm);
        var under = version.Replace('.', '_');
        if (id == ".NETFramework")
        {
            symbols.Add("NETFRAMEWORK");
            symbols.Add("NET" + version.Replace(".", ""));
            foreach (var v in NetFrameworkVersions.TakeWhile(v => CompareFramework(v, version.Replace(".", "")) <= 0)) symbols.Add($"NET{v}_OR_GREATER");
        }
        else if (id == ".NETStandard")
        {
            symbols.Add("NETSTANDARD");
            symbols.Add("NETSTANDARD" + under);
            foreach (var v in NetStandardVersions.Where(v => new Version(v) <= new Version(version))) symbols.Add($"NETSTANDARD{v.Replace('.', '_')}_OR_GREATER");
        }
        else if (id == ".NETCoreApp")
        {
            symbols.Add("NETCOREAPP");
            var v = new Version(version);
            foreach (var core in NetCoreAppVersions.Where(c => new Version(c) <= v)) symbols.Add($"NETCOREAPP{core.Replace('.', '_')}_OR_GREATER");
            if (v.Major >= 5)
            {
                symbols.Add("NET");
                symbols.Add("NET" + under);
                for (var major = 5; major <= v.Major; major++) symbols.Add($"NET{major}_0_OR_GREATER");
            }
            else symbols.Add("NETCOREAPP" + under);
        }
        return symbols.ToList();
    }

    /// The referenced project's framework NuGet would pick: the same one, else the highest of the same
    /// family not above it, else its highest .NET Standard, else its first.
    static string BestTfm(Project target, string tfm)
    {
        if (target.Tfms.Contains(tfm)) return tfm;
        var (id, version) = ParseTfm(tfm);
        var parsed = target.Tfms.Select(t => (Tfm: t, P: ParseTfm(t))).Where(x => x.P.Id.Length > 0).ToList();
        var same = parsed.Where(x => x.P.Id == id && new Version(x.P.Version) <= new Version(version)).OrderByDescending(x => new Version(x.P.Version)).FirstOrDefault();
        if (same.Tfm != null) return same.Tfm;
        var standard = parsed.Where(x => x.P.Id == ".NETStandard").OrderByDescending(x => new Version(x.P.Version)).FirstOrDefault();
        return standard.Tfm ?? target.Tfms[0];
    }

    static int CompareFramework(string a, string b) => string.CompareOrdinal(a.PadRight(3, '0'), b.PadRight(3, '0'));

    public static (string Id, string Version) ParseTfm(string tfm)
    {
        var t = tfm.Trim().ToLowerInvariant();
        var dash = t.IndexOf('-');
        if (dash > 0) t = t[..dash]; // net8.0-windows
        Match m;
        if ((m = Regex.Match(t, @"^netstandard(\d+\.\d+)$")).Success) return (".NETStandard", m.Groups[1].Value);
        if ((m = Regex.Match(t, @"^netcoreapp(\d+\.\d+)$")).Success) return (".NETCoreApp", m.Groups[1].Value);
        if ((m = Regex.Match(t, @"^net(\d+\.\d+)$")).Success) return (".NETCoreApp", m.Groups[1].Value);
        if ((m = Regex.Match(t, @"^net(\d)(\d)(\d?)$")).Success)
            return (".NETFramework", m.Groups[1].Value + "." + m.Groups[2].Value + (m.Groups[3].Value.Length > 0 ? "." + m.Groups[3].Value : ""));
        if ((m = Regex.Match(t, @"^v(\d+\.\d+(?:\.\d+)?)$")).Success) return (".NETFramework", m.Groups[1].Value);
        return ("", "0.0");
    }

    // ── A small MSBuild evaluator: properties (pass 1), then items (pass 2) ─────────────────────────────

    sealed record UsingItem(string Name, string Alias, bool Static);

    sealed class Evaluation
    {
        public Dictionary<string, string> Props = new(StringComparer.OrdinalIgnoreCase);
        public List<string> Compile = new();
        public List<string> ProjectReferences = new();
        public List<string> PackageReferences = new();
        public List<UsingItem> Usings = new();
        public List<string> FrameworkReferences = new();
    }

    sealed class Project
    {
        public readonly string Path;
        public readonly string Dir;
        public readonly XDocument Doc;
        public readonly bool IsSdk;
        public readonly string Sdk;
        public readonly List<string> Tfms;
        readonly Dictionary<string, Evaluation> evaluations = new();

        public Project(string path)
        {
            Path = path;
            Dir = System.IO.Path.GetDirectoryName(path)!;
            Doc = Load(path) ?? new XDocument(new XElement("Project"));
            var sdkElement = Doc.Root?.Elements().FirstOrDefault(e =>
                (e.Name.LocalName == "Sdk" && e.Attribute("Name") != null) || (e.Name.LocalName == "Import" && e.Attribute("Sdk") != null));
            Sdk = Doc.Root?.Attribute("Sdk")?.Value ?? sdkElement?.Attribute(sdkElement.Name.LocalName == "Sdk" ? "Name" : "Sdk")?.Value ?? "";
            IsSdk = Sdk.Length > 0;
            var first = Eval("");
            var many = first.Props.GetValueOrDefault("TargetFrameworks", "");
            var one = first.Props.GetValueOrDefault("TargetFramework", "");
            var legacy = first.Props.GetValueOrDefault("TargetFrameworkVersion", "");
            Tfms = (many.Length > 0 ? many.Split(';') : one.Length > 0 ? new[] { one } : legacy.Length > 0 ? new[] { legacy } : Array.Empty<string>())
                .Select(t => t.Trim()).Where(t => t.Length > 0 && !t.Contains('$')).Distinct().ToList();
            if (Tfms.Count == 0) Tfms.Add("net10.0");
        }

        public IEnumerable<string> Files(string target) => Eval(target).Compile;

        /// The NuGet id this project packs as.
        public string PackageId
        {
            get
            {
                var props = Eval(Tfms[0]).Props;
                var id = props.GetValueOrDefault("PackageId", "");
                if (id.Length == 0) id = props.GetValueOrDefault("AssemblyName", "");
                return id.Length > 0 ? id : System.IO.Path.GetFileNameWithoutExtension(Path);
            }
        }

        public bool UsesAspNet(Evaluation eval) =>
            Sdk.Contains("Web", StringComparison.OrdinalIgnoreCase) || Sdk.Contains("Razor", StringComparison.OrdinalIgnoreCase)
            || eval.FrameworkReferences.Any(f => f.StartsWith("Microsoft.AspNetCore", StringComparison.OrdinalIgnoreCase));

        public Evaluation Eval(string target)
        {
            if (evaluations.TryGetValue(target, out var cached)) return cached;
            var tfm = TfmOf(target);
            var eval = new Evaluation();
            var globals = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Configuration", "Platform" };
            eval.Props["Configuration"] = ConfigurationOf(target);
            eval.Props["Platform"] = "AnyCPU";
            eval.Props["MSBuildProjectDirectory"] = Dir;
            eval.Props["MSBuildProjectName"] = System.IO.Path.GetFileNameWithoutExtension(Path);
            eval.Props["MSBuildProjectFile"] = System.IO.Path.GetFileName(Path);
            eval.Props["MSBuildProjectFullPath"] = Path;
            if (tfm.Length > 0)
            {
                eval.Props["TargetFramework"] = tfm;
                globals.Add("TargetFramework");
                var (id, version) = ParseTfm(tfm);
                eval.Props["TargetFrameworkIdentifier"] = id;
                eval.Props["TargetFrameworkVersion"] = "v" + version;
            }
            var items = new List<(XElement Element, string FileDir)>();
            var seen = new HashSet<string>();
            var buildProps = FindAbove(Dir, "Directory.Build.props");
            if (buildProps != null) Pass1(buildProps, eval, globals, items, seen);
            Pass1Elements(Doc.Root!, Dir, eval, globals, items, seen);
            var buildTargets = FindAbove(Dir, "Directory.Build.targets");
            if (buildTargets != null) Pass1(buildTargets, eval, globals, items, seen);
            Pass2(eval, items);
            evaluations[target] = eval;
            return eval;
        }

        static string? FindAbove(string dir, string name)
        {
            for (var current = dir; current.Length >= Root.Length; current = System.IO.Path.GetDirectoryName(current) ?? "")
            {
                var candidate = System.IO.Path.Combine(current, name);
                if (File.Exists(candidate)) return candidate;
                if (current == Root) break;
            }
            return null;
        }

        void Pass1(string file, Evaluation eval, HashSet<string> globals, List<(XElement, string)> items, HashSet<string> seen)
        {
            if (!seen.Add(file)) return;
            var doc = Load(file);
            if (doc?.Root != null) Pass1Elements(doc.Root, System.IO.Path.GetDirectoryName(file)!, eval, globals, items, seen);
        }

        void Pass1Elements(XElement parent, string fileDir, Evaluation eval, HashSet<string> globals, List<(XElement, string)> items, HashSet<string> seen)
        {
            foreach (var element in parent.Elements())
            {
                switch (element.Name.LocalName)
                {
                    case "PropertyGroup":
                        if (!Condition(element, eval, fileDir)) break;
                        foreach (var property in element.Elements())
                        {
                            if (globals.Contains(property.Name.LocalName) || !Condition(property, eval, fileDir)) continue;
                            eval.Props[property.Name.LocalName] = Expand(property.Value, eval, fileDir);
                        }
                        break;
                    case "ItemGroup":
                        items.Add((element, fileDir));
                        break;
                    case "Choose":
                        var chosen = element.Elements().FirstOrDefault(w => w.Name.LocalName == "When" && Condition(w, eval, fileDir))
                            ?? element.Elements().FirstOrDefault(w => w.Name.LocalName == "Otherwise");
                        if (chosen != null) Pass1Elements(chosen, fileDir, eval, globals, items, seen);
                        break;
                    case "Import":
                        if (!Condition(element, eval, fileDir) || element.Attribute("Sdk") != null) break;
                        var raw = element.Attribute("Project")?.Value ?? "";
                        if (raw.Contains("GetPathOfFileAbove", StringComparison.Ordinal))
                        {
                            var above = FindAbove(System.IO.Path.GetDirectoryName(fileDir) ?? "", System.IO.Path.GetFileName(Regex.Match(raw, @"'([^']+)'").Groups[1].Value));
                            if (above != null) Pass1(above, eval, globals, items, seen);
                            break;
                        }
                        var target = Expand(raw, eval, fileDir).Replace('\\', '/');
                        if (target.Length == 0 || target.Contains('*')) break;
                        var full = System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(target) ? target : System.IO.Path.Combine(fileDir, target));
                        if (full.StartsWith(Root + "/", StringComparison.Ordinal) && File.Exists(full)) Pass1(full, eval, globals, items, seen);
                        break;
                }
            }
        }

        void Pass2(Evaluation eval, List<(XElement Element, string FileDir)> groups)
        {
            var compile = new List<string>();
            var inCompile = new HashSet<string>(StringComparer.Ordinal);
            var enableDefaults = !eval.Props.GetValueOrDefault("EnableDefaultItems", "true").Equals("false", StringComparison.OrdinalIgnoreCase)
                && !eval.Props.GetValueOrDefault("EnableDefaultCompileItems", "true").Equals("false", StringComparison.OrdinalIgnoreCase);
            if (IsSdk && enableDefaults)
            {
                var excludes = new List<string> { "bin/**", "obj/**", "**/.*/**" };
                excludes.AddRange(Split(eval.Props.GetValueOrDefault("DefaultItemExcludes", "")));
                var excluded = excludes.SelectMany(e => Glob(e, Dir)).ToHashSet();
                foreach (var file in Glob("**/*.cs", Dir)) if (!excluded.Contains(file) && inCompile.Add(file)) compile.Add(file);
            }
            foreach (var (group, fileDir) in groups)
            {
                if (!Condition(group, eval, fileDir)) continue;
                foreach (var item in group.Elements())
                {
                    if (!Condition(item, eval, fileDir)) continue;
                    var include = Expand(item.Attribute("Include")?.Value ?? "", eval, fileDir);
                    var remove = Expand(item.Attribute("Remove")?.Value ?? "", eval, fileDir);
                    switch (item.Name.LocalName)
                    {
                        case "Compile":
                            if (include.Length > 0)
                            {
                                var excluded = Split(Expand(item.Attribute("Exclude")?.Value ?? "", eval, fileDir)).SelectMany(e => Glob(e, Dir)).ToHashSet();
                                foreach (var file in Split(include).SelectMany(i => Glob(i, Dir)))
                                    if (!excluded.Contains(file) && inCompile.Add(file)) compile.Add(file);
                            }
                            if (remove.Length > 0)
                            {
                                var gone = Split(remove).SelectMany(r => Glob(r, Dir)).ToHashSet();
                                compile.RemoveAll(gone.Contains);
                                inCompile.ExceptWith(gone);
                            }
                            break;
                        case "ProjectReference":
                            foreach (var reference in Split(include))
                                eval.ProjectReferences.Add(System.IO.Path.GetFullPath(System.IO.Path.Combine(Dir, reference.Replace('\\', '/'))));
                            break;
                        case "PackageReference":
                            eval.PackageReferences.AddRange(Split(include));
                            break;
                        case "FrameworkReference":
                            eval.FrameworkReferences.AddRange(Split(include));
                            break;
                        case "Using":
                            if (include.Length > 0)
                            {
                                var alias = item.Attribute("Alias")?.Value ?? item.Elements().FirstOrDefault(e => e.Name.LocalName == "Alias")?.Value ?? "";
                                var isStatic = (item.Attribute("Static")?.Value ?? item.Elements().FirstOrDefault(e => e.Name.LocalName == "Static")?.Value ?? "")
                                    .Equals("true", StringComparison.OrdinalIgnoreCase);
                                eval.Usings.Add(new UsingItem(include.Trim(), alias.Trim(), isStatic));
                            }
                            if (remove.Length > 0) eval.Usings.RemoveAll(u => u.Name == remove.Trim());
                            break;
                    }
                }
            }
            eval.Compile = compile.Where(f => f.EndsWith(".cs", StringComparison.Ordinal)).Distinct().ToList();
        }
    }

    static XDocument? Load(string path)
    {
        try { return XDocument.Load(path); } catch { return null; }
    }

    static IEnumerable<string> Split(string list) =>
        list.Split(';').Select(s => s.Trim().Replace('\\', '/')).Where(s => s.Length > 0);

    /// Files matching an MSBuild path pattern (`**`, `*`, `?`), relative to the project directory.
    static IEnumerable<string> Glob(string pattern, string projectDir)
    {
        pattern = pattern.Replace('\\', '/');
        var absolute = pattern.StartsWith('/') ? pattern : projectDir + "/" + pattern;
        absolute = Normalize(absolute);
        if (!absolute.Contains('*') && !absolute.Contains('?'))
            return File.Exists(absolute) && absolute.StartsWith(Root + "/", StringComparison.Ordinal) ? new[] { absolute } : Array.Empty<string>();
        var regex = new StringBuilder("^");
        for (var i = 0; i < absolute.Length; i++)
        {
            var c = absolute[i];
            if (c == '*' && i + 1 < absolute.Length && absolute[i + 1] == '*')
            {
                if (i + 2 < absolute.Length && absolute[i + 2] == '/') { regex.Append("(?:.*/)?"); i += 2; }
                else { regex.Append(".*"); i += 1; }
            }
            else if (c == '*') regex.Append("[^/]*");
            else if (c == '?') regex.Append("[^/]");
            else regex.Append(Regex.Escape(c.ToString()));
        }
        var matcher = new Regex(regex.Append('$').ToString(), RegexOptions.CultureInvariant);
        var prefix = absolute[..absolute.IndexOfAny(new[] { '*', '?' })];
        return AllCs.Where(f => f.StartsWith(prefix, StringComparison.Ordinal) && matcher.IsMatch(f));
    }

    static string Normalize(string path)
    {
        var parts = new List<string>();
        foreach (var part in path.Split('/'))
        {
            if (part == "..") { if (parts.Count > 1) parts.RemoveAt(parts.Count - 1); }
            else if (part != "." && (part.Length > 0 || parts.Count == 0)) parts.Add(part);
        }
        return string.Join("/", parts);
    }

    // ── Property expansion and conditions ───────────────────────────────────────────────────────────────

    static string Expand(string text, Evaluation eval, string fileDir)
    {
        string Prop(string name) => name.Equals("MSBuildThisFileDirectory", StringComparison.OrdinalIgnoreCase) ? fileDir + "/"
            : eval.Props.GetValueOrDefault(name, "");
        // `$(TargetFramework.StartsWith('net4'))` and friends.
        text = Regex.Replace(text, @"\$\(([A-Za-z_][\w]*)\.(StartsWith|EndsWith|Contains)\('([^']*)'\)\)", m =>
        {
            var value = Prop(m.Groups[1].Value);
            var arg = m.Groups[3].Value;
            var hit = m.Groups[2].Value switch
            {
                "StartsWith" => value.StartsWith(arg, StringComparison.Ordinal),
                "EndsWith" => value.EndsWith(arg, StringComparison.Ordinal),
                _ => value.Contains(arg, StringComparison.Ordinal),
            };
            return hit ? "true" : "false";
        });
        text = Regex.Replace(text, @"\$\(([A-Za-z_][\w]*)\)", m => Prop(m.Groups[1].Value));
        text = Regex.Replace(text, @"\$\(\[MSBuild\]::GetTargetFrameworkIdentifier\('([^']*)'\)\)", m => ParseTfm(m.Groups[1].Value).Id, RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\$\(\[MSBuild\]::GetTargetFrameworkVersion\('([^']*)'(?:,\s*\d+)?\)\)", m => ParseTfm(m.Groups[1].Value).Version, RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\$\(\[MSBuild\]::IsTargetFrameworkCompatible\('([^']*)',\s*'([^']*)'\)\)", m =>
        {
            var (aId, aVersion) = ParseTfm(m.Groups[1].Value);
            var (bId, bVersion) = ParseTfm(m.Groups[2].Value);
            return (aId == bId && new Version(aVersion) >= new Version(bVersion)) ? "true" : "false";
        }, RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\$\(\[MSBuild\]::VersionGreaterThanOrEquals\('([^']*)',\s*'([^']*)'\)\)", m =>
            Version.TryParse(m.Groups[1].Value, out var a) && Version.TryParse(m.Groups[2].Value, out var b) && a >= b ? "true" : "false", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"\$\(\[MSBuild\]::VersionLessThan\('([^']*)',\s*'([^']*)'\)\)", m =>
            Version.TryParse(m.Groups[1].Value, out var a) && Version.TryParse(m.Groups[2].Value, out var b) && a < b ? "true" : "false", RegexOptions.IgnoreCase);
        return text.Trim();
    }

    static bool Condition(XElement element, Evaluation eval, string fileDir)
    {
        var condition = element.Attribute("Condition")?.Value;
        if (string.IsNullOrWhiteSpace(condition)) return true;
        try { return new ConditionParser(Expand(condition, eval, fileDir), fileDir).Parse(); }
        catch { return false; }
    }

    /// `'a' == 'b'`, `!=`, `<`, `>=`…, `And`, `Or`, `!`, parentheses, `Exists('path')`, `HasTrailingSlash`.
    sealed class ConditionParser
    {
        readonly string text;
        readonly string dir;
        int pos;
        public ConditionParser(string text, string dir) { this.text = text; this.dir = dir; }

        public bool Parse()
        {
            var value = Or();
            Space();
            if (pos != text.Length) throw new FormatException(text);
            return value;
        }

        bool Or()
        {
            var value = And();
            while (Keyword("or")) value = And() | value;
            return value;
        }

        bool And()
        {
            var value = Unary();
            while (Keyword("and")) value = Unary() & value;
            return value;
        }

        bool Unary()
        {
            Space();
            if (Peek('!') && !(pos + 1 < text.Length && text[pos + 1] == '=')) { pos++; return !Unary(); }
            if (Peek('('))
            {
                pos++;
                var inner = Or();
                Space();
                Expect(')');
                return inner;
            }
            var left = Operand(out var isFunction, out var functionValue);
            if (isFunction) return functionValue;
            Space();
            foreach (var op in new[] { "==", "!=", "<=", ">=", "<", ">" })
            {
                if (string.CompareOrdinal(text, pos, op, 0, op.Length) != 0) continue;
                pos += op.Length;
                var right = Operand(out _, out _);
                return op switch
                {
                    "==" => string.Equals(left, right, StringComparison.OrdinalIgnoreCase),
                    "!=" => !string.Equals(left, right, StringComparison.OrdinalIgnoreCase),
                    _ => CompareNumbers(left, right, op),
                };
            }
            return left.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        static bool CompareNumbers(string a, string b, string op)
        {
            if (!Version.TryParse(a.TrimStart('v'), out var x) || !Version.TryParse(b.TrimStart('v'), out var y))
            {
                if (!double.TryParse(a, out var da) || !double.TryParse(b, out var db)) throw new FormatException(a + op + b);
                x = new Version((int)da, 0); y = new Version((int)db, 0);
            }
            return op switch { "<" => x < y, ">" => x > y, "<=" => x <= y, _ => x >= y };
        }

        string Operand(out bool isFunction, out bool functionValue)
        {
            isFunction = false;
            functionValue = false;
            Space();
            if (Peek('\''))
            {
                var end = text.IndexOf('\'', pos + 1);
                if (end < 0) throw new FormatException(text);
                var value = text.Substring(pos + 1, end - pos - 1);
                pos = end + 1;
                return value;
            }
            var start = pos;
            while (pos < text.Length && (char.IsLetterOrDigit(text[pos]) || text[pos] is '.' or '_' or '-')) pos++;
            var word = text[start..pos];
            if (word.Length == 0) throw new FormatException(text);
            Space();
            if (Peek('('))
            {
                pos++;
                var argument = Operand(out _, out _);
                Space();
                Expect(')');
                isFunction = true;
                functionValue = word.ToLowerInvariant() switch
                {
                    "exists" => argument.Length > 0 && (File.Exists(Resolve(argument)) || Directory.Exists(Resolve(argument))),
                    "hastrailingslash" => argument.EndsWith('/') || argument.EndsWith('\\'),
                    _ => throw new FormatException(word),
                };
            }
            return word;
        }

        string Resolve(string path)
        {
            path = path.Replace('\\', '/');
            return System.IO.Path.IsPathRooted(path) ? path : System.IO.Path.Combine(dir, path);
        }

        bool Keyword(string word)
        {
            Space();
            if (pos + word.Length > text.Length || string.Compare(text, pos, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) != 0) return false;
            if (pos + word.Length < text.Length && char.IsLetterOrDigit(text[pos + word.Length])) return false;
            pos += word.Length;
            return true;
        }

        bool Peek(char c) => pos < text.Length && text[pos] == c;
        void Expect(char c) { if (!Peek(c)) throw new FormatException(text); pos++; }
        void Space() { while (pos < text.Length && char.IsWhiteSpace(text[pos])) pos++; }
    }
}
