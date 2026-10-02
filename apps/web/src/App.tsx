import { Link, Route, Routes, useLocation } from "react-router-dom";
import Login from "./pages/Login.js";
import Signup from "./pages/Signup.js";
import ForgotPassword from "./pages/ForgotPassword.js";
import ResetPassword from "./pages/ResetPassword.js";
import Dashboard from "./pages/Dashboard.js";
import Settings from "./pages/Settings.js";
import Usage from "./pages/Usage.js";
import Profile from "./pages/Profile.js";
import AdminPanel from "./pages/AdminPanel.js";
import ApplyPublic from "./pages/ApplyPublic.js";
import JobsList from "./pages/hr/JobsList.js";
import JobNew from "./pages/hr/JobNew.js";
import JobDetail from "./pages/hr/JobDetail.js";
import ApplicationDetail from "./pages/hr/ApplicationDetail.js";
import CoverageHome from "./pages/coverage/CoverageHome.js";
import LeadGenHome from "./pages/leadgen/LeadGenHome.js";
import VoiceHome from "./pages/voice/VoiceHome.js";
import AgentNew from "./pages/voice/AgentNew.js";
import CampaignNew from "./pages/voice/CampaignNew.js";
import CampaignDetail from "./pages/voice/CampaignDetail.js";
import LiveCalls from "./pages/voice/LiveCalls.js";
import CallHistory from "./pages/voice/CallHistory.js";
import AuditorHome from "./pages/auditor/AuditorHome.js";
import VoiceDashboard from "./pages/voice/VoiceDashboard.js";
import Analytics from "./pages/voice/Analytics.js";
import Callbacks from "./pages/voice/Callbacks.js";
import VoiceLeads from "./pages/voice/VoiceLeads.js";
import Dispositions from "./pages/voice/Dispositions.js";
import VoiceLayout from "./components/VoiceLayout.js";
import ProtectedRoute from "./components/ProtectedRoute.js";
import Navbar from "./components/Navbar.js";

function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isHome = location.pathname === "/";
  return (
    <div className="min-h-screen bg-slate-50">
      <Navbar />
      {!isHome && (
        <div className="max-w-6xl mx-auto px-6 pt-4">
          <Link to="/" className="text-sm text-slate-500 hover:text-red-600">
            ← Back to Dashboard
          </Link>
        </div>
      )}
      <main className="max-w-6xl mx-auto p-6">{children}</main>
    </div>
  );
}

function VoiceShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <Navbar />
      <VoiceLayout>{children}</VoiceLayout>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/apply/:slug" element={<ApplyPublic />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppShell>
              <Dashboard />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr"
        element={
          <ProtectedRoute>
            <AppShell>
              <JobsList />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/jobs/new"
        element={
          <ProtectedRoute>
            <AppShell>
              <JobNew />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/jobs/:id"
        element={
          <ProtectedRoute>
            <AppShell>
              <JobDetail />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/hr/applications/:id"
        element={
          <ProtectedRoute>
            <AppShell>
              <ApplicationDetail />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/coverage"
        element={
          <ProtectedRoute>
            <AppShell>
              <CoverageHome />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/leadgen"
        element={
          <ProtectedRoute>
            <AppShell>
              <LeadGenHome />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceDashboard />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/campaigns"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceHome tab="campaigns" />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/campaigns/new"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <CampaignNew />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/campaigns/:id"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <CampaignDetail />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/callbacks"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <Callbacks />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/live"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <LiveCalls />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/leads"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceLeads />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/history"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <CallHistory />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/analytics"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <Analytics />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/dispositions"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <Dispositions />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/auditor"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <AuditorHome />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/agents"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceHome tab="agents" />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/agents/new"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <AgentNew />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/agents/:id"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <AgentNew />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/voices"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceHome tab="voices" />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/numbers"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceHome tab="numbers" />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/dnc"
        element={
          <ProtectedRoute>
            <VoiceShell>
              <VoiceHome tab="dnc" />
            </VoiceShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <AppShell>
              <Settings />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/usage"
        element={
          <ProtectedRoute>
            <AppShell>
              <Usage />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <AppShell>
              <Profile />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AppShell>
              <AdminPanel />
            </AppShell>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
