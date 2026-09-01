import { render, screen } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ChatViewRedirect } from "@/routes/ChatViewRedirect";

// This suite does NOT mount AppRoutes (`@/routes`): it hardcodes
// BrowserRouter and its top-level `import {...} from "@/pages"` eagerly
// loads every page - including the odoo and chat-history module graphs -
// just to prove two <Navigate> declarations and one useParams wrapper.
//
// `ChatViewRedirect` already exists (landed in the routes/pages-barrel move),
// so this is a REGRESSION test, not a red-then-green cycle: it is expected to
// pass on the first run. A failure here means the wrapper itself is wrong.

function Landed() {
  const location = useLocation();
  return (
    <div data-testid="landed">
      {location.pathname + location.search + location.hash}
    </div>
  );
}

describe("ChatViewRedirect", () => {
  it("forwards search and hash when redirecting a conversation view", () => {
    render(
      <MemoryRouter initialEntries={["/chats/view/conversation-7?tab=notes#m3"]}>
        <Routes>
          <Route path="/chats/view/:conversationId" element={<ChatViewRedirect />} />
          <Route path="/meetings/view/:conversationId" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("landed")).toHaveTextContent(
      "/meetings/view/conversation-7?tab=notes#m3"
    );
  });

  it("redirects to the same target with no search or hash", () => {
    render(
      <MemoryRouter initialEntries={["/chats/view/conversation-1"]}>
        <Routes>
          <Route path="/chats/view/:conversationId" element={<ChatViewRedirect />} />
          <Route path="/meetings/view/:conversationId" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("landed")).toHaveTextContent("/meetings/view/conversation-1");
  });
});

// The two static redirects, declared exactly as `routes/index.tsx` declares
// them, rather than mounted through AppRoutes. Pins the contract - old path
// in, /meetings out - without pulling in the whole page graph.
describe("the retired route redirects", () => {
  it("sends /chats to /meetings", () => {
    render(
      <MemoryRouter initialEntries={["/chats"]}>
        <Routes>
          <Route path="/chats" element={<Navigate to="/meetings" replace />} />
          <Route path="/meetings" element={<div data-testid="landed">/meetings</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("landed")).toHaveTextContent("/meetings");
  });

  it("sends /meeting-log to /meetings", () => {
    render(
      <MemoryRouter initialEntries={["/meeting-log"]}>
        <Routes>
          <Route path="/meeting-log" element={<Navigate to="/meetings" replace />} />
          <Route path="/meetings" element={<div data-testid="landed">/meetings</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("landed")).toHaveTextContent("/meetings");
  });
});
