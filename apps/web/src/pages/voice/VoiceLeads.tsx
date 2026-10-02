import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api.js";
import { useApi } from "../../lib/useApi.js";
import { K } from "../../lib/voiceKeys.js";
import { DispositionBadge, btnGhost, formatPhone, formatSeconds, inputCls } from "../../lib/voice.js";

interface LeadRow {
  id: string;
  business_name: string | null;
  first_name: string | null;
  last_name: string | null;
  main_phone_e164: string | null;
  state: string | null;
  current_provider: string | null;
  customer_type: string | null;
  call_status: string | null;
  status_label: string | null;
  status_color: string | null;
  attempts: number;
  last_called_at: string | null;
  is_dnc: boolean;
}

const EMPTY = { search: "", callStatus: "", customerType: "", dnc: "" };

export default function VoiceLeads() {
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const listKey = (() => {
    const q = new URLSearchParams({ page: String(page) });
    for (const [k, v] of Object.entries(applied)) if (v) q.set(k, v);
    return K.leads(q.toString());
  })();
  const leadsQ = useApi<{ leads: LeadRow[]; total: number }>(listKey);
  const codes = useApi<{ dispositions: Array<{ key: string; label: string }> }>(K.dispositions).data?.dispositions ?? [];
  const rows = leadsQ.data?.leads ?? [];
  const total = leadsQ.data?.total ?? 0;

  return (
    <div className="max-w-6xl space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Leads</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied(filters);
        }}
        className="bg-white border border-slate-200 rounded-xl p-3 grid grid-cols-2 md:grid-cols-5 gap-2"
      >
        <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Name, business, phone, email" className={`${inputCls} col-span-2`} />
        <select value={filters.callStatus} onChange={(e) => setFilters({ ...filters, callStatus: e.target.value })} className={inputCls}>
          <option value="">Any status</option>
          {codes.map((c) => <option key={c.key} value={c.key}>{c.key} – {c.label}</option>)}
        </select>
        <select value={filters.customerType} onChange={(e) => setFilters({ ...filters, customerType: e.target.value })} className={inputCls}>
          <option value="">ALC + non-ALC</option>
          <option value="alc">ALC (Spectrum customer)</option>
          <option value="non_alc">Non-ALC</option>
        </select>
        <div className="flex gap-2">
          <select value={filters.dnc} onChange={(e) => setFilters({ ...filters, dnc: e.target.value })} className={inputCls}>
            <option value="">All</option>
            <option value="true">DNC only</option>
          </select>
          <button className="bg-slate-900 text-white text-sm rounded-md px-4">Go</button>
        </div>
      </form>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Lead</th>
              <th className="text-left px-4 py-2">Phone</th>
              <th className="text-left px-4 py-2">Provider</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">Attempts</th>
              <th className="text-left px-4 py-2">Last called</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} onClick={() => setOpenId(l.id)} className={`border-t border-slate-100 cursor-pointer ${openId === l.id ? "bg-red-50" : "hover:bg-slate-50"}`}>
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-900">{[l.first_name, l.last_name].filter(Boolean).join(" ") || l.business_name}</div>
                  {(l.first_name || l.last_name) && <div className="text-xs text-slate-500">{l.business_name}</div>}
                </td>
                <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{formatPhone(l.main_phone_e164)}{l.is_dnc && <span className="ml-1 text-xs text-red-600">DNC</span>}</td>
                <td className="px-4 py-2 text-slate-600">
                  {l.current_provider ?? "—"}
                  {l.customer_type && <span className="ml-1 text-xs text-slate-400">{l.customer_type === "alc" ? "ALC" : "non-ALC"}</span>}
                </td>
                <td className="px-4 py-2"><DispositionBadge code={l.call_status} label={l.status_label ?? l.call_status} color={l.status_color} /></td>
                <td className="px-4 py-2 text-right tabular-nums">{l.attempts}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{l.last_called_at ? new Date(l.last_called_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No leads match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{total.toLocaleString()} lead(s)</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={btnGhost}>Previous</button>
          <button disabled={page * 50 >= total} onClick={() => setPage(page + 1)} className={btnGhost}>Next</button>
        </div>
      </div>
      {openId && <LeadDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    setData(null);
    api(`/voice/insights/leads/${id}`).then(setData);
  }, [id]);
  const l = data?.lead;
  const details: Record<string, unknown> = l?.custom_fields?.call_details ?? {};
  const custom = Object.entries(l?.custom_fields ?? {}).filter(([, v]) => v === null || typeof v !== "object");
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-white shadow-xl overflow-auto animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3 flex items-center justify-between">
          <div className="font-semibold text-slate-900">Lead</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        {!l ? (
          <div className="p-5"><div className="space-y-3 animate-fade-in" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-24 w-full" />
        </div></div>
        ) : (
          <div className="p-5 space-y-5 text-sm">
            <div>
              <div className="text-lg font-semibold text-slate-900">{[l.first_name, l.last_name].filter(Boolean).join(" ") || l.business_name}</div>
              <div className="text-slate-500">{l.business_name} · {formatPhone(l.main_phone_e164)}{l.business_email ? ` · ${l.business_email}` : ""}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                ["Title", l.contact_title],
                ["Provider", l.current_provider],
                ["Customer type", l.customer_type === "alc" ? "ALC" : l.customer_type === "non_alc" ? "Non-ALC" : null],
                ["Lines / locations", [l.lines_count, l.locations_count].some(Boolean) ? `${l.lines_count ?? "—"} / ${l.locations_count ?? "—"}` : null],
                ["Contract ends", l.contract_end_date ? String(l.contract_end_date).slice(0, 10) : null],
                ["Address", l.service_address ?? l.address ?? ([l.city, l.state].filter(Boolean).join(", ") || null)],
                ...custom.map(([k, v]) => [k.replace(/_/g, " "), v == null ? null : String(v)]),
              ].map(([k, v]) => (
                <div key={k as string}>
                  <div className="text-xs text-slate-500 capitalize">{k as string}</div>
                  <div className="text-slate-900">{(v as string) ?? "—"}</div>
                </div>
              ))}
            </div>
            {Object.keys(details).length > 0 && (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Captured by the agent</div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(details).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-xs text-slate-500 capitalize">{k.replace(/_/g, " ")}</div>
                      <div className="text-slate-900">{Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">Campaigns</div>
              {data.campaigns.map((c: any) => (
                <div key={c.id} className="flex justify-between">
                  <Link to={`/voice/campaigns/${c.campaign_id}`} className="text-slate-900 hover:underline">{c.name}</Link>
                  <span className="text-xs text-slate-500">{c.status} · {c.attempts} attempt(s){c.next_attempt_at ? ` · next ${new Date(c.next_attempt_at).toLocaleString()}` : ""}</span>
                </div>
              ))}
              {data.campaigns.length === 0 && <div className="text-slate-400">Not in a campaign.</div>}
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">Call history</div>
              <div className="space-y-2">
                {data.calls.map((c: any) => (
                  <div key={c.id} className="border border-slate-100 rounded-md p-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleString()} · {formatSeconds(c.talk_seconds)} · {c.campaign_name ?? "—"}</span>
                      <DispositionBadge code={c.disposition_key} label={c.disposition_label ?? c.status} color={c.disposition_color} />
                    </div>
                    {c.summary && <div className="text-slate-700 mt-1">{c.summary}</div>}
                  </div>
                ))}
                {data.calls.length === 0 && <div className="text-slate-400">No calls yet.</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
