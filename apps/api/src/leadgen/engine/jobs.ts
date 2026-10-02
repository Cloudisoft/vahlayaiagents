import { pool } from "../../db/pool.js";
import { notify } from "../../services/notifyService.js";
import { ProviderNotConfiguredError } from "../../services/openaiService.js";
import { enrichLead } from "./enrich.js";
import { qualifyLead, type Criteria } from "./qualify.js";
import { storeRecord } from "./store.js";
import { sourceByKey } from "./sources/registry.js";
import { PermanentSourceError, RateLimitedError, SourceUnavailableError, type SourceQuery } from "./sources/types.js";
import { industryByKey } from "./taxonomy.js";

const MAX_TASK_ATTEMPTS = 5;
const MAX_PAGES = 3;
const MAX_PIPELINE_ATTEMPTS = 3;
const STALE_MIN = 10;

export async function createDiscoveryJob(params: { organizationId: string; userId: string; name?: string; criteria: Criteria; sources: string[]; maxResults: number }) {
  const c = params.criteria;
  const ind = industryByKey(c.industry);
  if (!ind && !c.keywords.trim() && !c.services.trim()) throw new Error("Choose an industry or enter keywords.");
  if (!c.locations.length) throw new Error("Add at least one location.");
  const sources = Array.from(new Set(params.sources)).filter((s) => sourceByKey(s));
  if (!sources.length) throw new Error("Choose at least one data source.");
  const availability = await Promise.all(sources.map(async (s) => [s, await sourceByKey(s)!.available(params.organizationId)] as const));
  if (!availability.some(([, ok]) => ok)) throw new Error("None of the chosen data sources is connected. Add a Google Places key in Settings, or use OpenStreetMap.");
  const where = c.locations.map((l) => [l.zip, l.city, l.state].filter(Boolean).join(" ")).join(", ");
  const name = params.name?.trim() || `${ind?.label ?? (c.keywords || c.services)} · ${where}`.slice(0, 120);
  const list = await pool.query("insert into lead_lists (organization_id, name, created_by, description) values ($1,$2,$3,'Created by Lead Discovery') returning id", [params.organizationId, name, params.userId]);
  const job = await pool.query(
    "insert into discovery_jobs (organization_id, created_by, name, criteria, sources, max_results, lead_list_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [params.organizationId, params.userId, name, JSON.stringify(c), sources, params.maxResults, list.rows[0].id]
  );
  const jobId = job.rows[0].id as string;
  const keywords = [c.keywords, c.services].filter((s) => s.trim()).join(", ");
  for (const [source, ok] of availability) {
    for (const location of c.locations) {
      const q: SourceQuery = { industry: c.industry, keywords, location };
      await pool.query(
        "insert into discovery_tasks (job_id, source, query, status, error) values ($1,$2,$3,$4,$5)",
        [jobId, source, JSON.stringify(q), ok ? "queued" : "skipped", ok ? null : `${sourceByKey(source)!.label} isn't connected`]
      );
    }
  }
  return jobId;
}

export async function claimTask() {
  const r = await pool.query(
    `update discovery_tasks set status = 'running', locked_at = now(), attempts = attempts + 1
     where id = (select t.id from discovery_tasks t join discovery_jobs j on j.id = t.job_id
                 where ((t.status = 'queued' and t.next_attempt_at <= now()) or (t.status = 'running' and t.locked_at < now() - make_interval(mins => ${STALE_MIN})))
                   and j.status not in ('cancelled')
                 order by t.next_attempt_at limit 1 for update of t skip locked)
     returning *`
  );
  return r.rows[0] ?? null;
}

async function jobLeadCount(jobId: string) {
  return Number((await pool.query("select count(*) from discovery_job_leads where job_id = $1", [jobId])).rows[0].count);
}

