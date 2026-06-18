import { describe, expect, it } from "vitest";
import { pythonParser } from "../parsers/pythonParser.js";

describe("pythonParser", () => {
  it("extracts imports, functions, classes, and methods", () => {
    const parsed = pythonParser.parseFile({
      path: "pkg/service.py",
      content: `
import os, sys as system
from .models import User
from package.module import thing as alias

class Service:
    def __init__(self):
        pass

    async def load(self):
        return None

def build_service():
    return Service()
`,
    });

    expect(parsed.language).toBe("python");
    expect(parsed.imports.map((item) => item.source)).toEqual(["os", "sys", ".models", "package.module"]);
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Service", kind: "class" }),
        expect.objectContaining({ name: "__init__", kind: "method" }),
        expect.objectContaining({ name: "load", kind: "method" }),
        expect.objectContaining({ name: "build_service", kind: "function" }),
      ]),
    );
    expect(parsed.dependencies).toHaveLength(4);
  });
});
