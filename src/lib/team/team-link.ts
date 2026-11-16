export interface TeamLink {
  gistId: string;
  key: string;
}

const GIST_ID = /^[0-9a-f]{20,32}$/;
const LINK_RE =
  /^meetwings:\/\/team\/([0-9a-f]{20,32})\/?#([A-Za-z0-9_-]{43})$/;
const GIST_URL_RE =
  /^https:\/\/gist\.github\.com\/[^/\s?#]+\/([0-9a-f]{20,32})\/?$/;

export function parseTeamLink(raw: string): TeamLink | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
  const m = LINK_RE.exec(s);
  return m ? { gistId: m[1], key: m[2] } : null;
}

export function buildTeamLink({ gistId, key }: TeamLink): string {
  return `meetwings://team/${gistId}#${key}`;
}

export function parseGistRef(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (GIST_ID.test(s)) return s;
  return GIST_URL_RE.exec(s)?.[1] ?? null;
}

export function shortGistId(gistId: string): string {
  return gistId.slice(0, 6);
}
