import { z } from "zod";

export const BUILDING_USES = ["residential", "office", "mixed_use", "retail"] as const;

/** Shape of a building as stored and as returned by the API. */
export const buildingSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1),
  street: z.string().min(1),
  colonia: z.string().min(1),
  alcaldia: z.string().min(1),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  use: z.enum(BUILDING_USES),
  yearBuilt: z.number().int().min(1500).max(2100),
  floors: z.number().int().min(1),
  basementLevels: z.number().int().min(0),
  units: z.number().int().min(0),
  grossAreaM2: z.number().int().positive(),
  lotAreaM2: z.number().int().positive().nullable(),
  parkingSpaces: z.number().int().min(0),
  elevators: z.number().int().min(0),
  description: z.string(),
});

export type BuildingInput = z.infer<typeof buildingSchema>;

export type Building = BuildingInput & { id: string; createdAt: Date; updatedAt: Date };

export type BuildingSummary = Pick<
  Building,
  "id" | "slug" | "name" | "colonia" | "alcaldia" | "use" | "yearBuilt" | "floors" | "units"
>;

export interface BuildingRepository {
  list(): Promise<BuildingSummary[]>;
  /** Look up by UUID or slug. */
  get(idOrSlug: string): Promise<Building | null>;
}

export const toSummary = (b: Building): BuildingSummary => ({
  id: b.id,
  slug: b.slug,
  name: b.name,
  colonia: b.colonia,
  alcaldia: b.alcaldia,
  use: b.use,
  yearBuilt: b.yearBuilt,
  floors: b.floors,
  units: b.units,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

export class InMemoryBuildingRepository implements BuildingRepository {
  private readonly items: Building[];

  constructor(inputs: BuildingInput[]) {
    const at = new Date("2026-01-01T00:00:00Z");
    this.items = inputs.map((b, i) => ({
      ...b,
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      createdAt: at,
      updatedAt: at,
    }));
  }

  async list() {
    return [...this.items].sort((a, b) => a.name.localeCompare(b.name)).map(toSummary);
  }

  async get(idOrSlug: string) {
    return this.items.find((b) => b.id === idOrSlug || b.slug === idOrSlug) ?? null;
  }
}