export async function runTask(task: any) {
  const job = (await pool.query("select * from discovery_jobs where id = $1", [task.job_id])).rows[0];
  if (!job || job.status === "cancelled") {
    await pool.query("update discovery_tasks set status = 'skipped', error = 'Job cancelled', finished_at = now() where id = $1", [task.id]);
    return;
  }
  await pool.query("update discovery_jobs set status = 'running', started_at = coalesce(started_at, now()) where id = $1 and status = 'queued'", [job.id]);
  const adapter = sourceByKey(task.source);
  try {
    if (!adapter) throw new PermanentSourceError(`Unknown source ${task.source}`);
    if ((await jobLeadCount(job.id)) >= job.max_results) {
      await pool.query("update discovery_tasks set status = 'done', error = 'Result limit reached before this request ran', finished_at = now() where id = $1", [task.id]);
      return;
    }
    const client = await adapter.prepare(job.organization_id);
    const page = await client.search(task.query as SourceQuery, task.page_token);
    let stored = 0;
    let recordErrors = 0;
    for (const rec of page.records) {
      if ((await jobLeadCount(job.id)) >= job.max_results) break;
      try {
        const r = await storeRecord({ organizationId: job.organization_id, jobId: job.id, source: task.source, record: rec, leadListId: job.lead_list_id, defaultCountry: task.query.location?.country ?? "US" });
        if (r) stored++;
      } catch (err) {
        recordErrors++;
        console.error("[discovery] store", (err as Error).message);
      }
    }
    await pool.query("update discovery_tasks set status = 'done', found = $2, error = $3, finished_at = now(), locked_at = null where id = $1", [
      task.id,
      page.records.length,
      recordErrors ? `${recordErrors} record(s) couldn't be saved` : null,
    ]);
    if (page.nextPageToken && task.page < MAX_PAGES && (await jobLeadCount(job.id)) < job.max_results) {
      // Google needs a moment before a next-page token becomes valid.
      await pool.query("insert into discovery_tasks (job_id, source, query, page, page_token, next_attempt_at) values ($1,$2,$3,$4,$5, now() + interval '3 seconds')", [
        job.id, task.source, JSON.stringify(task.query), task.page + 1, page.nextPageToken,
      ]);
    }
  } catch (err) {
    const e = err as Error;
    const permanent = e instanceof PermanentSourceError || e instanceof SourceUnavailableError;
    if (!permanent && task.attempts < MAX_TASK_ATTEMPTS) {
      const wait = e instanceof RateLimitedError ? e.retryAfterSec : Math.min(600, 15 * 2 ** (task.attempts - 1));
      await pool.query("update discovery_tasks set status = 'queued', error = $2, next_attempt_at = now() + make_interval(secs => $3), locked_at = null where id = $1", [
        task.id, `${e.message} — retrying in ${wait}s (attempt ${task.attempts} of ${MAX_TASK_ATTEMPTS})`, wait,
      ]);
    } else {
      await pool.query("update discovery_tasks set status = 'failed', error = $2, finished_at = now(), locked_at = null where id = $1", [task.id, e.message.slice(0, 500)]);
    }
  }
}

// ENRICH → VALIDATE → QUALIFY, one lead at a time per worker slot.
export async function claimLead() {
  const r = await pool.query(
    `update leads set pipeline_status = case when pipeline_status in ('discovered','enriching') then 'enriching' else 'qualifying' end,
       pipeline_locked_at = now(), pipeline_attempts = pipeline_attempts + 1
     where id = (select id from leads
                 where (pipeline_status in ('discovered','enriched') and coalesce(pipeline_next_at, now()) <= now())
                    or (pipeline_status in ('enriching','qualifying') and pipeline_locked_at < now() - make_interval(mins => ${STALE_MIN}))
                 order by pipeline_next_at nulls first limit 1 for update skip locked)
     returning id, pipeline_status, pipeline_attempts`
  );
  return r.rows[0] ?? null;
}

async function latestJobFor(leadId: string) {
  return (await pool.query("select job_id from discovery_job_leads where lead_id = $1 order by created_at desc limit 1", [leadId])).rows[0]?.job_id ?? null;
}

export async function runLeadStep(l: { id: string; pipeline_status: string; pipeline_attempts: number }) {
  const stage = l.pipeline_status === "enriching" ? "enrich" : "qualify";
  try {
    if (stage === "enrich") await enrichLead(l.id);
    else await qualifyLead(l.id, await latestJobFor(l.id));
  } catch (err) {
    const e = err as Error;
    const permanent = err instanceof ProviderNotConfiguredError;
    if (!permanent && l.pipeline_attempts < MAX_PIPELINE_ATTEMPTS) {
      await pool.query(
        "update leads set pipeline_status = $2, pipeline_error = $3, pipeline_locked_at = null, pipeline_next_at = now() + make_interval(secs => $4) where id = $1",
        [l.id, stage === "enrich" ? "discovered" : "enriched", `${e.message} — retrying`, 30 * l.pipeline_attempts]
      );
    } else {
      await pool.query("update leads set pipeline_status = $2, pipeline_error = $3, pipeline_locked_at = null where id = $1", [l.id, stage === "enrich" ? "enrich_failed" : "qualify_failed", e.message.slice(0, 500)]);
    }
  }
}

