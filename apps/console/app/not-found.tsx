import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Building not found</h1>
      <Link href="/" className="mt-4 inline-block text-sm underline">
        Back to all buildings
      </Link>
    </>
  );
}
