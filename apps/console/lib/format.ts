import type { BuildingUse } from "./api";

export const USE_LABEL: Record<BuildingUse, string> = {
  residential: "Residential",
  office: "Office",
  mixed_use: "Mixed use",
  retail: "Retail",
};

const n = new Intl.NumberFormat("en-US");
export const num = (v: number) => n.format(v);
export const m2 = (v: number) => `${n.format(v)} m²`;

/** Dates are stored in UTC and shown in Mexico City time. */
export const mxDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Mexico_City",
  }).format(new Date(iso));
