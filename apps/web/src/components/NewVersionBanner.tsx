import { useEffect, useState } from "react";

// A tab opened before a deploy keeps running the old code. Compare the
// bundle this tab loaded with the one the server serves now, and offer a
// reload when they differ.
function loadedBundle(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src;
  return src?.match(/index-[\w-]+\.js/)?.[0] ?? null;
}

export default function NewVersionBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = loadedBundle();
    if (!mine) return; // dev server: no hashed bundle
    let stopped = false;
    async function check() {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const html = await fetch("/", { cache: "no-store" }).then((r) => r.text());
        const live = html.match(/index-[\w-]+\.js/)?.[0];
        if (live && live !== mine) setStale(true);
      } catch {
        // offline; try again later
      }
    }
    const timer = window.setInterval(check, 3 * 60 * 1000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-sm text-amber-900 flex items-center justify-center gap-3">
      A new version of VahlaySmartAI is available.
      <button onClick={() => window.location.reload()} className="font-semibold underline">Reload now</button>
    </div>
  );
}
