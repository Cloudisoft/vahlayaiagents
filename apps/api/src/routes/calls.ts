import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { getStorageDriver } from "../services/storageService.js";
import { getTelephonyProvider } from "../telephony/index.js";

export const callsRouter = Router();
callsRouter.use(requireAuth);
callsRouter.use(requireModuleAccess("voice_agents"));

callsRouter.get("/", async (req: AuthedRequest, res) => {
  const { campaignId, agentId, status, dispositionKey, dateFrom, dateTo } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));

  const conditions = ["c.organization_id = $1"];
  const params: unknown[] = [req.auth!.organizationId];
  if (campaignId) {
    params.push(campaignId);
    conditions.push(`c.campaign_id = $${params.length}`);
  }
  if (agentId) {
    params.push(agentId);
    conditions.push(`c.agent_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (dispositionKey) {
    params.push(dispositionKey);
    conditions.push(`cd.key = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`c.created_at >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`c.created_at <= $${params.length}`);
  }

  params.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(
    `select c.id, c.status, c.direction, c.to_number, c.from_number, c.started_at, c.ended_at, c.duration_seconds,
            c.cost_usd, c.created_at, l.business_name as lead_name, a.name as agent_name, cmp.name as campaign_name,
            cd.label as disposition_label
     from calls c
     left join leads l on l.id = c.lead_id
     left join ai_agents a on a.id = c.agent_id
     left join campaigns cmp on cmp.id = c.campaign_id
     left join call_dispositions cd on cd.id = c.disposition_id
     where ${conditions.join(" and ")}
     order by c.created_at desc limit $${params.length - 1} offset $${params.length}`,
    params
  );
  res.json({ calls: result.rows, page, pageSize });
});

callsRouter.get("/active", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select c.id, c.status, c.to_number, c.started_at, l.business_name as lead_name, a.name as agent_name
     from calls c
     left join leads l on l.id = c.lead_id
     left join ai_agents a on a.id = c.agent_id
     where c.organization_id = $1 and c.status in ('queued','ringing','answered')
     order by c.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ calls: result.rows });
});

callsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const call = await pool.query(
    `select c.*, l.business_name as lead_name, a.name as agent_name, cmp.name as campaign_name, cd.label as disposition_label
     from calls c
     left join leads l on l.id = c.lead_id
     left join ai_agents a on a.id = c.agent_id
     left join campaigns cmp on cmp.id = c.campaign_id
     left join call_dispositions cd on cd.id = c.disposition_id
     where c.id = $1 and c.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  if (call.rows.length === 0) return res.status(404).json({ error: "Call not found." });

  const [transcript, recording, transfers] = await Promise.all([
    pool.query("select * from call_transcripts where call_id = $1", [req.params.id]),
    pool.query("select * from call_recordings where call_id = $1", [req.params.id]),
    pool.query("select * from call_transfers where call_id = $1", [req.params.id]),
  ]);

  let recordingUrl: string | null = null;
  if (recording.rows[0]?.file_id) {
    const file = await pool.query("select file_path from files where id = $1", [recording.rows[0].file_id]);
    if (file.rows[0]) recordingUrl = await getStorageDriver().getSignedUrl(file.rows[0].file_path);
  }

  res.json({
    call: call.rows[0],
    transcript: transcript.rows[0] ?? null,
    recording: recording.rows[0] ?? null,
    recordingUrl,
    transfers: transfers.rows,
  });
});

callsRouter.post("/:id/transfer", async (req: AuthedRequest, res) => {
  const call = await pool.query("select * from calls where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (call.rows.length === 0) return res.status(404).json({ error: "Call not found." });
  const transferTo = req.body.transferTo as string | undefined;
  if (!transferTo) return res.status(400).json({ error: "transferTo is required." });

  try {
    const provider = await getTelephonyProvider(req.auth!.organizationId, call.rows[0].telephony_provider);
    await provider.transferCall(call.rows[0].provider_call_id, transferTo);
    await pool.query("insert into call_transfers (call_id, transfer_to, status) values ($1,$2,'completed')", [
      req.params.id,
      transferTo,
    ]);
    res.json({ message: "Call transfer initiated." });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

callsRouter.post("/:id/end", async (req: AuthedRequest, res) => {
  const call = await pool.query("select * from calls where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (call.rows.length === 0) return res.status(404).json({ error: "Call not found." });
  try {
    const provider = await getTelephonyProvider(req.auth!.organizationId, call.rows[0].telephony_provider);
    await provider.endCall(call.rows[0].provider_call_id);
    res.json({ message: "Call end requested." });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

callsRouter.patch("/:id/disposition", async (req: AuthedRequest, res) => {
  const dispositionId = req.body.dispositionId as string | undefined;
  if (!dispositionId) return res.status(400).json({ error: "dispositionId is required." });
  const result = await pool.query(
    "update calls set disposition_id = $1 where id = $2 and organization_id = $3 returning id",
    [dispositionId, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Call not found." });
  res.status(204).end();
});
