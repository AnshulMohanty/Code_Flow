"""Ground truth for Python import resolution, from Python's own import machinery.

For every .py file: its imports are read with `ast` (the file is never executed), and each imported
name is located with `importlib.machinery.PathFinder` — the finder `import` itself uses — one dotted
segment at a time, so no package `__init__` ever runs. Relative imports resolve against the importing
file's package directory, as the import system does.

Search roots are how such a project is run: `src/` (when present) and the repository root, every nested
project (its own pyproject.toml / setup.py / setup.cfg, and its `src/`), and — as pytest's prepend mode
and `python -m` do — the first directory above the file that is not a package. File checks are
case-exact, as the import system's are, even on a case-insensitive filesystem.

`from pkg import name` targets the submodule `pkg.name` when one exists, else `pkg` itself (where the
name must then be an attribute): the import system loads the submodule in that case.

Usage:  python3 -I python-truth.py <repo>     (prints JSON on stdout)
"""
import ast
import json
import os
import sys
from importlib.machinery import PathFinder

SKIP = {".git", "node_modules", ".venv", "venv", "env", "build", "dist", ".tox", ".nox", "__pycache__", ".mypy_cache", ".pytest_cache", "site-packages"}


def rel(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


def origin_of(spec):
    if spec is None:
        return None
    return spec.origin if spec.origin and spec.origin.endswith(".py") else None


def find(name, roots):
    """Locate a dotted module without executing anything: segment by segment through PathFinder."""
    path = roots
    spec = None
    for segment in name.split("."):
        spec = PathFinder.find_spec(segment, path)
        if spec is None:
            return None
        path = list(spec.submodule_search_locations or [])
        if not path and segment != name.split(".")[-1]:
            return None
    return spec


def child(spec, name):
    locations = list(spec.submodule_search_locations or []) if spec else []
    return PathFinder.find_spec(name, locations) if locations else None


def exists_exact(path, kind):
    """Like os.path.isfile/isdir, but CASE-EXACT, as Python's import system is: on a case-insensitive
    filesystem (macOS) `models/Tenant.py` must not match `models/tenant.py`."""
    parent, name = os.path.split(path)
    try:
        if name not in os.listdir(parent):
            return False
    except OSError:
        return False
    return os.path.isfile(path) if kind == "file" else os.path.isdir(path)


def by_path(directory, dotted):
    """Relative imports: resolve on the filesystem, from the package directory."""
    base = os.path.join(directory, *dotted.split(".")) if dotted else directory
    if exists_exact(base + ".py", "file"):
        return base + ".py", None
    if exists_exact(base, "dir"):
        init = os.path.join(base, "__init__.py")
        return (init if exists_exact(init, "file") else None), base
    return None, None


def basedir(directory):
    """The first directory at or above `directory` that is not a package. pytest (prepend mode) and
    `python -m` from there both put it on sys.path, which is what makes a test package or a script
    package importable by its top-level name (django's tests/ and scripts/)."""
    current = directory
    while os.path.isfile(os.path.join(current, "__init__.py")):
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return current


def main():
    root = os.path.realpath(sys.argv[1])
    roots = [os.path.join(root, "src")] if os.path.isdir(os.path.join(root, "src")) else []
    roots.append(root)
    # Every Python PROJECT in the repository, as if installed: a directory with its own pyproject.toml /
    # setup.py / setup.cfg (flask's examples/tutorial is one) contributes itself and its src/.
    for directory, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith(".")]
        if directory != root and {"pyproject.toml", "setup.py", "setup.cfg"} & set(files):
            for candidate in (os.path.join(directory, "src"), directory):
                if os.path.isdir(candidate) and candidate not in roots:
                    roots.append(candidate)
    out = {}
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
        for file in sorted(files):
            if not file.endswith(".py"):
                continue
            path = os.path.join(directory, file)
            try:
                with open(path, "rb") as handle:
                    tree = ast.parse(handle.read(), filename=path)
            except (SyntaxError, ValueError):
                continue
            here = os.path.dirname(path)
            search = [basedir(here)] + roots
            entries = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        target = origin_of(find(alias.name, search))
                        entries.append({"source": alias.name, "targets": [target] if target else []})
                elif isinstance(node, ast.ImportFrom):
                    source = "." * node.level + (node.module or "")
                    targets = []
                    if node.level:
                        base = here
                        for _ in range(node.level - 1):
                            base = os.path.dirname(base)
                        module_file, module_dir = by_path(base, node.module or "")
                        package_dir = module_dir if module_dir else (base if not node.module else None)
                        for alias in node.names:
                            sub = by_path(package_dir, alias.name)[0] if package_dir and alias.name != "*" else None
                            if sub:
                                targets.append(sub)
                            elif module_file:
                                targets.append(module_file)
                    else:
                        spec = find(node.module, search)
                        module_file = origin_of(spec)
                        for alias in node.names:
                            sub = origin_of(child(spec, alias.name)) if alias.name != "*" else None
                            if sub:
                                targets.append(sub)
                            elif module_file:
                                targets.append(module_file)
                    entries.append({"source": source, "targets": sorted(set(targets))})
            in_repo = []
            for entry in entries:
                kept = [rel(root, t) for t in entry["targets"] if os.path.realpath(t).startswith(root + os.sep)]
                in_repo.append({"source": entry["source"], "targets": sorted(set(kept))})
            out[rel(root, path)] = in_repo
    json.dump({"files": out}, sys.stdout)


main()