// Rolls task and lead progress up into each active job.
export async function refreshJobs() {
  const jobs = await pool.query("select id, organization_id, name, status from discovery_jobs where status in ('queued','running','enriching')");
  for (const j of jobs.rows) {
    const t = (
      await pool.query(
        `select count(*) filter (where status in ('queued','running'))::int as open, count(*) filter (where status = 'done')::int as done,
                count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'skipped')::int as skipped,
                count(*)::int as total, coalesce(sum(found),0)::int as found
         from discovery_tasks where job_id = $1`,
        [j.id]
      )
    ).rows[0];
    const l = (
      await pool.query(
        `select count(*)::int as leads, count(*) filter (where d.was_new)::int as new,
                count(*) filter (where l.pipeline_status in ('discovered','enriching','enriched','qualifying'))::int as pending,
                count(*) filter (where l.enriched_at is not null)::int as enriched,
                count(*) filter (where l.qualified_for_job = $1)::int as qualified_done,
                count(*) filter (where l.qualified_for_job = $1 and l.qualification_status = 'qualified')::int as qualified,
                count(*) filter (where l.pipeline_status in ('enrich_failed','qualify_failed'))::int as failed
         from discovery_job_leads d join leads l on l.id = d.lead_id where d.job_id = $1`,
        [j.id]
      )
    ).rows[0];
    const counts = { tasks: t, found: t.found, leads: l.leads, new: l.new, merged: l.leads - l.new, enriched: l.enriched, scored: l.qualified_done, qualified: l.qualified, pending: l.pending, failedLeads: l.failed };
    let status = j.status;
    let error: string | null = null;
    if (t.open > 0) status = "running";
    else if (l.pending > 0) status = "enriching";
    else if (t.done === 0 && t.failed + t.skipped === t.total) {
      status = "failed";
      error = (await pool.query("select string_agg(distinct error, '; ') as e from discovery_tasks where job_id = $1 and status in ('failed','skipped')", [j.id])).rows[0].e;
    } else status = t.failed > 0 || l.failed > 0 ? "partial" : "completed";
    const finished = ["completed", "partial", "failed"].includes(status);
    await pool.query("update discovery_jobs set status = $2, counts = $3, error = $4, finished_at = case when $5 then coalesce(finished_at, now()) else null end where id = $1", [
      j.id, status, JSON.stringify(counts), error, finished,
    ]);
    if (finished && j.status !== status) {
      await notify(j.organization_id, {
        type: "lead_discovery",
        title: status === "failed" ? "Lead discovery failed" : "Lead discovery finished",
        body: status === "failed" ? `${j.name}: ${error ?? "no results"}` : `${j.name}: ${l.leads} businesses (${l.new} new), ${l.qualified} qualified.`,
        link: `/leadgen?job=${j.id}`,
      }).catch(() => undefined);
    }
  }
}

export function startDiscoveryWorker() {
  let tasks = 0;
  let leads = 0;
  const pumpTasks = async () => {
    while (tasks < 2) {
      const t = await claimTask().catch(() => null);
      if (!t) return;
      tasks++;
      runTask(t)
        .catch((e) => console.error("[discovery] task", e))
        .finally(() => {
          tasks--;
          void pumpTasks();
        });
    }
  };
  const pumpLeads = async () => {
    while (leads < 4) {
      const l = await claimLead().catch(() => null);
      if (!l) return;
      leads++;
      runLeadStep(l)
        .catch((e) => console.error("[discovery] lead", e))
        .finally(() => {
          leads--;
          void pumpLeads();
        });
    }
  };
  setInterval(() => void pumpTasks(), 2000);
  setInterval(() => void pumpLeads(), 2000);
  setInterval(() => void refreshJobs().catch((e) => console.error("[discovery] refresh", e.message)), 4000);
}
