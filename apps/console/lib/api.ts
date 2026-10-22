// Typed access to the Hardwood API. Server-side only: the console renders on the server
// and the browser never talks to the API directly.

export type BuildingUse = "residential" | "office" | "mixed_use" | "retail";

export type BuildingSummary = {
  id: string;
  slug: string;
  name: string;
  colonia: string;
  alcaldia: string;
  use: BuildingUse;
  yearBuilt: number;
  floors: number;
  units: number;
};

export type Building = BuildingSummary & {
  street: string;
  postalCode: string;
  city: string;
  lat: number;
  lng: number;
  basementLevels: number;
  grossAreaM2: number;
  lotAreaM2: number | null;
  parkingSpaces: number;
  elevators: number;
  description: string;
  updatedAt: string;
};

const base = () => process.env.HARDWOOD_API_URL ?? "http://localhost:4000";

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`${base()}${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return (await res.json()) as T;
}

export async function listBuildings(): Promise<BuildingSummary[]> {
  return (await get<{ items: BuildingSummary[] }>("/v1/buildings"))?.items ?? [];
}

export function getBuilding(slug: string): Promise<Building | null> {
  return get<Building>(`/v1/buildings/${encodeURIComponent(slug)}`);
}
