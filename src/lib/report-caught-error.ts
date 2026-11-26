declare global {
  interface Window {
    Sentry?: { captureException(error: unknown, hint?: unknown): unknown };
  }
}

// React 19 does not send boundary-caught errors to window.onerror, so the
// injected Sentry SDK never sees them; report them here.
export function reportCaughtError(
  error: unknown,
  errorInfo: { componentStack?: string }
): void {
  try {
    window.Sentry?.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
    });
  } catch {
    // Reporting must never mask the original error.
  }
  // This handler replaces React's default logging, so log here.
  console.error(error, errorInfo.componentStack);
}
