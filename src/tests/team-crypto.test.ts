import { describe, it, expect } from "vitest";
import {
  generateTeamKey,
  encryptTeamPayload,
  decryptTeamPayload,
} from "@/lib/team/team-crypto";

describe("team-crypto", () => {
  it("round trips", async () => {
    const k = generateTeamKey();
    expect(await decryptTeamPayload(await encryptTeamPayload("hi", k), k)).toBe(
      "hi",
    );
  });
  it("uses a fresh IV each time", async () => {
    const k = generateTeamKey();
    const a = await encryptTeamPayload("same", k);
    const b = await encryptTeamPayload("same", k);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });
  it("generateTeamKey matches the key shape", () =>
    expect(generateTeamKey()).toMatch(/^[A-Za-z0-9_-]{43}$/));
  it("wrong key -> null", async () => {
    const blob = await encryptTeamPayload("hi", generateTeamKey());
    expect(await decryptTeamPayload(blob, generateTeamKey())).toBeNull();
  });
  it("tampered ciphertext -> null", async () => {
    const k = generateTeamKey();
    const [p, iv, ct] = (await encryptTeamPayload("hello world", k)).split(".");
    const mid = Math.floor(ct.length / 2);
    const swap = ct[mid] === "B" ? "C" : "B";
    const bad = [p, iv, ct.slice(0, mid) + swap + ct.slice(mid + 1)].join(".");
    expect(await decryptTeamPayload(bad, k)).toBeNull();
  });
  it("missing mwt1 prefix -> null", async () => {
    const k = generateTeamKey();
    const blob = await encryptTeamPayload("hi", k);
    expect(await decryptTeamPayload(blob.replace("mwt1.", "mwt2."), k)).toBeNull();
    expect(await decryptTeamPayload(blob.slice(5), k)).toBeNull();
  });
  it("encrypt rejects wrong-size or padded keys", async () => {
    const k = generateTeamKey();
    await expect(encryptTeamPayload("x", "A".repeat(22))).rejects.toThrow();
    await expect(encryptTeamPayload("x", "A".repeat(32))).rejects.toThrow();
    await expect(encryptTeamPayload("x", k + "\n")).rejects.toThrow();
  });
  it("trailing newline on blob still decrypts; non-base64url segment chars -> null", async () => {
    const k = generateTeamKey();
    const blob = await encryptTeamPayload("hi", k);
    expect(await decryptTeamPayload(blob + "\n", k)).toBe("hi");
    // "hii" gives a 26-char ct segment, so "==" padding makes it valid for
    // atob: only the segment alphabet check can reject it.
    const padded = await encryptTeamPayload("hii", k);
    const [p, iv, ct] = padded.split(".");
    expect(await decryptTeamPayload([p, iv, ct + "=="].join("."), k)).toBeNull();
    // atob strips inner whitespace; the alphabet check must not.
    const spaced = iv.slice(0, 8) + "    " + iv.slice(8);
    expect(await decryptTeamPayload([p, spaced, ct].join("."), k)).toBeNull();
  });
  it("extra segment -> null", async () => {
    const k = generateTeamKey();
    const blob = await encryptTeamPayload("hi", k);
    expect(await decryptTeamPayload(blob + ".x", k)).toBeNull();
  });
  it("malformed input -> null without throwing", async () => {
    const k = generateTeamKey();
    const blob = await encryptTeamPayload("hi", k);
    expect(await decryptTeamPayload(blob, "short")).toBeNull();
    expect(await decryptTeamPayload(blob, "A".repeat(42) + "!")).toBeNull();
    expect(await decryptTeamPayload(blob, "A".repeat(43))).toBeNull();
    expect(await decryptTeamPayload("mwt1.!!!.???", k)).toBeNull();
    expect(await decryptTeamPayload("mwt1.AAAA.AAAA", k)).toBeNull();
    expect(await decryptTeamPayload("mwt1.a", k)).toBeNull();
    expect(await decryptTeamPayload("", k)).toBeNull();
  });
});
