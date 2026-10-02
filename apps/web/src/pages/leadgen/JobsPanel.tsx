import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { useApi } from "../../lib/useApi.js";
import { Banner, Btn, Card, Empty, I, Icon, Skeleton, ago } from "../../components/ui.js";
import { JOB_LABEL, JOB_TONE, Pill, Progress, SOURCE_LABEL, locLabel, type Job } from "./shared.js";

const ACTIVE = ["queued", "running", "enriching"];

export default function JobsPanel({ selected, onSelect, onViewLeads }: { selected: string | null; onSelect: (id: string | null) => void; onViewLeads: (jobId: string) => void }) {
  const { data, reload } = useApi<{ jobs: Job[] }>("/leadgen/jobs");
  const jobs = data?.jobs ?? [];
  const active = jobs.some((j) => ACTIVE.includes(j.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => reload(), 3000);
    return () => clearInterval(t);
  }, [active, reload]);
  const current = selected ?? jobs[0]?.id ?? null;

  if (!data) return <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  if (!jobs.length) return <Card><Empty icon={I.search} title="No discovery runs yet">Start one from the Discover tab.</Empty></Card>;

  return (
    <div className="grid lg:grid-cols-5 gap-5">
      <div className="lg:col-span-2 space-y-2 max-h-[75vh] overflow-y-auto pr-1">
        {jobs.map((j) => {
          const c = j.counts ?? {};
          const t = c.tasks;
          const pct = t?.total ? ((t.total - t.open) / t.total) * 100 : 0;
          return (
            <button key={j.id} type="button" onClick={() => onSelect(j.id)} className={`w-full text-left rounded-2xl border p-3.5 transition-colors ${current === j.id ? "border-red-300 bg-red-50/40" : "border-slate-200 bg-white hover:border-slate-300"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 truncate">{j.name}</div>
                  <div className="text-[11px] text-slate-400">{ago(j.created_at)} · {j.sources.map((s) => SOURCE_LABEL[s] ?? s).join(" + ")}</div>
                </div>
                <Pill tone={JOB_TONE[j.status]}>{ACTIVE.includes(j.status) && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}{JOB_LABEL[j.status]}</Pill>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2.5 text-center">
                {[["Found", c.leads ?? 0], ["New", c.new ?? 0], ["Qualified", c.qualified ?? 0]].map(([l, v]) => (
                  <div key={l as string} className="rounded-lg bg-slate-50 py-1"><div className="text-sm font-semibold tabular-nums">{v as number}</div><div className="text-[10px] uppercase text-slate-400">{l as string}</div></div>
                ))}
              </div>
              {ACTIVE.includes(j.status) && <Progress className="mt-2.5" value={j.status === "enriching" ? 100 * ((c.scored ?? 0) / Math.max(1, c.leads ?? 1)) : pct} tone={j.status === "enriching" ? "bg-violet-500" : "bg-sky-500"} />}
            </button>
          );
        })}
      </div>
      <div className="lg:col-span-3">{current && <JobDetail id={current} onViewLeads={onViewLeads} onChanged={reload} />}</div>
    </div>
  );
}

interface Task { id: string; source: string; query: any; page: number; status: string; attempts: number; found: number; error: string | null; next_attempt_at: string; finished_at: string | null }
const TASK_TONE: Record<string, string> = { queued: "bg-slate-100 text-slate-600", running: "bg-sky-50 text-sky-700", done: "bg-green-50 text-green-700", failed: "bg-red-50 text-red-700", skipped: "bg-slate-100 text-slate-400" };

function JobDetail({ id, onViewLeads, onChanged }: { id: string; onViewLeads: (id: string) => void; onChanged: () => void }) {
  const { data, reload } = useApi<{ job: Job; tasks: Task[]; attribution: string[] }>(`/leadgen/jobs/${id}`);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const job = data?.job;
  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    const t = setInterval(() => reload(), 3000);
    return () => clearInterval(t);
  }, [job?.status, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !job) return <Skeleton className="h-80" />;
  const c = job.counts ?? {};
  const t = c.tasks ?? { open: 0, done: 0, failed: 0, skipped: 0, total: data.tasks.length };
  const leads = c.leads ?? 0;
  const stages: Array<[string, number, number, string]> = [
    ["Requests to sources", t.total - t.open, t.total, "bg-sky-500"],
    ["Enriched & validated", c.enriched ?? 0, leads, "bg-violet-500"],
    ["AI-qualified", c.scored ?? 0, leads, "bg-red-500"],
  ];
  const canRetry = t.failed > 0 || (c.failedLeads ?? 0) > 0;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      await reload();
      onChanged();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Failed." });
    }
  };
  const cr = job.criteria ?? {};

  return (
    <div className="space-y-4 animate-fade-in">
      <Card
        title={job.name}
        action={
          <div className="flex gap-2">
            {canRetry && <Btn onClick={() => act(() => api(`/leadgen/jobs/${id}/retry`, { method: "POST" }), "Failed requests and leads queued again; results so far are kept.")}><Icon d={I.retry} size={14} /> Retry failed</Btn>}
            {ACTIVE.includes(job.status) && <Btn kind="danger" onClick={() => confirm("Stop this discovery? Businesses found so far are kept.") && act(() => api(`/leadgen/jobs/${id}/cancel`, { method: "POST" }), "Stopped.")}>Stop</Btn>}
            <Btn kind="primary" onClick={() => onViewLeads(id)} disabled={!leads}>View {leads} leads</Btn>
          </div>
        }
      >
        {msg && <div className="mb-3"><Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner></div>}
        {job.error && <div className="mb-3"><Banner kind="error">{job.error}</Banner></div>}
        <div className="flex flex-wrap gap-2 text-xs text-slate-600 mb-4">
          <Pill tone={JOB_TONE[job.status]}>{JOB_LABEL[job.status]}</Pill>
          {(cr.locations ?? []).map((l: any, i: number) => <Pill key={i} tone="bg-slate-100 text-slate-600">{locLabel(l)}</Pill>)}
          {cr.website && cr.website !== "any" && <Pill tone="bg-slate-100 text-slate-600">{cr.website === "has" ? "Has website" : "No website"}</Pill>}
          {cr.requirePhone && <Pill tone="bg-slate-100 text-slate-600">Phone required</Pill>}
          {cr.requireEmail && <Pill tone="bg-slate-100 text-slate-600">Email required</Pill>}
          <Pill tone="bg-slate-100 text-slate-600">Up to {job.max_results}</Pill>
        </div>
        <div className="space-y-3">
          {stages.map(([l, n, d, tone]) => (
            <div key={l}>
              <div className="flex justify-between text-xs mb-1"><span className="text-slate-600">{l}</span><span className="tabular-nums text-slate-500">{n} / {d}</span></div>
              <Progress value={d ? (n / d) * 100 : 0} tone={tone} />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-center">
          {[["Businesses", leads], ["New", c.new ?? 0], ["Already known", c.merged ?? 0], ["Qualified", c.qualified ?? 0]].map(([l, v]) => (
            <div key={l as string} className="rounded-xl bg-slate-50 py-2"><div className="text-lg font-semibold tabular-nums">{v as number}</div><div className="text-[10px] uppercase tracking-wide text-slate-400">{l as string}</div></div>
          ))}
        </div>
        {(c.failedLeads ?? 0) > 0 && <p className="text-xs text-red-600 mt-3">{c.failedLeads} business{c.failedLeads === 1 ? "" : "es"} couldn't be enriched or scored — see the Leads tab (status “Failed”), or retry.</p>}
      </Card>

      <Card title="Requests" action={<span className="text-xs text-slate-400">{t.done} done · {t.failed} failed · {t.open} pending</span>}>
        <p className="text-xs text-slate-500 mb-2">Each request runs and retries on its own, so one failure never loses the rest of the results.</p>
        <ul className="divide-y divide-slate-100">
          {data.tasks.map((x) => (
            <li key={x.id} className="py-2 flex items-start gap-3 text-sm">
              <Pill tone={TASK_TONE[x.status]}>{x.status}</Pill>
              <div className="min-w-0 flex-1">
                <div className="text-slate-700">{SOURCE_LABEL[x.source] ?? x.source} · {locLabel(x.query.location ?? {})}{x.page > 1 ? ` · page ${x.page}` : ""}</div>
                {x.error && <div className={`text-xs ${x.status === "failed" ? "text-red-600" : "text-slate-500"}`}>{x.error}</div>}
              </div>
              <span className="text-xs text-slate-500 tabular-nums shrink-0">{x.found} found{x.attempts > 1 ? ` · ${x.attempts} tries` : ""}</span>
            </li>
          ))}
        </ul>
        {data.attribution.length > 0 && <p className="text-[11px] text-slate-400 mt-3">Data: {data.attribution.join(" · ")}</p>}
      </Card>
    </div>
  );
}
