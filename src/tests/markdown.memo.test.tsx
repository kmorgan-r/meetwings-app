import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Each ReactMarkdown render is a full remark/rehype parse - ~0.6 ms a message,
// so ~430 ms per update in a 715-message conversation list.
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parses.count += 1;
    return <p>{children}</p>;
  },
}));

import { Markdown } from "@/components/Markdown";

describe("Markdown", () => {
  it("skips the parse when its parent re-renders with the same text", () => {
    const { rerender } = render(<div><Markdown>same text</Markdown></div>);
    rerender(<div className="parent-changed"><Markdown>same text</Markdown></div>);
    expect(parses.count).toBe(1);
  });

  it("re-parses when the text changes", () => {
    parses.count = 0;
    const { rerender } = render(<Markdown>first</Markdown>);
    rerender(<Markdown>second</Markdown>);
    expect(parses.count).toBe(2);
  });
});
