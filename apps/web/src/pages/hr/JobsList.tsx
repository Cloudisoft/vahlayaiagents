import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api.js";

interface JobRow {
  id: string;
  title: string;
  status: string;
  location: string | null;
  employment_type: string | null;
  public_slug: string | null;
  application_count: string;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  published: "bg-green-100 text-green-700",
  unpublished: "bg-amber-100 text-amber-700",
  archived: "bg-slate-200 text-slate-500",
};

export default function JobsList() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ jobs: JobRow[] }>("/jobs").then((r) => {
      setJobs(r.jobs);
      setLoading(false);
    });
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">VahlayHR — Jobs</h1>
        <Link to="/hr/jobs/new" className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700">
          + New Job
        </Link>
      </div>

      {loading ? (
        <div className="text-sm text-slate-500">Loading...</div>
      ) : jobs.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
          No jobs yet. Create your first job posting.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Title</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Location</th>
                <th className="text-left px-4 py-3">Applications</th>
                <th className="text-left px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/hr/jobs/${j.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                      {j.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs rounded-full px-2 py-0.5 ${STATUS_COLORS[j.status] ?? ""}`}>{j.status}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{j.location ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{j.application_count}</td>
                  <td className="px-4 py-3 text-slate-500">{new Date(j.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
