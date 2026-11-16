import { useEffect, useState } from "react";
import { Button, Header, Input, Label } from "@/components";
import { TeamJoinBox } from "@/components/TeamJoinBox";
import { useTeamState } from "@/hooks/useTeamState";
import { secureGet, secureSet } from "@/lib/secure-storage";
import { encryptTeamPayload, generateTeamKey } from "@/lib/team/team-crypto";
import { exportTeamSettings, TEAM_COPY } from "@/lib/team/team-file";
import { buildTeamLink, parseGistRef } from "@/lib/team/team-link";
import {
  TEAM_OWNER_GIST_SECURE_KEY,
  TEAM_OWNER_KEY_SECURE_KEY,
} from "@/lib/team/team-sync";

const COPY_FAILED = "Couldn't copy. Try again.";

/**
 * The owner key and the team link are secrets: only "has it" booleans live in
 * state, and the values are read at click time and go to the clipboard alone.
 */
export const TeamSettingsCard = () => {
  const [state, send] = useTeamState();
  const [hasKey, setHasKey] = useState(false);
  const [hasGist, setHasGist] = useState(false);
  const [gistInput, setGistInput] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [key, gist] = await Promise.all([
        secureGet(TEAM_OWNER_KEY_SECURE_KEY).catch(() => null),
        secureGet(TEAM_OWNER_GIST_SECURE_KEY).catch(() => null),
      ]);
      if (cancelled) return;
      setHasKey(!!key);
      setHasGist(!!gist);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const say = (ok: boolean, text: string) => setNote({ ok, text });

  const copy = async (text: string, okText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(true, okText);
    } catch {
      say(false, COPY_FAILED);
    }
  };

  const createKey = async () => {
    try {
      await secureSet(TEAM_OWNER_KEY_SECURE_KEY, generateTeamKey());
      setHasKey(true);
    } catch {
      say(false, TEAM_COPY.TEAM_WRITE_FAILED);
    }
  };

  const saveGist = async () => {
    const id = parseGistRef(gistInput);
    if (!id) return say(false, TEAM_COPY.TEAM_LINK_INVALID);
    try {
      await secureSet(TEAM_OWNER_GIST_SECURE_KEY, id);
      setHasGist(true);
      setGistInput("");
      say(true, "Gist saved.");
    } catch {
      say(false, TEAM_COPY.TEAM_WRITE_FAILED);
    }
  };

  const copySettings = async () => {
    const exported = await exportTeamSettings();
    if (!exported.ok) return say(false, TEAM_COPY[exported.code]);
    try {
      const key = await secureGet(TEAM_OWNER_KEY_SECURE_KEY);
      if (!key) return say(false, TEAM_COPY.TEAM_WRITE_FAILED);
      const blob = await encryptTeamPayload(JSON.stringify(exported.value), key);
      await copy(blob, "Copied. Paste it over the file in your gist.");
    } catch {
      say(false, COPY_FAILED);
    }
  };

  const copyLink = async () => {
    try {
      const [key, gistId] = await Promise.all([
        secureGet(TEAM_OWNER_KEY_SECURE_KEY),
        secureGet(TEAM_OWNER_GIST_SECURE_KEY),
      ]);
      if (!key || !gistId) return;
      await copy(buildTeamLink({ gistId, key }), "Team link copied.");
    } catch {
      say(false, COPY_FAILED);
    }
  };

  return (
    <div id="team" className="space-y-3">
      <Header
        title="Team settings"
        description="Use the AI, speech, Notion and Google settings your team shares"
        isMainTitle
      />

      <p className="text-sm">
        {state?.joined ? "Using your team's settings" : "Not using team settings"}
      </p>
      <TeamJoinBox />
      <div className="flex gap-2">
        {state?.joined && (
          <Button variant="outline" onClick={() => send({ type: "leave" })}>
            Leave team
          </Button>
        )}
        {state?.googleNeedsConnect && (
          <Button variant="outline" onClick={() => send({ type: "connect-google" })}>
            Reconnect Google
          </Button>
        )}
      </div>
      {state?.error && <p className="text-xs text-red-600">{TEAM_COPY[state.error]}</p>}

      <details className="rounded-md border border-input/50 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Share your settings with your team
        </summary>
        <div className="mt-3 space-y-3">
          {!hasKey && <Button onClick={createKey}>Create team key</Button>}

          <div className="space-y-1">
            <Label htmlFor="team-gist">Gist link</Label>
            <div className="flex gap-2">
              <Input
                id="team-gist"
                value={gistInput}
                onChange={(e) => setGistInput(e.target.value)}
              />
              <Button onClick={saveGist}>Save gist</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Create a secret gist at gist.github.com and paste its link here
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!hasKey} onClick={copySettings}>
              Copy team settings
            </Button>
            <Button variant="outline" disabled={!hasKey || !hasGist} onClick={copyLink}>
              Copy team link
            </Button>
            <Button variant="outline" onClick={() => send({ type: "check-owner-link" })}>
              Check team link
            </Button>
          </div>

          {note && (
            <p className={`text-xs ${note.ok ? "text-muted-foreground" : "text-red-600"}`}>
              {note.text}
            </p>
          )}
          {state?.check && (
            <p className="text-xs">
              {state.check.ok ? "Team link works." : TEAM_COPY[state.check.code]}
            </p>
          )}
        </div>
      </details>
    </div>
  );
};
