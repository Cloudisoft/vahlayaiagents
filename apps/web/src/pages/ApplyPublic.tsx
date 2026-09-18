import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";

interface PublicJob {
  id: string;
  title: string;
  description: string;
  location: string | null;
  employmentType: string | null;
  organizationName: string;
}

export default function ApplyPublic() {
  const { slug } = useParams();
  const [job, setJob] = useState<PublicJob | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    fetch(`/api/public/jobs/${slug}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setJob(d.job))
      .catch(() => setNotFound(true));
  }, [slug]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) {
      setError("Please attach your resume.");
      return;
    }
    setError(null);
    setBusy(true);
    const form = new FormData(e.currentTarget);
    form.append("resume", file);
    try {
      const res = await fetch(`/api/public/jobs/${slug}/apply`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Submission failed.");
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">This job posting is not available.</div>;
  }
  if (!job) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading...</div>;
  }
  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">Application submitted</h1>
          <p className="text-sm text-slate-500">
            Thanks for applying to {job.title} at {job.organizationName}. We'll be in touch.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">{job.title}</h1>
          <p className="text-sm text-slate-500">
            {job.organizationName} {job.location ? `· ${job.location}` : ""} {job.employmentType ? `· ${job.employmentType}` : ""}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6 whitespace-pre-wrap text-sm text-slate-700">
          {job.description}
        </div>

        <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">First name</label>
              <input name="firstName" required className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Last name</label>
              <input name="lastName" required className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input type="email" name="email" required className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
              <input name="phone" required className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Current company</label>
              <input name="currentCompany" className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Years of experience</label>
              <input name="yearsExperience" type="number" className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Expected salary</label>
              <input name="expectedSalary" type="number" className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Notice period</label>
              <input name="noticePeriod" className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Resume (PDF, DOC, DOCX, or TXT)</label>
            <input
              type="file"
              accept=".pdf,.doc,.docx,.txt"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Cover letter (optional)</label>
            <textarea name="coverLetter" rows={4} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={busy} className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Submitting..." : "Submit application"}
          </button>
        </form>
      </div>
    </div>
  );
}
