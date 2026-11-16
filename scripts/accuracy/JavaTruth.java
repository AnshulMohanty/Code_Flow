// Ground truth for Java name resolution, from javac itself (the Compiler Tree API).
//
// Every .java file in the repository is parsed and ATTRIBUTED in one javac task — the same
// resolution javac performs when it compiles. Then every name in the source (identifiers and
// qualified names, in imports and in code) is asked "which element does this resolve to?". When
// the answer is a type declared in this repository, the edge (file -> file declaring the outermost
// type) is recorded. External libraries are not on the classpath, so names into them do not
// resolve — which is correct: they are not repository edges. javac keeps attributing past those
// errors, so in-repo names still resolve.
//
// Usage: java JavaTruth.java <repo>     (JDK 17+; prints JSON on stdout)
import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;
import javax.lang.model.element.*;
import javax.tools.*;

public class JavaTruth {
    static final Set<String> SKIP = Set.of(".git", "node_modules", "target", "build", "out", "bin", ".gradle", ".idea");

    public static void main(String[] args) throws IOException {
        Path root = Path.of(args[0]).toRealPath();
        List<Path> files;
        try (Stream<Path> walk = Files.walk(root)) {
            files = walk.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> !p.getFileName().toString().equals("module-info.java"))
                    .filter(p -> root.relativize(p).getNameCount() > 0 && StreamSupport.stream(root.relativize(p).spliterator(), false)
                            .noneMatch(seg -> SKIP.contains(seg.toString())))
                    .sorted().collect(Collectors.toList());
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        StandardJavaFileManager fm = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8);
        int[] errors = {0};
        DiagnosticListener<JavaFileObject> quiet = d -> { if (d.getKind() == Diagnostic.Kind.ERROR) errors[0]++; };
        List<String> options = List.of("-proc:none", "-implicit:none", "-encoding", "UTF-8",
                "-XDshould-stop.ifError=FLOW", "-XDshould-stop.ifNoError=FLOW", "-Xlint:none", "-nowarn");
        JavacTask task = (JavacTask) compiler.getTask(null, fm, quiet, options, null, fm.getJavaFileObjectsFromPaths(files));
        Iterable<? extends CompilationUnitTree> units = task.parse();
        task.analyze();
        Trees trees = Trees.instance(task);
        SourcePositions positions = trees.getSourcePositions();

        // Outermost type element -> repo-relative file, from the declarations themselves.
        Map<Element, String> declaredIn = new HashMap<>();
        for (CompilationUnitTree unit : units) {
            String rel = rel(root, unit);
            for (Tree decl : unit.getTypeDecls()) {
                Element e = trees.getElement(TreePath.getPath(unit, decl));
                if (e != null) declaredIn.put(e, rel);
            }
        }

        Map<String, TreeSet<String>> edges = new TreeMap<>();
        for (CompilationUnitTree unit : units) {
            String from = rel(root, unit);
            TreeSet<String> targets = edges.computeIfAbsent(from, k -> new TreeSet<>());
            new TreePathScanner<Void, Void>() {
                void record() {
                    // Names javac SYNTHESISED (the inferred type of an untyped lambda parameter, of
                    // `var`) are not written in the source and have no end position: skip them.
                    if (positions.getEndPosition(unit, getCurrentPath().getLeaf()) == Diagnostic.NOPOS) return;
                    Element e = trees.getElement(getCurrentPath());
                    if (e == null) return;
                    // A static member (`Util.call`, an import static) depends on its declaring type.
                    if (!(e instanceof TypeElement)) {
                        if (e.getKind() == ElementKind.PACKAGE || !(e.getEnclosingElement() instanceof TypeElement)) return;
                        if (!e.getModifiers().contains(Modifier.STATIC)) return;
                        if (!(getCurrentPath().getParentPath().getLeaf() instanceof ImportTree)) return;
                        e = e.getEnclosingElement();
                    }
                    while (e.getEnclosingElement() instanceof TypeElement) e = e.getEnclosingElement();
                    String to = declaredIn.get(e);
                    if (to != null && !to.equals(from)) targets.add(to);
                }
                @Override public Void visitIdentifier(IdentifierTree t, Void v) { record(); return super.visitIdentifier(t, v); }
                @Override public Void visitMemberSelect(MemberSelectTree t, Void v) { record(); return super.visitMemberSelect(t, v); }
            }.scan(unit, null);
        }

        StringBuilder out = new StringBuilder("{\"files\":").append(files.size()).append(",\"javacErrors\":").append(errors[0]).append(",\"edges\":{");
        boolean first = true;
        for (Map.Entry<String, TreeSet<String>> entry : edges.entrySet()) {
            if (!first) out.append(',');
            first = false;
            out.append(json(entry.getKey())).append(":[");
            out.append(entry.getValue().stream().map(JavaTruth::json).collect(Collectors.joining(",")));
            out.append(']');
        }
        System.out.println(out.append("}}"));
    }

    static String rel(Path root, CompilationUnitTree unit) {
        return root.relativize(Path.of(unit.getSourceFile().toUri())).toString().replace('\\', '/');
    }

    static String json(String s) {
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }
}
