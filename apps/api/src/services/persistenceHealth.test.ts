import { afterEach, describe, expect, it, vi } from "vitest";
import type { DegradationNotice } from "@codeflow/shared-types";
import { persistenceDegradation, withPersistenceDegradation } from "./persistenceHealth.js";

// V3-P0 — Mongo-down must be VISIBLE. Hermetic: the connection check is mocked; no Mongo.
vi.mock("../db/connectMongo.js", () => ({
  isMongoConnected: vi.fn(() => true),
}));
const { isMongoConnected } = await import("../db/connectMongo.js");
const mockConnected = vi.mocked(isMongoConnected);

afterEach(() => {
  mockConnected.mockReturnValue(true);
});

describe("persistence degradation", () => {
  it("reports nothing while Mongo is connected", () => {
    mockConnected.mockReturnValue(true);
    expect(persistenceDegradation()).toBeNull();
    expect(withPersistenceDegradation(undefined)).toEqual([]);
  });

  it("reports a typed notice naming MONGO_URI when Mongo is down", () => {
    // The fallback to in-memory Maps stays; the SILENCE is what this removes.
    mockConnected.mockReturnValue(false);
    const notice = persistenceDegradation();
    expect(notice?.reason).toBe("mongo-unavailable");
    expect(notice?.detail).toContain("MONGO_URI");
    expect(notice?.detail).toMatch(/not survive a restart/i);
  });

  it("appends to the run's stored degradations without dropping them", () => {
    mockConnected.mockReturnValue(false);
    const stored: DegradationNotice[] = [{ reason: "no-chat-provider", detail: "no key" }];
    const merged = withPersistenceDegradation(stored);
    expect(merged.map((notice) => notice.reason)).toEqual(["no-chat-provider", "mongo-unavailable"]);
  });

  it("de-duplicates by reason so repeated reads cannot pile up copies", () => {
    mockConnected.mockReturnValue(false);
    const once = withPersistenceDegradation(undefined);
    const twice = withPersistenceDegradation(once);
    expect(twice).toHaveLength(1);
  });

  it("is computed live, not stored — it clears as soon as Mongo returns", () => {
    mockConnected.mockReturnValue(false);
    expect(withPersistenceDegradation(undefined)).toHaveLength(1);
    mockConnected.mockReturnValue(true);
    expect(withPersistenceDegradation(undefined)).toHaveLength(0);
  });
});
