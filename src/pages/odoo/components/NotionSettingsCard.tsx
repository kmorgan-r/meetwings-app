import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { Button, Input, Label, Switch } from "@/components";
import { checkNotionSetup, type CheckResult } from "@/lib/notion/check";
import { NOTION_COPY, notionErrorText } from "@/lib/notion/errors";
import {
  clearNotionToken,
  isNotionKeychainAvailable,
  loadNotionToken,
  saveNotionToken,
} from "@/lib/notion/token";
import {
  isNotionAutoSendEnabled,
  loadNotionConfig,
  loadNotionConfigState,
  NOTION_CONFIG_CHANGED_EVENT,
  saveNotionConfig,
  setNotionAutoSendEnabled,
  type NotionConfig,
  type Weekday,
} from "@/lib/storage/notion-config.storage";

const EMPTY: NotionConfig = { meetingsDbUrl: "", knowledgeDbUrl: "", teamTimes: {}, yourName: "" };
const UNREADABLE = "Can't read the saved Notion settings. Enter them again and press Save.";

/** Best-effort, like the Odoo page's notifyOtherWindows: never relabels a save. */
async function notifyOtherWindows(): Promise<void> {
  try {
    await emit(NOTION_CONFIG_CHANGED_EVENT);
  } catch {
    // best-effort
  }
}

/** Never throws: an unreadable state reads as "unknown" (null). */
async function readTokenStored(): Promise<boolean | null> {
  try {
    const state = await loadNotionConfigState();
    return (
      state.state === "complete" ||
      (state.state === "incomplete" && !state.missing.includes("token"))
    );
  } catch {
    return null;
  }
}

const titleCase = (day: string) => day.charAt(0).toUpperCase() + day.slice(1);

