import { join } from "node:path";
import { config } from "dotenv";
import { createPrisma } from "../src/db.js";
import { DEMO_BUILDINGS } from "../src/seed-data.js";

config({ path: join(import.meta.dirname, "../../../.env"), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const db = createPrisma(url);
for (const b of DEMO_BUILDINGS) {
  await db.building.upsert({ where: { slug: b.slug }, create: b, update: b });
}
console.log(`Seeded ${DEMO_BUILDINGS.length} buildings`);
await db.$disconnect();
