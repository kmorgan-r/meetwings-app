import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useTeamState } from "@/hooks/useTeamState";
import { TEAM_COPY } from "@/lib/team/team-file";
import { parseTeamLink } from "@/lib/team/team-link";

/** Paste box for when a meetwings:// link is not clickable. */
export const TeamJoinBox = () => {
  const [, send] = useTeamState();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  const join = () => {
    if (!parseTeamLink(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    send({ type: "join", link: value.trim() });
    setValue("");
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label="Team link"
          placeholder="Paste your team link (meetwings://team/...)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button onClick={join}>Join</Button>
      </div>
      {invalid && <p className="text-xs text-red-600">{TEAM_COPY.TEAM_LINK_INVALID}</p>}
    </div>
  );
};
