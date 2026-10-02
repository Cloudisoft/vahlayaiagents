import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";

interface PublicJob {
  id: string;
  title: string;
  description: string;
  location: string | null;
  employment_type: string | null;
  department: string | null;
  requirements: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  published_at: string | null;
  created_at: string;
  organizationName: string;
}

// Google for Jobs reads this JobPosting data from the page.
function useJobPostingLd(job: PublicJob | null) {
  useEffect(() => {
    if (!job) return;
    document.title = `${job.title} · ${job.organizationName}`;
    const el = document.createElement("script");
    el.type = "application/ld+json";
    el.text = JSON.stringify({
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      title: job.title,
      description: job.description.replace(/\n/g, "<br>"),
      datePosted: job.published_at ?? job.created_at,
      hiringOrganization: { "@type": "Organization", name: job.organizationName },
      ...(job.location && /remote/i.test(job.location) ? { jobLocationType: "TELECOMMUTE" } : job.location ? { jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: job.location } } } : {}),
      ...(job.salary_min || job.salary_max ? { baseSalary: { "@type": "MonetaryAmount", currency: job.salary_currency ?? "USD", value: { "@type": "QuantitativeValue", ...(job.salary_min ? { minValue: Number(job.salary_min) } : {}), ...(job.salary_max ? { maxValue: Number(job.salary_max) } : {}), unitText: "YEAR" } } } : {}),
      url: window.location.href,
    });
    document.head.appendChild(el);
    return () => el.remove();
  }, [job]);
}

export default function ApplyPublic() {
  const { slug } = useParams();
  const [job, setJob] = useState<PublicJob | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  useJobPostingLd(job);

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
    return <div className="min-h-screen flex items-center justify-center text-slate-500 px-4 text-center">This job posting is no longer accepting applications.</div>;
  }
  if (!job) {
    return (
      <div className="min-h-screen bg-slate-50 py-10 px-4">
        <div className="max-w-2xl mx-auto space-y-3">
          <div className="h-8 w-2/3 rounded-lg bg-slate-200 animate-pulse" />
          <div className="h-48 rounded-2xl bg-slate-200/70 animate-pulse" />
        </div>
      </div>
    );
  }
  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="max-w-md text-center bg-white border border-slate-200 rounded-2xl p-8 animate-pop-in">
          <div className="mx-auto w-12 h-12 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xl mb-3">✓</div>
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
          <div className="text-sm font-medium text-red-600">{job.organizationName}</div>
          <h1 className="text-3xl font-semibold text-slate-900 mt-1">{job.title}</h1>
          <div className="flex flex-wrap gap-2 mt-3">
            {[job.department, job.location, job.employment_type?.replace("_", "-"), job.salary_min || job.salary_max ? `${job.salary_currency ?? "USD"} ${[job.salary_min, job.salary_max].filter(Boolean).map((n) => Number(n).toLocaleString()).join(" – ")}` : null]
              .filter(Boolean)
              .map((t) => <span key={t as string} className="text-xs bg-white border border-slate-200 rounded-full px-3 py-1 text-slate-600 capitalize">{t}</span>)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6 mb-6 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
          {job.description}
          {job.requirements && (
            <>
              <div className="font-semibold text-slate-900 mt-5 mb-1">Requirements</div>
              {job.requirements}
            </>
          )}
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Apply</h2>

        <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
          <div className="grid sm:grid-cols-2 gap-4">
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
            <label className="block text-sm font-medium text-slate-700 mb-1">Resume (PDF, DOC or DOCX)</label>
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Cover letter (optional)</label>
            <textarea name="coverLetter" rows={4} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
          </div>
          <button type="submit" disabled={busy} className="w-full sm:w-auto bg-red-600 text-white text-sm font-medium rounded-lg px-5 py-2.5 hover:bg-red-700 disabled:opacity-50">
            {busy ? "Submitting..." : "Submit application"}
          </button>
          <p className="text-xs text-slate-400">Your resume is reviewed with the help of AI and by our hiring team. We only use what's in your application, and we'll never contact you without a reason related to this role.</p>
        </form>
      </div>
    </div>
  );
}
