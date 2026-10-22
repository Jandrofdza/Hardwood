import { PrismaPg } from "@prisma/adapter-pg";
import type { BuildingRepository } from "./buildings.js";
import { isUuid, toSummary } from "./buildings.js";
import { PrismaClient } from "./generated/prisma/client.js";

export function createPrisma(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type Db = ReturnType<typeof createPrisma>;

export class PrismaBuildingRepository implements BuildingRepository {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db.building.findMany({ orderBy: { name: "asc" } });
    return rows.map(toSummary);
  }

  async get(idOrSlug: string) {
    return this.db.building.findFirst({
      where: isUuid(idOrSlug) ? { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } : { slug: idOrSlug },
    });
  }
}
