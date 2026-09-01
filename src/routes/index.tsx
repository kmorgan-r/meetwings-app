import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import {
  Dashboard,
  App,
  SystemPrompts,
  ViewChat,
  Settings,
  DevSpace,
  Shortcuts,
  Audio,
  Screenshot,
  Responses,
  CostTracking,
  ContextMemory,
  Speakers,
  Language,
  Odoo,
  Meetings,
} from "@/pages";
import { DashboardLayout } from "@/layouts";
import { ChatViewRedirect } from "./ChatViewRedirect";

export default function AppRoutes() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<App />} />
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/system-prompts" element={<SystemPrompts />} />
          <Route path="/shortcuts" element={<Shortcuts />} />
          <Route path="/screenshot" element={<Screenshot />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/audio" element={<Audio />} />
          <Route path="/responses" element={<Responses />} />
          <Route path="/cost-tracking" element={<CostTracking />} />
          <Route path="/context-memory" element={<ContextMemory />} />
          <Route path="/speakers" element={<Speakers />} />
          <Route path="/language" element={<Language />} />
          <Route path="/api-setup" element={<DevSpace />} />
          <Route path="/odoo" element={<Odoo />} />
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/meetings/view/:conversationId" element={<ViewChat />} />
          {/* Redirect old routes for backward compatibility */}
          <Route path="/chats" element={<Navigate to="/meetings" replace />} />
          <Route path="/meeting-log" element={<Navigate to="/meetings" replace />} />
          <Route path="/chats/view/:conversationId" element={<ChatViewRedirect />} />
          <Route path="/dev-space" element={<Navigate to="/api-setup" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
