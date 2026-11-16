import { describe, it, expect } from "vitest";
import {
  parseTeamLink,
  buildTeamLink,
  parseGistRef,
  shortGistId,
} from "@/lib/team/team-link";

const ID = "a".repeat(32),
  KEY = "A".repeat(43),
  LINK = `meetwings://team/${ID}#${KEY}`;

describe("team-link", () => {
  it("accepts a valid link", () =>
    expect(parseTeamLink(LINK)).toEqual({ gistId: ID, key: KEY }));
  it("accepts a trailing slash before the fragment", () =>
    expect(parseTeamLink(`meetwings://team/${ID}/#${KEY}`)).not.toBeNull());
  it("accepts surrounding whitespace, newline and <> wrapping", () => {
    expect(parseTeamLink(`  ${LINK}\n`)).not.toBeNull();
    expect(parseTeamLink(`<${LINK}>`)).not.toBeNull();
  });
  it.each([
    ["http scheme", `http://team/${ID}#${KEY}`],
    ["gist web URL", `https://gist.github.com/u/${ID}`],
    ["wrong host", `meetwings://evil/${ID}#${KEY}`],
    ["no key", `meetwings://team/${ID}`],
    ["short key", `meetwings://team/${ID}#${KEY.slice(1)}`],
    ["uppercase id", `meetwings://team/${ID.toUpperCase()}#${KEY}`],
    ["short id", `meetwings://team/abc#${KEY}`],
    ["query", `meetwings://team/${ID}?x=1#${KEY}`],
    ["inner newline", `meetwings://team/${ID}\n#${KEY}`],
  ])("rejects %s", (_n, raw) => expect(parseTeamLink(raw)).toBeNull());
  it("build -> parse round trip", () =>
    expect(parseTeamLink(buildTeamLink({ gistId: ID, key: KEY }))).toEqual({
      gistId: ID,
      key: KEY,
    }));
  it("parseGistRef takes a bare id or a gist URL", () => {
    expect(parseGistRef(ID)).toBe(ID);
    expect(parseGistRef(`https://gist.github.com/someone/${ID}/`)).toBe(ID);
    expect(parseGistRef("https://example.com/x")).toBeNull();
  });
  it("shortGistId returns the first 6 chars", () =>
    expect(shortGistId("abcdef123456")).toBe("abcdef"));
});
