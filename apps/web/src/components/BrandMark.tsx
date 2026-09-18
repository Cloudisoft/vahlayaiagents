// Placeholder brand mark — swap for the real Vahlay Consulting logo file
// (e.g. drop it at src/assets/logo.png and replace this with an <img>) once
// it's provided. Kept as a single component so that's a one-file change.
export default function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <div
      className="rounded-full bg-red-600 flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      V
    </div>
  );
}
