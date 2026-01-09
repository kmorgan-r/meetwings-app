import { Sidebar } from "@/components";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "./ErrorLayout";
import { useSetupStatus } from "@/hooks";
import { useEffect } from "react";

export const DashboardLayout = () => {
  const { isComplete } = useSetupStatus();
  const location = useLocation();
  const navigate = useNavigate();

  // Redirect to API Setup if not configured
  useEffect(() => {
    if (!isComplete && location.pathname !== "/api-setup") {
      navigate("/api-setup", { replace: true });
    }
  }, [isComplete, location.pathname, navigate]);

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout />;
      }}
      resetKeys={["dashboard-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div className="relative flex h-screen w-screen overflow-hidden bg-background">
        {/* Draggable region */}
        <div
          className="absolute left-0 right-0 top-0 z-50 h-10 select-none"
          data-tauri-drag-region={true}
        />

        {/* Sidebar */}
        <Sidebar />
        {/* Main Content */}
        <main className="flex flex-1 flex-col overflow-hidden px-8">
          <Outlet />
        </main>
      </div>
    </ErrorBoundary>
  );
};