export function NotionSettingsCard() {
  const [form, setForm] = useState<NotionConfig>(EMPTY);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenStored, setTokenStored] = useState(false);
  const [keychainAvailable, setKeychainAvailable] = useState(true);
  const [unreadable, setUnreadable] = useState(false);
  const [autoSend, setAutoSend] = useState(isNotionAutoSendEnabled);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available = await isNotionKeychainAvailable();
      let loaded: NotionConfig | null = null;
      let bad = false;
      try {
        loaded = await loadNotionConfig();
      } catch {
        bad = true;
      }
      const stored = await readTokenStored();
      if (stored === null) bad = true;
      if (cancelled) return;
      setKeychainAvailable(available);
      if (loaded) setForm(loaded);
      setUnreadable(bad);
      setTokenStored(stored === true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-read after every save or clear: this read stamps the setup time. */
  async function refreshStored() {
    setTokenStored((await readTokenStored()) === true);
  }

  function edit(patch: Partial<NotionConfig>) {
    setForm((f) => ({ ...f, ...patch }));
    setMessage(null);
    // Only a database link changes what Check saw.
    if ("meetingsDbUrl" in patch || "knowledgeDbUrl" in patch) setResult(null);
  }

  async function handleSaveToken() {
    try {
      await saveNotionToken(tokenInput);
    } catch (thrown) {
      setMessage({ ok: false, text: notionErrorText(thrown).text });
      return;
    }
    setTokenInput("");
    setMessage(null); // the stored line below is the one confirmation
    await refreshStored();
    await notifyOtherWindows();
  }

  async function handleClearToken() {
    try {
      await clearNotionToken();
    } catch (thrown) {
      setMessage({ ok: false, text: notionErrorText(thrown).text });
      return;
    }
    setMessage({ ok: true, text: "Token removed" });
    setResult(null);
    await refreshStored();
    await notifyOtherWindows();
  }

  async function handleSaveConfig() {
    try {
      await saveNotionConfig(form);
    } catch {
      setMessage({ ok: false, text: "Couldn't save the Notion settings." });
      return;
    }
    setUnreadable(false);
    setMessage({ ok: true, text: "Saved" });
    await refreshStored();
    await notifyOtherWindows();
  }

  async function handleCheck() {
    setChecking(true);
    setMessage(null);
    try {
      let token: string | null;
      try {
        token = await loadNotionToken();
      } catch (thrown) {
        setResult({ ok: false, message: notionErrorText(thrown).text });
        return;
      }
      if (token === null) {
        setResult({ ok: false, message: NOTION_COPY.NOTION_NOT_CONFIGURED });
        return;
      }
      setResult(await checkNotionSetup(token, form));
    } finally {
      setChecking(false);
    }
  }

  function setTime(day: Weekday, value: string) {
    setForm((f) => ({ ...f, teamTimes: { ...f.teamTimes, [day]: value } }));
    setMessage(null);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 max-w-md space-y-4" data-testid="notion-card">
      <h2 className="text-sm font-semibold text-foreground">Notion</h2>
      <p className="text-xs text-muted-foreground">
        Send each meeting's notes to your team's Weekly Team Meetings database in Notion.
      </p>
      {unreadable && (
        <p data-testid="notion-unreadable" className="text-sm text-destructive">
          {UNREADABLE}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="notion-token">Notion token</Label>
        <div className="flex gap-2">
          <Input
            id="notion-token"
            type="password"
            autoComplete="off"
            value={tokenInput}
            disabled={!keychainAvailable}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <Button
            type="button"
            disabled={!keychainAvailable || tokenInput.trim() === ""}
            onClick={() => void handleSaveToken()}
          >
            Save token
          </Button>
        </div>
        {!keychainAvailable && (
          <p className="text-xs text-destructive">
            This computer has no system keychain Meetwings can use, so the Notion token can't be saved here.
          </p>
        )}
        {tokenStored && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">Saved in your system keychain</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleClearToken()}>
              Remove token
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notion-meetings-db">Meetings database link</Label>
        <Input
          id="notion-meetings-db"
          value={form.meetingsDbUrl}
          onChange={(e) => edit({ meetingsDbUrl: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notion-knowledge-db">Team Knowledge database link</Label>
        <Input
          id="notion-knowledge-db"
          value={form.knowledgeDbUrl}
          onChange={(e) => edit({ knowledgeDbUrl: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notion-your-name">Your name</Label>
        <Input
          id="notion-your-name"
          value={form.yourName}
          onChange={(e) => edit({ yourName: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Shown as the recorder on each page. Leave empty to use your Notion name.
        </p>
      </div>

      {result?.ok === true && result.weekdays.length > 0 && (
        <div className="space-y-2">
          {result.weekdays.map((day) => (
            <div key={day} className="flex items-center justify-between gap-2">
              <Label htmlFor={`notion-time-${day}`}>{`${titleCase(day)}: usual start time`}</Label>
              <input
                id={`notion-time-${day}`}
                type="time"
                value={form.teamTimes[day] ?? ""}
                onChange={(e) => setTime(day, e.target.value)}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Meetings starting within 30 minutes of that time go to that day's table. Empty means any time.
          </p>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <Label htmlFor="notion-auto-send">Send meetings to Notion automatically</Label>
        <Switch
          id="notion-auto-send"
          checked={autoSend}
          onCheckedChange={(checked) => {
            setAutoSend(checked);
            setNotionAutoSendEnabled(checked);
            void notifyOtherWindows();
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void handleSaveConfig()}>
          Save settings
        </Button>
        <Button type="button" variant="outline" disabled={checking} onClick={() => void handleCheck()}>
          Check
        </Button>
      </div>

      {message && (
        <p
          data-testid="notion-message"
          className={message.ok ? "text-sm text-green-600 dark:text-green-400" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      )}
      {result?.ok === false && (
        <p data-testid="notion-check-result" className="text-sm text-destructive">
          {result.message}
        </p>
      )}
      {result?.ok === true && (
        <div data-testid="notion-check-result" className="space-y-1 text-sm">
          <p className="text-green-600 dark:text-green-400">{result.mapping}</p>
          <p className="text-muted-foreground">{`Recorded as ${result.recorder}.`}</p>
          {result.warnings.map((w) => (
            <p key={w} className="text-muted-foreground">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
