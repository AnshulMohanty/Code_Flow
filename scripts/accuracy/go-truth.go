// Ground truth for Go import resolution, from the Go toolchain itself.
//
// For every .go file the go tool would see: its import paths, parsed by go/parser.
// For every module (each go.mod): `go list -e -deps -test` from that module's directory, which
// says which DIRECTORY each import path resolves to under that module's own go.mod (replace
// directives, nested modules, vendoring). Output is JSON on stdout.
//
// GOPATH-era repositories (no go.mod) are scored with CODEFLOW_GOPATH_IMPORT=<import path>: the
// repo must then be mounted at $GOPATH/src/<import path>, and go list runs once, in GOPATH mode.
//
// It uses each repository's own settings (vendoring, go.work), as a real build would, and
// follows symlinks so a vendored copy that links into the repo resolves to the real directory.
// Loading the module graph downloads dependencies; mount a module cache to make reruns fast.
package main

import (
	"bufio"
	"encoding/json"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type pkg struct {
	ImportPath string
	Dir        string
	Standard   bool
}

func main() {
	root, _ := filepath.Abs(os.Args[1])
	if linked, err := filepath.EvalSymlinks(root); err == nil {
		root = linked
	}
	out := struct {
		Imports map[string][]string          `json:"imports"`
		Modules map[string]map[string]string `json:"modules"`
		Errors  map[string]string            `json:"errors"`
	}{map[string][]string{}, map[string]map[string]string{}, map[string]string{}}

	var moduleDirs []string
	fset := token.NewFileSet()
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if p != root && (name == "vendor" || name == "testdata" || name == "node_modules" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_")) {
				return filepath.SkipDir
			}
			return nil
		}
		if name == "go.mod" {
			moduleDirs = append(moduleDirs, filepath.Dir(p))
		}
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		f, err := parser.ParseFile(fset, p, nil, parser.ImportsOnly)
		if err != nil {
			return nil
		}
		rel := rel(root, p)
		for _, im := range f.Imports {
			if s, err := strconv.Unquote(im.Path.Value); err == nil {
				out.Imports[rel] = append(out.Imports[rel], s)
			}
		}
		return nil
	})

	gopathMode := os.Getenv("CODEFLOW_GOPATH_IMPORT") != ""
	if gopathMode {
		moduleDirs = []string{root}
	}
	for _, dir := range moduleDirs {
		cmd := exec.Command("go", "list", "-e", "-deps", "-test", "-json=ImportPath,Dir,Standard", "./...")
		cmd.Dir = dir
		if gopathMode {
			cmd.Env = append(os.Environ(), "GO111MODULE=off")
		}
		var stderr strings.Builder
		cmd.Stderr = &stderr
		stdout, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			continue
		}
		resolved := map[string]string{}
		dec := json.NewDecoder(bufio.NewReader(stdout))
		for {
			var p pkg
			if err := dec.Decode(&p); err != nil {
				break
			}
			path := p.ImportPath
			if i := strings.Index(path, " ["); i >= 0 { // test variant: "pkg [pkg.test]"
				path = path[:i]
			}
			if p.Standard || p.Dir == "" || strings.HasSuffix(path, ".test") {
				continue
			}
			real := p.Dir
			if linked, err := filepath.EvalSymlinks(p.Dir); err == nil {
				real = linked
			}
			r := rel(root, real)
			if strings.HasPrefix(r, "..") || r == "vendor" || strings.HasPrefix(r, "vendor/") || strings.Contains(r, "/vendor/") {
				continue // outside the repository, or a vendored third-party copy
			}
			resolved[path] = r
		}
		cmd.Wait()
		out.Modules[rel(root, dir)] = resolved
		if msg := stderr.String(); msg != "" {
			if len(msg) > 2000 {
				msg = msg[:2000]
			}
			out.Errors[rel(root, dir)] = msg
		}
	}
	json.NewEncoder(os.Stdout).Encode(out)
}

func rel(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return ".."
	}
	r = filepath.ToSlash(r)
	if r == "." {
		return ""
	}
	return r
}
