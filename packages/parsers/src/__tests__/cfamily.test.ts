import { describe, expect, it } from "vitest";
import { cParser } from "../parsers/cFamilyParser.js";
import { createParserRegistry } from "../registry.js";
import { extractCpgFacts } from "../treesitter/cpg.js";
import { initTreeSitter } from "../treesitter/runtime.js";
import { PARSER_VERSION } from "../types.js";
import { scanCIncludes } from "../utils/importScan.js";

await initTreeSitter({ languages: ["c", "cpp"] });

const SOURCE = `#include "util/strings.h"
#include <vector>
#include CONFIG_HEADER
/* #include "commented.h" */
namespace acme {
class Reader : public Base, private util::Helper {
 public:
  int read(int n);
};
int Reader::read(int n) { return helper::count(n) + parse(n); }
}
static int local(int n) { return parse(n); }
int parse(int n) { return n; }
`;

describe("C/C++ — graph facts", () => {
  const facts = extractCpgFacts({ path: "src/reader.cc", content: SOURCE });

  it("keeps the include form, skips macro includes and commented-out ones", () => {
    expect(facts.imports.map(({ source, system }) => [source, Boolean(system)])).toEqual([
      ["util/strings.h", false],
      ["vector", true],
    ]);
  });

  it("records non-static, non-member function definitions as what a call can reach", () => {
    expect(facts.declarations!.map((decl) => decl.name)).toEqual(["parse"]);
    expect(facts.calls.map((call) => call.symbol)).toEqual(expect.arrayContaining(["helper::count", "parse"]));
    expect(facts.inheritance.map((relation) => relation.symbol)).toEqual(["Base", "util::Helper"]);
  });

  it("a preprocessor condition the grammar misreads does not swallow the next includes (fmt)", () => {
    const content = '#include <thread>\n#if FMT_CPLUSPLUS > 201703L && FMT_HAS_INCLUDE(<version>)\n#  include <version>\n#endif\n\n#include <limits.h>\n#include "gtest-extra.h"\n#include "util.h"\n';
    expect(extractCpgFacts({ path: "test/format-test.cc", content }).imports.map((entry) => entry.source)).toEqual([
      "thread",
      "version",
      "limits.h",
      "gtest-extra.h",
      "util.h",
    ]);
  });
});

describe("C/C++ — Inventory and fallback", () => {
  it("projects functions, methods and types", () => {
    const parsed = createParserRegistry().parseFile({ path: "src/reader.cc", content: SOURCE });
    expect(parsed.language).toBe("cpp");
    expect(parsed.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Reader", "Reader::read", "local", "parse"]));
    expect(parsed.exports.map((entry) => entry.name)).toEqual(["parse"]);
  });

  it("the regex fallback still finds every include", () => {
    // A directive must start its line; `/* #include … */` does not.
    expect(scanCIncludes(SOURCE).map((entry) => entry.path)).toEqual(["util/strings.h", "vector"]);
    expect(cParser.parseFile({ path: "a.c", content: SOURCE }).parserVersion).toBe(PARSER_VERSION);
  });
});
