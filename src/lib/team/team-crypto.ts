const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SEG_RE = /^[A-Za-z0-9_-]+$/;
const PREFIX = "mwt1";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function importKey(key: string, usage: KeyUsage) {
  if (!KEY_RE.test(key)) throw new Error("invalid team key");
  return crypto.subtle.importKey(
    "raw",
    unb64url(key) as BufferSource,
    "AES-GCM",
    false,
    [usage],
  );
}

export function generateTeamKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function encryptTeamPayload(
  plaintext: string,
  key: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(key, "encrypt"),
    new TextEncoder().encode(plaintext),
  );
  return `${PREFIX}.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decryptTeamPayload(
  blob: string,
  key: string,
): Promise<string | null> {
  try {
    if (typeof blob !== "string" || typeof key !== "string") return null;
    if (!KEY_RE.test(key)) return null;
    const parts = blob.trim().split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    if (!SEG_RE.test(parts[1]) || !SEG_RE.test(parts[2])) return null;
    const iv = unb64url(parts[1]);
    if (iv.length !== 12) return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      await importKey(key, "decrypt"),
      unb64url(parts[2]) as BufferSource,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(pt);
  } catch {
    return null;
  }
}
