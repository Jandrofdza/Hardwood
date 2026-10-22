import Link from "next/link";
import { listBuildings } from "@/lib/api";
import { num, USE_LABEL } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BuildingsPage() {
  const buildings = await listBuildings();
  return (
    <>
      <h1 className="text-2xl font-semibold">Buildings</h1>
      <p className="mt-1 text-sm text-stone-500">
        {buildings.length} buildings in Ciudad de México
      </p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {buildings.map((b) => (
          <li key={b.id}>
            <Link
              href={`/buildings/${b.slug}`}
              className="block rounded-xl border border-stone-200 bg-white p-5 transition hover:border-wood-600 dark:border-stone-800 dark:bg-stone-900"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold">{b.name}</h2>
                <span className="rounded-full bg-wood-100 px-2 py-0.5 text-xs font-medium text-wood-800">
                  {USE_LABEL[b.use]}
                </span>
              </div>
              <p className="mt-1 text-sm text-stone-500">
                {b.colonia}, {b.alcaldia}
              </p>
              <p className="mt-4 text-sm tabular-nums text-stone-700 dark:text-stone-300">
                Built {b.yearBuilt} · {b.floors} floors · {num(b.units)} units
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
