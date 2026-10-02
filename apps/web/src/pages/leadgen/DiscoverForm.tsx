import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { Banner, Btn, Card, Field, I, Icon, inputCls } from "../../components/ui.js";
import type { Meta } from "./shared.js";

interface Loc { country: string; state: string; city: string; zip: string }
const COUNTRIES = [["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"], ["IN", "India"], ["AE", "UAE"], ["DE", "Germany"], ["FR", "France"]];
const blank: Loc = { country: "US", state: "", city: "", zip: "" };

// "Find [industry] businesses in [location] matching [criteria]."
export default function DiscoverForm({ meta, onCreated }: { meta: Meta; onCreated: (jobId: string) => void }) {
  const [industry, setIndustry] = useState("");
  const [keywords, setKeywords] = useState("");
  const [services, setServices] = useState("");
  const [locs, setLocs] = useState<Loc[]>([{ ...blank }]);
  const [website, setWebsite] = useState<"any" | "has" | "missing">("any");
  const [requirePhone, setRequirePhone] = useState(false);
  const [requireEmail, setRequireEmail] = useState(false);
  const [size, setSize] = useState<"any" | "single" | "multi">("any");
  const [opps, setOpps] = useState<string[]>([]);
  const [ideal, setIdeal] = useState("");
  const [threshold, setThreshold] = useState(70);
  const [maxResults, setMaxResults] = useState(300);
  const [sources, setSources] = useState<string[]>(meta.sources.filter((s) => s.available).map((s) => s.key));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, Meta["industries"]>();
    for (const i of meta.industries) m.set(i.group, [...(m.get(i.group) ?? []), i]);
    return Array.from(m.entries());
  }, [meta]);
  const validLocs = locs.filter((l) => l.state.trim() || l.city.trim() || l.zip.trim());
  const indLabel = meta.industries.find((i) => i.key === industry)?.label;
  const sentence = `Find ${indLabel ?? (keywords || services || "…")} businesses in ${validLocs.map((l) => [l.zip, l.city, l.state].filter(Boolean).join(" ")).join(" · ") || "…"}${website === "missing" ? " without a website" : website === "has" ? " with a website" : ""}${requirePhone ? ", with a phone" : ""}${requireEmail ? ", with an email" : ""}`;

  async function submit() {
    setErr(null);
    if (!industry && !keywords.trim() && !services.trim()) return setErr("Choose an industry or enter keywords.");
    if (!validLocs.length) return setErr("Add at least one location (state, city or ZIP).");
    if (!sources.length) return setErr("Choose at least one data source.");
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/leadgen/discover", {
        method: "POST",
        body: {
          name: name || undefined,
          sources,
          maxResults,
          criteria: {
            industry: industry || null,
            keywords,
            services,
            locations: validLocs.map((l) => ({ country: l.country, ...(l.state.trim() ? { state: l.state.trim() } : {}), ...(l.city.trim() ? { city: l.city.trim() } : {}), ...(l.zip.trim() ? { zip: l.zip.trim() } : {}) })),
            website,
            requirePhone,
            requireEmail,
            size,
            opportunities: opps,
            idealCustomer: ideal,
            qualifyThreshold: threshold,
          },
        },
      });
      onCreated(r.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't start discovery.");
    } finally {
      setBusy(false);
    }
  }

  const setLoc = (i: number, v: Partial<Loc>) => setLocs(locs.map((l, k) => (k === i ? { ...l, ...v } : l)));
  const chip = (on: boolean) => `text-xs rounded-full px-3 py-1 border transition-colors ${on ? "bg-red-600 text-white border-red-600" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`;

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-5">
        <Card title="1 · Who are you looking for?">
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Industry">
                <select className={inputCls} value={industry} onChange={(e) => setIndustry(e.target.value)}>
                  <option value="">Any (use keywords)</option>
                  {groups.map(([g, list]) => (
                    <optgroup key={g} label={g}>{list.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</optgroup>
                  ))}
                </select>
              </Field>
              <Field label="Keywords" hint="Words in the business name or category, comma separated"><input className={inputCls} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. metal roofing, commercial" /></Field>
            </div>
            <Field label="Services or products they offer (optional)"><input className={inputCls} value={services} onChange={(e) => setServices(e.target.value)} placeholder="e.g. storm damage repair" /></Field>
          </div>
        </Card>

        <Card title="2 · Where?">
          <div className="space-y-2">
            {locs.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center animate-fade-in">
                <select className={`${inputCls} col-span-3`} value={l.country} onChange={(e) => setLoc(i, { country: e.target.value })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
                <input className={`${inputCls} col-span-3`} placeholder="State" value={l.state} onChange={(e) => setLoc(i, { state: e.target.value })} />
                <input className={`${inputCls} col-span-3`} placeholder="City" value={l.city} onChange={(e) => setLoc(i, { city: e.target.value })} />
                <input className={`${inputCls} col-span-2`} placeholder="ZIP" value={l.zip} onChange={(e) => setLoc(i, { zip: e.target.value })} />
                <button type="button" className="col-span-1 text-slate-400 hover:text-red-600 disabled:opacity-30" disabled={locs.length === 1} onClick={() => setLocs(locs.filter((_, k) => k !== i))} aria-label="Remove location"><Icon d={I.x} size={16} /></button>
              </div>
            ))}
            {locs.length < 25 && <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => setLocs([...locs, { ...blank, country: locs[locs.length - 1].country, state: locs[locs.length - 1].state }])}>+ Add location</button>}
            <p className="text-xs text-slate-500">Each location is searched separately in every source, then results are combined without duplicates.</p>
          </div>
        </Card>

        <Card title="3 · Must-haves">
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">Website</div>
              <div className="flex flex-wrap gap-1.5">
                {([["any", "Doesn't matter"], ["has", "Has a working website"], ["missing", "No website (or site down)"]] as const).map(([v, l]) => <button key={v} type="button" className={chip(website === v)} onClick={() => setWebsite(v)}>{l}</button>)}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">Contact</div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={chip(requirePhone)} onClick={() => setRequirePhone(!requirePhone)}>Valid phone required</button>
                <button type="button" className={chip(requireEmail)} onClick={() => setRequireEmail(!requireEmail)}>Valid email required</button>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">Business size</div>
              <div className="flex flex-wrap gap-1.5">
                {([["any", "Any"], ["single", "Single location"], ["multi", "Multi-location"]] as const).map(([v, l]) => <button key={v} type="button" className={chip(size === v)} onClick={() => setSize(v)}>{l}</button>)}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">Public sources rarely publish employee counts, so size is judged by how many locations share the same website — never guessed.</p>
            </div>
            <p className="text-xs text-slate-500">Businesses that miss a must-have are still saved, but marked “Not a fit” with the reason.</p>
          </div>
        </Card>

        <Card title="4 · What do you sell? (for AI qualification)">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {meta.opportunities.map((o) => <button key={o.key} type="button" className={chip(opps.includes(o.key))} onClick={() => setOpps(opps.includes(o.key) ? opps.filter((x) => x !== o.key) : [...opps, o.key])}>{o.label}</button>)}
            </div>
            <p className="text-[11px] text-slate-400">{opps.length ? "Leads are scored for these services only." : "None selected: the AI considers every service type."}</p>
            <Field label="Your ideal customer" hint="Plain words. The AI scores fit against this, using only facts it collected about each business.">
              <textarea className={`${inputCls} h-20`} value={ideal} onChange={(e) => setIdeal(e.target.value)} placeholder="e.g. Owner-run roofing companies that take lots of quote requests by phone and have an outdated website" />
            </Field>
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        <div className="lg:sticky lg:top-20 space-y-5">
          <Card title="Your search">
            <p className="text-sm text-slate-700 leading-relaxed">{sentence}</p>
            <div className="mt-4 space-y-3">
              <div>
                <div className="text-xs font-medium text-slate-600 mb-1">Data sources</div>
                <div className="space-y-1.5">
                  {meta.sources.map((s) => (
                    <label key={s.key} className={`flex items-center gap-2 text-sm ${s.available ? "" : "opacity-60"}`}>
                      <input type="checkbox" disabled={!s.available} checked={sources.includes(s.key)} onChange={(e) => setSources(e.target.checked ? [...sources, s.key] : sources.filter((x) => x !== s.key))} />
                      {s.label}
                      {!s.available && <Link to="/settings" className="text-[11px] text-amber-700 hover:underline">add key</Link>}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Max businesses"><input type="number" min={10} max={5000} className={inputCls} value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value))} /></Field>
                <Field label="Qualify at score"><input type="number" min={30} max={95} className={inputCls} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></Field>
              </div>
              <Field label="Name (optional)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Auto-named from your search" /></Field>
              {err && <Banner kind="error">{err}</Banner>}
              <Btn kind="primary" className="w-full py-2" onClick={submit} disabled={busy}><Icon d={I.search} size={16} /> {busy ? "Starting…" : "Start discovery"}</Btn>
            </div>
          </Card>
          <Card title="What happens next">
            <ol className="text-xs text-slate-600 space-y-1.5 list-decimal ml-4">
              <li>Each source is searched per location, in the background, with retries.</li>
              <li>Businesses are normalized and merged — no duplicates.</li>
              <li>Websites are checked; emails, phones and social links are taken only from what's really there.</li>
              <li>Emails and phones are validated.</li>
              <li>AI scores fit and opportunity, citing the facts it used.</li>
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
