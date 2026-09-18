import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

interface Job {
  id: string;
  title: string;
  description: string;
  status: string;
  public_slug: string | null;
  ai_criteria: Record<string, unknown>;
  score_reject_threshold: number;
  score_review_threshold: number;
}

interface InterviewQuestion {
  id: string;
  question: string;
  order_index: number;
}

interface ApplicationRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  status: string;
  overall_score: number | null;
  decision: string | null;
  created_at: string;
}

export default function JobDetail() {
  const { id } = useParams();
  const [job, setJob] = useState<Job | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [newQuestion, setNewQuestion] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  async function load() {
    const { job, interviewQuestions } = await api<{ job: Job; interviewQuestions: InterviewQuestion[] }>(`/jobs/${id}`);
    setJob(job);
    setQuestions(interviewQuestions);
    const { applications } = await api<{ applications: ApplicationRow[] }>(`/applications?jobId=${id}`);
    setApplications(applications);
  }

  useEffect(() => {
    load();
  }, [id]);

  async function runAction(path: string, method = "POST") {
    setError(null);
    setMessage(null);
    try {
      await api(path, { method });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  async function analyze() {
    setAnalyzing(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/jobs/${id}/analyze`, { method: "POST" });
      setMessage("AI analysis complete.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Analysis failed.");
    } finally {
      setAnalyzing(false);
    }
  }

  async function addQuestion() {
    if (!newQuestion.trim()) return;
    await api(`/jobs/${id}/interview-questions`, { method: "POST", body: { question: newQuestion } });
    setNewQuestion("");
    await load();
  }

  async function removeQuestion(qid: string) {
    await api(`/jobs/${id}/interview-questions/${qid}`, { method: "DELETE" });
    await load();
  }

  if (!job) return <div className="text-sm text-slate-500">Loading...</div>;

  const publicUrl = job.public_slug ? `${window.location.origin}/apply/${job.public_slug}` : null;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{job.title}</h1>
          <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{job.status}</span>
        </div>
        <div className="flex gap-2">
          {job.status !== "published" && (
            <button onClick={() => runAction(`/jobs/${id}/publish`)} className="text-sm bg-green-600 text-white rounded-md px-3 py-1.5 hover:bg-green-700">
              Publish
            </button>
          )}
          {job.status === "published" && (
            <button onClick={() => runAction(`/jobs/${id}/unpublish`)} className="text-sm bg-amber-600 text-white rounded-md px-3 py-1.5 hover:bg-amber-700">
              Unpublish
            </button>
          )}
          <button onClick={() => runAction(`/jobs/${id}/archive`)} className="text-sm bg-slate-600 text-white rounded-md px-3 py-1.5 hover:bg-slate-700">
            Archive
          </button>
          <button onClick={() => runAction(`/jobs/${id}/duplicate`)} className="text-sm bg-white border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50">
            Duplicate
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      {publicUrl && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm">
          <span className="text-slate-500">Public application URL: </span>
          <a href={publicUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
            {publicUrl}
          </a>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-slate-900">AI-derived hiring criteria</h2>
          <button onClick={analyze} disabled={analyzing} className="text-sm bg-slate-900 text-white rounded-md px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50">
            {analyzing ? "Analyzing..." : "Run AI analysis"}
          </button>
        </div>
        {Object.keys(job.ai_criteria ?? {}).length === 0 ? (
          <p className="text-sm text-slate-500">No AI analysis run yet. Requires an OpenAI API key in Settings.</p>
        ) : (
          <pre className="text-xs bg-slate-50 rounded-md p-3 overflow-auto">{JSON.stringify(job.ai_criteria, null, 2)}</pre>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">AI interview questions</h2>
        <div className="space-y-2 mb-4">
          {questions.map((q) => (
            <div key={q.id} className="flex items-center justify-between bg-slate-50 rounded-md px-3 py-2 text-sm">
              <span>{q.question}</span>
              <button onClick={() => removeQuestion(q.id)} className="text-red-600 text-xs hover:underline">
                Remove
              </button>
            </div>
          ))}
          {questions.length === 0 && <p className="text-sm text-slate-500">No interview questions configured yet.</p>}
        </div>
        <div className="flex gap-2">
          <input
            value={newQuestion}
            onChange={(e) => setNewQuestion(e.target.value)}
            placeholder="Add an interview question"
            className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
          <button onClick={addQuestion} className="text-sm bg-slate-900 text-white rounded-md px-3 py-2 hover:bg-slate-800">
            Add
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 font-medium text-slate-900">Applications</div>
        {applications.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">No applications yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Candidate</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Score</th>
                <th className="text-left px-4 py-2">Applied</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((a) => (
                <tr key={a.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <Link to={`/hr/applications/${a.id}`} className="text-slate-900 hover:text-indigo-600">
                      {a.first_name} {a.last_name}
                    </Link>
                    <div className="text-xs text-slate-500">{a.email}</div>
                  </td>
                  <td className="px-4 py-2">{a.status}</td>
                  <td className="px-4 py-2">{a.overall_score ?? "—"}</td>
                  <td className="px-4 py-2 text-slate-500">{new Date(a.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
