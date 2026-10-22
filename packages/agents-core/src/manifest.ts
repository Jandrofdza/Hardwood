import type { z } from "zod";
import { HardwoodError } from "./errors.js";

export const CAPABILITIES = [
  "accounts:read",
  "accounts:write",
  "bills:read",
  "payments:request",
  "payments:execute",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Something a caller (user, host, schedule or model) can ask an agent to do.
 * `read` actions complete without approval; `payment` actions always stop for one.
 */
export type ActionDef = {
  name: string;
  description: string;
  input: z.ZodType;
  capability: Capability;
  effect: "read" | "payment";
};

export type AgentManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: Capability[];
  actions: ActionDef[];
  settingsSchema: z.ZodType;
};

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ACTION = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Validate a manifest once, at registration. Throws on any inconsistency. */
export function defineAgent(manifest: AgentManifest): AgentManifest {
  const fail = (msg: string) => {
    throw new HardwoodError("invalid_input", `manifest ${manifest.id}: ${msg}`);
  };
  if (!SLUG.test(manifest.id)) fail("id must be a lowercase slug");
  if (!SEMVER.test(manifest.version)) fail("version must be semver");
  if (!manifest.name.trim()) fail("name is required");
  if (manifest.actions.length === 0) fail("at least one action is required");

  const names = new Set<string>();
  for (const a of manifest.actions) {
    if (!ACTION.test(a.name)) fail(`action ${a.name} must be snake_case`);
    if (names.has(a.name)) fail(`duplicate action ${a.name}`);
    names.add(a.name);
    if (!manifest.capabilities.includes(a.capability)) {
      fail(`action ${a.name} uses undeclared capability ${a.capability}`);
    }
    // Execution is the engine's job after approval; nobody can request it as an action.
    if (a.capability === "payments:execute") fail(`action ${a.name} cannot be payments:execute`);
    if (a.effect === "payment" && a.capability !== "payments:request") {
      fail(`payment action ${a.name} must use payments:request`);
    }
  }
  return manifest;
}

export function findAction(manifest: AgentManifest, name: string): ActionDef | undefined {
  return manifest.actions.find((a) => a.name === name);
}
