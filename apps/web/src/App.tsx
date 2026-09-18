import { Route, Routes } from "react-router-dom";
import Login from "./pages/Login.js";
import Signup from "./pages/Signup.js";
import ForgotPassword from "./pages/ForgotPassword.js";
import ResetPassword from "./pages/ResetPassword.js";
import Dashboard from "./pages/Dashboard.js";
import Settings from "./pages/Settings.js";
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
import ProtectedRoute from "./components/ProtectedRoute.js";
import Sidebar from "./components/Sidebar.js";
import ModulePlaceholder from "./components/ModulePlaceholder.js";

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-8">{children}</main>
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
            <AppShell>
              <VoiceHome />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/agents/new"
        element={
          <ProtectedRoute>
            <AppShell>
              <AgentNew />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/campaigns/new"
        element={
          <ProtectedRoute>
            <AppShell>
              <CampaignNew />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route
        path="/voice/campaigns/:id"
        element={
          <ProtectedRoute>
            <AppShell>
              <CampaignDetail />
            </AppShell>
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
    </Routes>
  );
}
