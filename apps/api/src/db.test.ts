// Integration tests against a real Postgres. Set TEST_DATABASE_URL to run them (CI does).
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Db } from "./db.js";
import { createPrisma, PrismaBuildingRepository } from "./db.js";
import { DEMO_BUILDINGS } from "./seed-data.js";

const url = process.env.TEST_DATABASE_URL;
if (url && url === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must point at a separate database: these tests delete rows");
}

describe.skipIf(!url)("Postgres building repository", () => {
  let db: Db;
  let repo: PrismaBuildingRepository;

  beforeAll(async () => {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATABASE_URL: url },
      stdio: "ignore",
    });
    db = createPrisma(url ?? "");
    repo = new PrismaBuildingRepository(db);
    await db.building.deleteMany();
    await db.building.createMany({ data: DEMO_BUILDINGS });
  }, 60_000);

  afterAll(() => db?.$disconnect());

  it("lists all buildings by name", async () => {
    const items = await repo.list();
    expect(items).toHaveLength(DEMO_BUILDINGS.length);
    expect(items[0]?.name).toBe("Conjunto Juárez");
  });

  it("finds by slug and id, and misses cleanly", async () => {
    const b = await repo.get("edificio-alamo");
    expect(b?.yearBuilt).toBe(1938);
    expect((await repo.get(b?.id ?? ""))?.slug).toBe("edificio-alamo");
    expect(await repo.get("missing")).toBeNull();
    expect(await repo.get("00000000-0000-4000-8000-999999999999")).toBeNull();
  });

  it("serves the API from the database", async () => {
    const app = createApp({ buildings: repo });
    const res = await app.request("/v1/buildings/torre-del-valle");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { units: number }).units).toBe(90);
  });
});
