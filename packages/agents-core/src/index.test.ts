import { describe, expect, it } from "vitest";
import { AGENTS_CORE_VERSION } from "./index.js";

describe("agents-core", () => {
  it("exports a version", () => {
    expect(AGENTS_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
