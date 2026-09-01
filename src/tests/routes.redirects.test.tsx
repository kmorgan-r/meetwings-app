import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// The pair above hand-declares its own <Navigate> elements rather than
// mounting the real routing table - for the reason in this file's top
// comment, AppRoutes' `import {...} from "@/pages"` eagerly loads every page.
// That means neither test above would notice someone deleting the actual
// <Route> for /chats or /meeting-log out of routes/index.tsx - src-tauri's
// window.rs pointed the dashboard webview straight at the retired /chats path
// (fixed alongside this test) and nothing here caught it, because the
// redirect made the app still work despite the stale reference. This reads
// routes/index.tsx as text instead of mounting it, so a deleted redirect
// fails a test even though it costs the same "no full page graph" property
// the tests above are written to preserve.
describe("the real route table", () => {
  // `process.cwd()`-relative, not `import.meta.url`-relative: vitest's transform
  // does not always hand this file a `file://`-scheme URL, and `fileURLToPath`
  // throws on anything else. Vitest always runs from the project root.
  const routesSource = readFileSync(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");

  it("still declares the /chats redirect", () => {
    expect(routesSource).toMatch(
      /<Route\s+path="\/chats"\s+element=\{<Navigate\s+to="\/meetings"\s+replace\s*\/>\}\s*\/>/
    );
  });

  it("still declares the /meeting-log redirect", () => {
    expect(routesSource).toMatch(
      /<Route\s+path="\/meeting-log"\s+element=\{<Navigate\s+to="\/meetings"\s+replace\s*\/>\}\s*\/>/
    );
  });
});
