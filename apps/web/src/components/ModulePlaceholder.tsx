export default function ModulePlaceholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900 mb-2">{title}</h1>
      <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-4">
        {title} is not built yet — it lands in <strong>{phase}</strong> of the build plan. This screen
        intentionally shows no data rather than placeholders or mock results.
      </div>
    </div>
  );
}
