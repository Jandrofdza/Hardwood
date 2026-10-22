import { Hono } from "hono";
import type { BuildingRepository } from "./buildings.js";

export type AppDeps = { buildings: BuildingRepository };

export function createApp({ buildings }: AppDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/v1/buildings", async (c) => c.json({ items: await buildings.list() }));

  app.get("/v1/buildings/:idOrSlug", async (c) => {
    const key = c.req.param("idOrSlug");
    if (key.length > 100) return c.json({ error: "not_found" }, 404);
    const building = await buildings.get(key);
    return building ? c.json(building) : c.json({ error: "not_found" }, 404);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
