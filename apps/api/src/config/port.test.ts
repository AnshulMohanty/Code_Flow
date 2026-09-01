import { describe, expect, it } from "vitest";
import { resolvePort } from "./port.js";

const base = { fallback: 4000, explicitName: "API_PORT" } as const;

describe("resolvePort", () => {
  it("falls back when neither variable is set", () => {
    expect(resolvePort({ ...base, explicit: undefined, platform: undefined })).toEqual({
      port: 4000,
      source: "default",
      warnings: [],
    });
  });

  it("takes the platform-assigned PORT when the operator set nothing", () => {
    // This is the case that mattered: on Render the platform assigns the port and the previous
    // code read only API_PORT, so the service bound 4000 and the proxy routed nowhere.
    expect(resolvePort({ ...base, explicit: undefined, platform: "10000" })).toEqual({
      port: 10000,
      source: "platform",
      warnings: [],
    });
  });

  it("lets an explicit API_PORT win, so an existing deployment is unchanged", () => {
    const resolved = resolvePort({ ...base, explicit: "4100", platform: undefined });
    expect(resolved.port).toBe(4100);
    expect(resolved.source).toBe("explicit");
    expect(resolved.warnings).toEqual([]);
  });

  it("warns when both are set and disagree, because one of them is being ignored", () => {
    const resolved = resolvePort({ ...base, explicit: "4100", platform: "10000" });
    expect(resolved.port).toBe(4100);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("overrides the platform-assigned PORT=10000");
  });

  it("stays quiet when both are set and agree", () => {
    expect(resolvePort({ ...base, explicit: "10000", platform: "10000" }).warnings).toEqual([]);
  });

  it("skips a value that is not a port, and says so", () => {
    // `Number(process.env.API_PORT || 4000)` produced NaN here, and `listen(NaN)` binds a RANDOM
    // free port — a failure that looks like success.
    for (const bad of ["abc", "0", "65536", "-1", "1e3", "0x50", "80.5", " "]) {
      const resolved = resolvePort({ ...base, explicit: bad, platform: undefined });
      expect(resolved.port, `explicit=${JSON.stringify(bad)}`).toBe(4000);
      expect(resolved.source).toBe("default");
      if (bad.trim() !== "") {
        expect(resolved.warnings.join(" ")).toContain("is not a port between 1 and 65535");
      }
    }
  });

  it("falls through to the platform port when the explicit one is unusable", () => {
    const resolved = resolvePort({ ...base, explicit: "not-a-port", platform: "10000" });
    expect(resolved.port).toBe(10000);
    expect(resolved.source).toBe("platform");
    expect(resolved.warnings.join(" ")).toContain('API_PORT="not-a-port"');
  });

  it("tolerates surrounding whitespace, which a dashboard paste leaves behind", () => {
    expect(resolvePort({ ...base, explicit: " 4100 ", platform: undefined }).port).toBe(4100);
    expect(resolvePort({ ...base, explicit: "", platform: undefined }).source).toBe("default");
  });

  it("accepts the boundary ports", () => {
    expect(resolvePort({ ...base, explicit: "1", platform: undefined }).port).toBe(1);
    expect(resolvePort({ ...base, explicit: "65535", platform: undefined }).port).toBe(65535);
  });
});
