import { lazy, Suspense } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Login from "./pages/Login.js";
import ProtectedRoute from "./components/ProtectedRoute.js";
import Navbar from "./components/Navbar.js";
import VoiceLayout from "./components/VoiceLayout.js";

// Pages load on demand so the first screen ships only what it needs.
const Signup = lazy(() => import("./pages/Signup.js"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword.js"));
const ResetPassword = lazy(() => import("./pages/ResetPassword.js"));
const ApplyPublic = lazy(() => import("./pages/ApplyPublic.js"));
const Dashboard = lazy(() => import("./pages/Dashboard.js"));
const Settings = lazy(() => import("./pages/Settings.js"));
const Usage = lazy(() => import("./pages/Usage.js"));
const Profile = lazy(() => import("./pages/Profile.js"));
const AdminPanel = lazy(() => import("./pages/AdminPanel.js"));
const JobsList = lazy(() => import("./pages/hr/JobsList.js"));
const JobNew = lazy(() => import("./pages/hr/JobNew.js"));
const JobDetail = lazy(() => import("./pages/hr/JobDetail.js"));
const ApplicationDetail = lazy(() => import("./pages/hr/ApplicationDetail.js"));
const CoverageHome = lazy(() => import("./pages/coverage/CoverageHome.js"));
const LeadGenHome = lazy(() => import("./pages/leadgen/LeadGenHome.js"));
const VoiceDashboard = lazy(() => import("./pages/voice/VoiceDashboard.js"));
const VoiceHome = lazy(() => import("./pages/voice/VoiceHome.js"));
const AgentNew = lazy(() => import("./pages/voice/AgentNew.js"));
const CampaignNew = lazy(() => import("./pages/voice/CampaignNew.js"));
const CampaignDetail = lazy(() => import("./pages/voice/CampaignDetail.js"));
const Callbacks = lazy(() => import("./pages/voice/Callbacks.js"));
const LiveCalls = lazy(() => import("./pages/voice/LiveCalls.js"));
const VoiceLeads = lazy(() => import("./pages/voice/VoiceLeads.js"));
const CallHistory = lazy(() => import("./pages/voice/CallHistory.js"));
const Analytics = lazy(() => import("./pages/voice/Analytics.js"));
const Dispositions = lazy(() => import("./pages/voice/Dispositions.js"));
const AuditorHome = lazy(() => import("./pages/auditor/AuditorHome.js"));

function PageFallback() {
  return (
    <div className="fixed top-0 left-0 right-0 z-50 h-0.5 overflow-hidden" aria-hidden>
      <div className="h-full w-1/3 bg-red-500 animate-progress" />
    </div>
  );
}

// Each page fades up into place; keyed by path so it replays on navigation.
function PageTransition() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="animate-page-in">
      <Outlet />
    </div>
  );
}

// Layout routes stay mounted while you move between their pages, so the
// navbar, sidebar and their live counters never reload or flicker.
function AppShell() {
  const location = useLocation();
  const isHome = location.pathname === "/";
  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-slate-50">
        <Navbar />
        {!isHome && (
          <div className="max-w-6xl mx-auto px-6 pt-4">
            <Link to="/" className="text-sm text-slate-500 hover:text-red-600">
              ← Back to Dashboard
            </Link>
          </div>
        )}
        <main className="max-w-6xl mx-auto p-6">
          <Suspense fallback={<PageFallback />}>
            <PageTransition />
          </Suspense>
        </main>
      </div>
    </ProtectedRoute>
  );
}

function VoiceShell() {
  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-slate-50">
        <Navbar />
        <VoiceLayout>
          <Suspense fallback={<PageFallback />}>
            <PageTransition />
          </Suspense>
        </VoiceLayout>
      </div>
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/apply/:slug" element={<ApplyPublic />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/hr" element={<JobsList />} />
          <Route path="/hr/jobs/new" element={<JobNew />} />
          <Route path="/hr/jobs/:id" element={<JobDetail />} />
          <Route path="/hr/applications/:id" element={<ApplicationDetail />} />
          <Route path="/coverage" element={<CoverageHome />} />
          <Route path="/leadgen" element={<LeadGenHome />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/admin" element={<AdminPanel />} />
          <Route path="/qc" element={<AuditorHome />} />
        </Route>

        <Route path="/voice" element={<VoiceShell />}>
          <Route index element={<VoiceDashboard />} />
          <Route path="campaigns" element={<VoiceHome tab="campaigns" />} />
          <Route path="campaigns/new" element={<CampaignNew />} />
          <Route path="campaigns/:id" element={<CampaignDetail />} />
          <Route path="callbacks" element={<Callbacks />} />
          <Route path="live" element={<LiveCalls />} />
          <Route path="leads" element={<VoiceLeads />} />
          <Route path="history" element={<CallHistory />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="dispositions" element={<Dispositions />} />
          <Route path="auditor" element={<Navigate to="/qc" replace />} />
          <Route path="agents" element={<VoiceHome key="agents" tab="agents" />} />
          <Route path="agents/new" element={<AgentNew />} />
          <Route path="agents/:id" element={<AgentNew />} />
          <Route path="voices" element={<VoiceHome key="voices" tab="voices" />} />
          <Route path="numbers" element={<VoiceHome key="numbers" tab="numbers" />} />
          <Route path="dnc" element={<VoiceHome key="dnc" tab="dnc" />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
