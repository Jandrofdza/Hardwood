import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

/** Tests import workspace packages from source, so they need no build step. */
export const workspaceAlias = [
  {
    find: /^@hardwood\/agents-core\/testing$/,
    replacement: src("agents-core/src/testing/index.ts"),
  },
  { find: /^@hardwood\/agents-core$/, replacement: src("agents-core/src/index.ts") },
  { find: /^@hardwood\/connectors\/testing$/, replacement: src("connectors/src/testing/index.ts") },
  { find: /^@hardwood\/connectors$/, replacement: src("connectors/src/index.ts") },
  { find: /^@hardwood\/agent-utilities$/, replacement: src("agent-utilities/src/index.ts") },
];
