// Enforces the dependency direction from PLAN.md section 3 on package manifests
// and on source imports, so the rule holds even if lint is skipped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function workspaces(dir: string) {
  return readdirSync(join(root, dir))
    .map((name) => join(root, dir, name))
    .filter((p) => statSync(p).isDirectory() && safeRead(join(p, "package.json")));
}

function safeRead(p: string) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory())
      return ["node_modules", "dist", "generated", ".next"].includes(e.name) ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

function allowedFor(name: string): string[] | "any" {
  if (name === "@hardwood/agents-core") return [];
  if (name.startsWith("@hardwood/agent-") || name === "@hardwood/connectors")
    return ["@hardwood/agents-core"];
  return "any";
}

const pkgs = [...workspaces("packages"), ...workspaces("apps")].map((dir) => ({
  dir,
  manifest: JSON.parse(safeRead(join(dir, "package.json")) ?? "{}") as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
}));

describe("dependency rules", () => {
  it("finds the workspaces", () => {
    expect(pkgs.map((p) => p.manifest.name)).toContain("@hardwood/agents-core");
  });

  for (const { dir, manifest } of pkgs) {
    const allowed = allowedFor(manifest.name);
    if (allowed === "any") continue;

    it(`${manifest.name} depends only on ${allowed.join(", ") || "no internal packages"}`, () => {
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      expect(deps.filter((d) => d.startsWith("@hardwood/") && !allowed.includes(d))).toEqual([]);
      const bad = sourceFiles(join(dir, "src")).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/from\s+["'](@hardwood\/[^"'/]+)/g)]
          .map((m) => m[1] ?? "")
          .filter((spec) => !allowed.includes(spec))
          .map((spec) => `${file}: ${spec}`),
      );
      expect(bad).toEqual([]);
    });
  }

  it("no package depends on an app", () => {
    const appNames = pkgs.filter((p) => p.dir.includes("/apps/")).map((p) => p.manifest.name);
    for (const { dir, manifest } of pkgs.filter((p) => p.dir.includes("/packages/"))) {
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      expect(
        deps.filter((d) => appNames.includes(d)),
        dir,
      ).toEqual([]);
    }
  });
});
