"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Can&apos;t reach the Hardwood API</h1>
      <p className="mt-2 text-stone-500">Check that it is running (`pnpm dev`) and try again.</p>
      <button
        onClick={reset}
        className="mt-4 rounded-md bg-wood-600 px-3 py-1.5 text-sm text-white"
      >
        Retry
      </button>
    </>
  );
}
