import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: join(import.meta.dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: {
    // `prisma generate` needs no database; fall back so it works without .env.
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/hardwood",
  },
});
