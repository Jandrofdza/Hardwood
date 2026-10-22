import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { InMemoryBuildingRepository } from "./buildings.js";
import { DEMO_BUILDINGS } from "./seed-data.js";

const app = createApp({ buildings: new InMemoryBuildingRepository(DEMO_BUILDINGS) });

describe("buildings API", () => {
  it("reports health", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("lists buildings sorted by name as summaries", async () => {
    const res = await app.request("/v1/buildings");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { name: string; street?: string }[] };
    expect(items).toHaveLength(DEMO_BUILDINGS.length);
    expect(items.map((b) => b.name)).toEqual(
      [...items.map((b) => b.name)].sort((a, b) => a.localeCompare(b)),
    );
    expect(items[0]).not.toHaveProperty("street");
  });

  it("gets a building by slug and by id", async () => {
    const bySlug = await app.request("/v1/buildings/torre-demo");
    expect(bySlug.status).toBe(200);
    const b = (await bySlug.json()) as { id: string; alcaldia: string; floors: number };
    expect(b.alcaldia).toBe("Miguel Hidalgo");
    const byId = await app.request(`/v1/buildings/${b.id}`);
    expect(((await byId.json()) as { floors: number }).floors).toBe(b.floors);
  });

  it("returns 404 for unknown buildings and routes", async () => {
    expect((await app.request("/v1/buildings/nope")).status).toBe(404);
    expect((await app.request(`/v1/buildings/${"x".repeat(200)}`)).status).toBe(404);
    expect((await app.request("/v2/whatever")).status).toBe(404);
  });

  it("returns 500 without leaking errors", async () => {
    const broken = createApp({
      buildings: {
        list: () => Promise.reject(new Error("db down: secret")),
        get: () => Promise.resolve(null),
      },
    });
    const res = await broken.request("/v1/buildings");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
  });
});

describe("demo data", () => {
  it("is in Mexico City with unique slugs", () => {
    expect(new Set(DEMO_BUILDINGS.map((b) => b.slug)).size).toBe(DEMO_BUILDINGS.length);
    for (const b of DEMO_BUILDINGS) {
      expect(b.city).toBe("Ciudad de México");
      expect(b.lat).toBeGreaterThan(19.0);
      expect(b.lat).toBeLessThan(19.6);
      expect(b.lng).toBeGreaterThan(-99.4);
      expect(b.lng).toBeLessThan(-98.9);
    }
  });
});
