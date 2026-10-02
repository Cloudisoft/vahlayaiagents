import { useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { btnDark, btnGhost, btnPrimary, inputCls } from "../../lib/voice.js";

interface Voice {
  id: string;
  provider: string;
  provider_voice_id: string;
  name: string;
  language: string | null;
  gender: string | null;
  description: string | null;
  is_cloned: boolean;
  hidden: boolean;
  owned: boolean;
}
interface Status {
  cartesia: { connected: boolean; clonedVoices: number; voices: number; balance: number | null; billingUrl: string };
}

// Uploads go as multipart, so they can't use the JSON api() helper.
async function upload(path: string, form: FormData): Promise<any> {
  const send = () =>
    fetch(`/api${path}`, {
      method: "POST",
      credentials: "include",
      headers: getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {},
      body: form,
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Upload failed.", res.status);
  return data;
}

export default function VoicesPanel() {
  const [showHidden, setShowHidden] = useState(false);
  const voicesQ = useApi<{ voices: Voice[] }>(`/voice/voices${showHidden ? "?all=1" : ""}`);
  const statusQ = useApi<Status>("/voice/voices/provider-status");
  const voices = voicesQ.data?.voices ?? [];
  const status = statusQ.data?.cartesia;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [gender, setGender] = useState("");
  const [panel, setPanel] = useState<"" | "clone" | "import">("");
  const [importIds, setImportIds] = useState("");
  const [clone, setClone] = useState({ name: "", language: "en", description: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function reload() {
    invalidate("/voice/voices");
    await Promise.all([voicesQ.reload(), statusQ.reload()]);
  }

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  async function preview(v: Voice) {
    audioRef.current?.pause();
    if (playing === v.id) {
      setPlaying(null);
      return;
    }
    setPlaying(v.id);
    setError(null);
    try {
      let res = await fetch(`/api/voice/voices/${v.id}/preview`, { headers: { Authorization: `Bearer ${getAccessToken()}` }, credentials: "include" });
      if (res.status === 401 && (await refreshSession())) {
        res = await fetch(`/api/voice/voices/${v.id}/preview`, { headers: { Authorization: `Bearer ${getAccessToken()}` }, credentials: "include" });
      }
      if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? "Preview failed.", res.status);
      const audio = new Audio(URL.createObjectURL(await res.blob()));
      audioRef.current = audio;
      audio.onended = () => setPlaying(null);
      await audio.play();
    } catch (err) {
      setPlaying(null);
      setError(err instanceof ApiError ? err.message : "Couldn't play the preview.");
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return voices.filter(
      (v) =>
        (!q || v.name.toLowerCase().includes(q) || v.provider_voice_id.includes(q) || (v.description ?? "").toLowerCase().includes(q)) &&
        (!type || (type === "cloned" ? v.is_cloned : !v.is_cloned)) &&
        (!gender || (v.gender ?? "unknown").startsWith(gender))
    );
  }, [voices, search, type, gender]);
  const shown = filtered.slice(0, 300);

  function onClone(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose a recording to clone from.");
    const form = new FormData();
    form.append("audio", file);
    form.append("name", clone.name);
    form.append("language", clone.language);
    if (clone.description) form.append("description", clone.description);
    run("clone", async () => {
      const r = await upload("/voice/voices/clone", form);
      setClone({ name: "", language: "en", description: "" });
      if (fileRef.current) fileRef.current.value = "";
      setPanel("");
      return r.message;
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-3 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase">Cartesia</div>
          <div className={`text-sm font-medium mt-1 ${status?.connected ? "text-green-700" : "text-amber-700"}`}>
            {status ? (status.connected ? "Connected" : "Not connected — add the API key in Settings") : "…"}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase">Voices</div>
          <div className="text-2xl font-semibold text-slate-900">{status?.voices ?? "—"}</div>
          <div className="text-xs text-slate-500">{status?.clonedVoices ?? 0} cloned</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase">Cartesia balance</div>
          <div className="text-sm text-slate-600 mt-1">
            Cartesia doesn't share account credits through its API.{" "}
            <a href={status?.billingUrl ?? "https://play.cartesia.ai/subscription"} target="_blank" rel="noreferrer" className="text-red-600 hover:underline">
              Open Cartesia billing ↗
            </a>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setPanel(panel === "clone" ? "" : "clone")} className={btnPrimary}>+ Clone a voice</button>
        <button onClick={() => setPanel(panel === "import" ? "" : "import")} className={btnGhost}>Import by ID</button>
        <button onClick={() => run("sync", async () => (await api<{ message: string }>("/voice/voices/sync", { method: "POST" })).message)} disabled={busy !== null} className={btnDark}>
          {busy === "sync" ? "Syncing…" : "Sync library from Cartesia"}
        </button>
      </div>

      {panel === "clone" && (
        <form onSubmit={onClone} className="bg-white border border-slate-200 rounded-xl p-4 grid md:grid-cols-2 gap-3 animate-fade-in">
          <div className="md:col-span-2 text-sm text-slate-600">
            Upload 10–60 seconds of one person speaking clearly, with no music or background noise. Only clone a voice you have permission to use.
          </div>
          <input required placeholder="Voice name, e.g. Hari - Sales" value={clone.name} onChange={(e) => setClone({ ...clone, name: e.target.value })} className={inputCls} />
          <select value={clone.language} onChange={(e) => setClone({ ...clone, language: e.target.value })} className={inputCls}>
            {[["en", "English"], ["es", "Spanish"], ["hi", "Hindi"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"]].map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
          <input placeholder="Description (optional)" value={clone.description} onChange={(e) => setClone({ ...clone, description: e.target.value })} className={inputCls} />
          <input ref={fileRef} type="file" accept=".mp3,.wav,.m4a,.ogg,.webm,.flac,audio/*" required className="text-sm" />
          <div className="md:col-span-2 flex justify-end gap-2">
            <button type="button" onClick={() => setPanel("")} className={btnGhost}>Cancel</button>
            <button disabled={busy !== null} className={btnPrimary}>{busy === "clone" ? "Cloning…" : "Clone voice"}</button>
          </div>
        </form>
      )}

      {panel === "import" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run("import", async () => {
              const r = await api<{ message: string }>("/voice/voices/import", { method: "POST", body: { ids: importIds } });
              setImportIds("");
              setPanel("");
              return r.message;
            });
          }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 animate-fade-in"
        >
          <div className="text-sm text-slate-600">One Cartesia voice ID per line (optionally "id - name"). Names and details are read from Cartesia.</div>
          <textarea required rows={4} value={importIds} onChange={(e) => setImportIds(e.target.value)} className={`${inputCls} font-mono text-xs`} placeholder="a0e99841-438c-4a64-b679-ae501e7d6091" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPanel("")} className={btnGhost}>Cancel</button>
            <button disabled={busy !== null} className={btnPrimary}>{busy === "import" ? "Importing…" : "Import"}</button>
          </div>
        </form>
      )}

      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}
      {(error || voicesQ.error) && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error || voicesQ.error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr_auto_auto] items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or ID…" className={inputCls} />
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
          <option value="">All types</option>
          <option value="cloned">Cloned only</option>
          <option value="library">Library only</option>
        </select>
        <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputCls}>
          <option value="">Any gender</option>
          <option value="masc">Male</option>
          <option value="fem">Female</option>
          <option value="gender_neutral">Neutral</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
        </label>
        <span className="text-xs text-slate-500 text-right">
          {filtered.length} voice(s){filtered.length > shown.length ? ` · showing first ${shown.length}, refine the search` : ""}
        </span>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 bg-slate-900 text-white rounded-xl px-4 py-2 text-sm shadow-lg animate-fade-in">
          <span className="font-medium">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set())} className="text-slate-300 hover:text-white">Clear</button>
          <span className="flex-1" />
          <button onClick={() => run("bulk", async () => { const r = await api<{ message: string }>("/voice/voices/bulk", { method: "POST", body: { ids: [...selected], action: "hide" } }); setSelected(new Set()); return r.message; })} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Hide</button>
          <button onClick={() => run("bulk", async () => { const r = await api<{ message: string }>("/voice/voices/bulk", { method: "POST", body: { ids: [...selected], action: "unhide" } }); setSelected(new Set()); return r.message; })} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Unhide</button>
          <button
            onClick={() => {
              if (!confirm(`Delete ${selected.size} voice(s)? Your cloned voices are deleted in Cartesia too; library voices are just hidden. Voices used by an agent are skipped.`)) return;
              run("bulk", async () => {
                const r = await api<{ message: string }>("/voice/voices/bulk", { method: "POST", body: { ids: [...selected], action: "delete" } });
                setSelected(new Set());
                return r.message;
              });
            }}
            className="rounded-md bg-red-600 px-3 py-1 hover:bg-red-700"
          >
            Delete
          </button>
        </div>
      )}

      <p className="text-xs text-slate-500">The agent says only the first part of the voice name: "Ray - Conversationalist" introduces itself as Ray.</p>
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all voices shown"
                  checked={shown.length > 0 && shown.every((v) => selected.has(v.id))}
                  onChange={(e) => {
                    const next = new Set(selected);
                    for (const v of shown) e.target.checked ? next.add(v.id) : next.delete(v.id);
                    setSelected(next);
                  }}
                />
              </th>
              <th className="text-left px-3 py-2">Voice</th>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-left px-3 py-2">Gender</th>
              <th className="text-left px-3 py-2">Language</th>
              <th className="text-left px-3 py-2">Voice ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.id} className={`border-t border-slate-100 ${v.hidden ? "opacity-50" : ""}`}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${v.name}`}
                    checked={selected.has(v.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      e.target.checked ? next.add(v.id) : next.delete(v.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{v.name}</div>
                  {v.description && <div className="text-xs text-slate-500 line-clamp-1">{v.description}</div>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {v.is_cloned ? <span className="rounded-full bg-purple-100 text-purple-800 px-2 py-0.5">Cloned</span> : <span className="text-slate-500">Library</span>}
                  {v.hidden && <span className="ml-1 text-slate-400">hidden</span>}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.gender ? v.gender.replace(/inine|culine/, "").replace("gender_", "") : "—"}</td>
                <td className="px-3 py-2 text-slate-500">{v.language ?? "—"}</td>
                <td className="px-3 py-2 text-slate-400 font-mono text-[11px]">{v.provider_voice_id}</td>
                <td className="px-3 py-2 text-right">
                  {v.provider === "cartesia" && (
                    <button onClick={() => preview(v)} className="text-xs text-slate-500 hover:text-red-600">
                      {playing === v.id ? "■ Stop" : "▶ Preview"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  {voicesQ.loading ? "Loading voices…" : voices.length === 0 ? "No voices yet — sync the Cartesia library or clone one." : "No voices match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
