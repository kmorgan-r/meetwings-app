import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/chats/view/:conversationId` -> `/meetings/view/:conversationId`.
 *
 * Its own module because `Navigate`'s `to` is a static string and cannot
 * re-interpolate the param, and because defined inside routes/index.tsx it
 * would be unimportable by its test - that file's top-level `import {...} from
 * "@/pages"` eagerly loads every page.
 *
 * Search and hash are carried across. No caller passes either today, so this is
 * forward-proofing; a redirect that silently truncates a deep link is a trap.
 */
export function ChatViewRedirect() {
  const { conversationId } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={`/meetings/view/${conversationId}${location.search}${location.hash}`}
      replace
    />
  );
}
