import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireTab } from "../services/accessService.js";
import {
  cloneCartesiaVoice,
  deleteCartesiaVoice,
  importCartesiaVoices,
  previewCartesiaVoice,
  resolveCartesiaKey,
  syncCartesiaVoices,
} from "../services/cartesiaService.js";

export const voicesRouter = Router();
voicesRouter.use(requireAuth);
voicesRouter.use(requireModuleAccess("voice_agents"));
voicesRouter.use(requireTab("voice_agents", "voices", { readVia: ["agents", "campaigns"] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".mp3", ".wav", ".m4a", ".ogg", ".webm", ".flac"].includes(ext)) return cb(new Error("Upload an MP3, WAV, M4A, OGG, WEBM or FLAC recording."));
    cb(null, true);
  },
});

// Shared catalog voices plus this organisation's own clones. Hidden voices
// are left out unless asked for (pickers never show them).
voicesRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select id, provider, provider_voice_id, name, language, gender, description, is_cloned, hidden,
            (organization_id is not null) as owned,
            -- Pickers show the plain name; repeated names get a short qualifier.
            case when count(*) over (partition by lower(name)) > 1
                 then name || ' · ' || case gender when 'masculine' then 'Male' when 'feminine' then 'Female' when 'gender_neutral' then 'Neutral' else 'Voice' end
                   || ' ' || right(provider_voice_id, 4)
                 else name end as label
     from voices
     where (organization_id is null or organization_id = $1) and ($2::boolean or not hidden)
     order by is_cloned desc, provider, name`,
    [req.auth!.organizationId, req.query.all === "1"]
  );
  res.json({ voices: result.rows });
});

voicesRouter.get("/provider-status", async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId;
  const counts = await pool.query(
    `select count(*) filter (where organization_id = $1 and is_cloned) as cloned,
            count(*) filter (where organization_id is null or organization_id = $1) as total
     from voices where provider = 'cartesia'`,
    [org]
  );
  let connected = false;
  try {
    await resolveCartesiaKey(org);
    connected = true;
  } catch {
    connected = false;
  }
  res.json({
    cartesia: {
      connected,
      clonedVoices: Number(counts.rows[0].cloned),
      voices: Number(counts.rows[0].total),
      // Cartesia doesn't publish account credits through its API.
      balance: null,
      billingUrl: "https://play.cartesia.ai/subscription",
    },
  });
});

voicesRouter.post("/sync", async (req: AuthedRequest, res) => {
  try {
    const count = await syncCartesiaVoices(req.auth!.organizationId);
    res.json({ message: `Synced ${count} voices from Cartesia.` });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Import voices by ID. Accepts one per line as "id" or "id - display name".
voicesRouter.post("/import", async (req: AuthedRequest, res) => {
  const lines = String(req.body?.ids ?? "")
    .split(/[\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const ids = lines.map((l) => l.split(/\s+[-–]\s+/)[0].trim()).filter((id) => /^[0-9a-z_-]{8,}$/i.test(id));
  if (ids.length === 0) return res.status(400).json({ error: "Paste at least one Cartesia voice ID." });
  try {
    const { imported, failed } = await importCartesiaVoices(req.auth!.organizationId, ids.slice(0, 100));
    res.json({
      message: `Imported ${imported.length} voice(s).${failed.length ? ` ${failed.length} not found: ${failed.map((f) => f.id).join(", ")}` : ""}`,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

voicesRouter.post("/clone", upload.single("audio"), async (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Give the voice a name." });
  if (!req.file) return res.status(400).json({ error: "Upload a clear recording of 10–60 seconds of one person speaking." });
  try {
    const voice = await cloneCartesiaVoice(req.auth!.organizationId, {
      audio: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      name,
      language: String(req.body?.language || "en"),
      description: req.body?.description ? String(req.body.description) : undefined,
    });
    res.status(201).json({ voice, message: `Cloned "${voice.name}". It's ready to use on agents.` });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

voicesRouter.get("/:id/preview", async (req: AuthedRequest, res) => {
  const v = await pool.query(
    "select provider, provider_voice_id, name from voices where id = $1 and (organization_id is null or organization_id = $2)",
    [req.params.id, req.auth!.organizationId]
  );
  const voice = v.rows[0];
  if (!voice) return res.status(404).json({ error: "Voice not found." });
  if (voice.provider !== "cartesia") return res.status(400).json({ error: "Previews are available for Cartesia voices." });
  const spoken = String(voice.name).split(/\s[-–—|(]\s?|\(/)[0].trim();
  try {
    const audio = await previewCartesiaVoice(
      req.auth!.organizationId,
      voice.provider_voice_id,
      `Hi, this is ${spoken}. Thanks for taking my call — do you have a quick minute?`
    );
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(audio);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Add a specific Cartesia voice by its ID without syncing the whole library.
voicesRouter.post("/", async (req: AuthedRequest, res) => {
  const providerVoiceId = typeof req.body?.providerVoiceId === "string" ? req.body.providerVoiceId.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!/^[0-9a-f-]{20,}$/i.test(providerVoiceId)) return res.status(400).json({ error: "Enter a Cartesia voice ID." });
  if (!name) return res.status(400).json({ error: "Enter a display name." });
  const result = await pool.query(
    `insert into voices (provider, provider_voice_id, name) values ('cartesia',$1,$2)
     on conflict (provider, provider_voice_id) do update set name = excluded.name returning *`,
    [providerVoiceId, name]
  );
  res.status(201).json({ voice: result.rows[0] });
});

// Bulk: hide/unhide from pickers, or delete (own clones are deleted in
// Cartesia too; shared catalog voices are only hidden).
voicesRouter.post("/bulk", async (req: AuthedRequest, res) => {
  const parsed = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), action: z.enum(["hide", "unhide", "delete"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const org = req.auth!.organizationId;
  const { ids, action } = parsed.data;
  const rows = await pool.query(
    "select id, provider, provider_voice_id, organization_id from voices where id = any($1::uuid[]) and (organization_id is null or organization_id = $2)",
    [ids, org]
  );
  const inUse = await pool.query("select distinct voice_id from ai_agents where organization_id = $1 and voice_id = any($2::uuid[])", [org, ids]);
  const used = new Set(inUse.rows.map((r) => r.voice_id));
  if (action !== "delete") {
    await pool.query("update voices set hidden = $2 where id = any($1::uuid[])", [rows.rows.map((r) => r.id), action === "hide"]);
    return res.json({ message: `${action === "hide" ? "Hid" : "Restored"} ${rows.rows.length} voice(s).` });
  }
  let deleted = 0;
  let hidden = 0;
  const errors: string[] = [];
  for (const v of rows.rows) {
    if (used.has(v.id)) {
      errors.push("in use by an agent");
      continue;
    }
    if (v.organization_id) {
      try {
        if (v.provider === "cartesia") await deleteCartesiaVoice(org, v.provider_voice_id);
        await pool.query("delete from voices where id = $1", [v.id]);
        deleted++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    } else {
      await pool.query("update voices set hidden = true where id = $1", [v.id]);
      hidden++;
    }
  }
  res.json({
    message:
      [deleted ? `Deleted ${deleted} cloned voice(s).` : "", hidden ? `Hid ${hidden} library voice(s).` : "", errors.length ? `${errors.length} skipped (${[...new Set(errors)].join("; ")}).` : ""]
        .filter(Boolean)
        .join(" ") || "Nothing changed.",
  });
});
