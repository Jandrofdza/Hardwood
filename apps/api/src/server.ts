import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createPrisma, PrismaBuildingRepository } from "./db.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

const port = Number(process.env.API_PORT ?? 4000);
const app = createApp({ buildings: new PrismaBuildingRepository(createPrisma(url)) });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hardwood API listening on http://localhost:${info.port}`);
});
