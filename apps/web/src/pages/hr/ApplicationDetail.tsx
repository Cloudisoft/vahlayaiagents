import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

interface ApplicationData {
  application: {
    id: string;
    status: string;
    job_title: string;
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
  };
  scores: Array<{
    overall_score: number;
    skill_match: number;
    experience_match: number;
    strengths: string[];
    concerns: string[];
    missing_requirements: string[];
    explanation: string;
    decision: string;
  }>;
  resume: { parsed_data: Record<string, unknown> | null; parsing_status: string; file_name: string } | null;
  interviews: Array<{
    id: string;
    status: string;
    overall_score: number | null;
    communication_score: number | null;
    summary: string | null;
    red_flags: string[];
    recommended_action: string | null;
    answers: Array<{ question_text: string; answer_text: string | null; relevance_score: number | null }> | null;
  }>;
  rejectionEmail: { status: string; sent_at: string | null } | null;
}

export default function ApplicationDetail() {
  const { id } = useParams();
  const [data, setData] = useState<ApplicationData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const result = await api<ApplicationData>(`/applications/${id}`);
    setData(result);
  }

  useEffect(() => {
    load();
  }, [id]);

  async function act(action: "reject" | "qualify") {
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ message: string; error?: string }>(`/applications/${id}/${action}`, { method: "POST" });
      setMessage(result.message + (result.error ? ` (${result.error})` : ""));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  if (!data) return <div className="text-sm text-slate-500">Loading...</div>;
  const { application, scores, resume, interviews, rejectionEmail } = data;
  const latestScore = scores[0];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">
          {application.first_name} {application.last_name}
        </h1>
        <p className="text-sm text-slate-500">
          {application.email} · {application.phone} · Applied for {application.job_title}
        </p>
        <span className="inline-block mt-1 text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{application.status}</span>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      <div className="flex gap-2">
        <button onClick={() => act("qualify")} className="text-sm bg-green-600 text-white rounded-md px-3 py-1.5 hover:bg-green-700">
          Mark qualified &amp; start interview
        </button>
        <button onClick={() => act("reject")} className="text-sm bg-red-600 text-white rounded-md px-3 py-1.5 hover:bg-red-700">
          Reject
        </button>
      </div>

      {rejectionEmail && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm">
          Rejection email: <strong>{rejectionEmail.status}</strong>
          {rejectionEmail.sent_at && ` · sent ${new Date(rejectionEmail.sent_at).toLocaleString()}`}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Resume</h2>
        {!resume ? (
          <p className="text-sm text-slate-500">No resume on file.</p>
        ) : resume.parsing_status !== "completed" ? (
          <p className="text-sm text-slate-500">{resume.file_name} — parsing status: {resume.parsing_status}</p>
        ) : (
          <pre className="text-xs bg-slate-50 rounded-md p-3 overflow-auto">{JSON.stringify(resume.parsed_data, null, 2)}</pre>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">AI score</h2>
        {!latestScore ? (
          <p className="text-sm text-slate-500">No score yet.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="text-3xl font-semibold text-slate-900">{latestScore.overall_score}/100</div>
            <div className="text-xs uppercase text-slate-500">{latestScore.decision}</div>
            <p className="text-slate-600">{latestScore.explanation}</p>
            {latestScore.strengths?.length > 0 && (
              <div>
                <span className="font-medium">Strengths: </span>
                {latestScore.strengths.join(", ")}
              </div>
            )}
            {latestScore.concerns?.length > 0 && (
              <div>
                <span className="font-medium">Concerns: </span>
                {latestScore.concerns.join(", ")}
              </div>
            )}
            {latestScore.missing_requirements?.length > 0 && (
              <div>
                <span className="font-medium">Missing: </span>
                {latestScore.missing_requirements.join(", ")}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">AI interview</h2>
        {interviews.length === 0 ? (
          <p className="text-sm text-slate-500">No interview scheduled yet.</p>
        ) : (
          interviews.map((iv) => (
            <div key={iv.id} className="border-t first:border-t-0 border-slate-100 pt-3 first:pt-0 mt-3 first:mt-0 text-sm space-y-2">
              <div>
                Status: <strong>{iv.status}</strong>
                {iv.overall_score !== null && ` · Score: ${iv.overall_score}/100`}
              </div>
              {iv.summary && <p className="text-slate-600">{iv.summary}</p>}
              {iv.red_flags?.length > 0 && (
                <div className="text-red-600">Red flags: {iv.red_flags.join(", ")}</div>
              )}
              {iv.answers?.map((a, i) => (
                <div key={i} className="bg-slate-50 rounded-md p-2">
                  <div className="font-medium">{a.question_text}</div>
                  <div className="text-slate-600">{a.answer_text ?? "[no response captured]"}</div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
