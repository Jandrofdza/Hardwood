import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getBuilding } from "@/lib/api";
import { m2, mxDate, num, USE_LABEL } from "@/lib/format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const b = await getBuilding((await params).slug);
  return { title: b ? `${b.name} · Hardwood` : "Not found · Hardwood" };
}

export default async function BuildingPage({ params }: Props) {
  const b = await getBuilding((await params).slug);
  if (!b) notFound();

  const age = new Date().getFullYear() - b.yearBuilt;
  const facts: [string, string][] = [
    ["Use", USE_LABEL[b.use]],
    ["Year built", `${b.yearBuilt} (${age} years)`],
    ["Floors", b.basementLevels ? `${b.floors} + ${b.basementLevels} below ground` : `${b.floors}`],
    ["Units", num(b.units)],
    ["Gross area", m2(b.grossAreaM2)],
    ["Lot area", b.lotAreaM2 ? m2(b.lotAreaM2) : "—"],
    ["Parking spaces", num(b.parkingSpaces)],
    ["Elevators", num(b.elevators)],
  ];
  const osm = `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=17/${b.lat}/${b.lng}`;

  return (
    <>
      <Link href="/" className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-white">
        ← All buildings
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{b.name}</h1>
      <p className="mt-1 text-stone-500">
        {b.street}, {b.colonia}, C.P. {b.postalCode}, {b.alcaldia}, {b.city}
      </p>
      <p className="mt-4 max-w-2xl">{b.description}</p>

      <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-stone-200 bg-stone-200 sm:grid-cols-4 dark:border-stone-800 dark:bg-stone-800">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-white p-4 dark:bg-stone-900">
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="mt-1 font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-6 text-sm text-stone-500">
        <a
          href={osm}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-stone-900 dark:hover:text-white"
        >
          {b.lat.toFixed(4)}, {b.lng.toFixed(4)} on OpenStreetMap
        </a>
        {" · "}Updated {mxDate(b.updatedAt)}
      </p>
    </>
  );
}
