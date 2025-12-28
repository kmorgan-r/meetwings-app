import { useState, useEffect } from "react";
import { Header } from "@/components";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { InfoIcon, UsersIcon, DollarSignIcon } from "lucide-react";
import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "@/lib";

export function DiarizationSettings() {
  const [diarizationEnabled, setDiarizationEnabled] = useState(() => {
    return safeLocalStorage.getItem(STORAGE_KEYS.SPEAKER_DIARIZATION_ENABLED) === "true";
  });

  useEffect(() => {
    safeLocalStorage.setItem(
      STORAGE_KEYS.SPEAKER_DIARIZATION_ENABLED,
      String(diarizationEnabled)
    );
  }, [diarizationEnabled]);

  return (
    <div className="space-y-4">
      <Header
        title="Speaker Diarization"
        description="Automatically identify who is speaking in your meetings."
      />

      <div className="p-4 border rounded-lg space-y-4">
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="diarization-toggle" className="font-medium">
              Enable Speaker Diarization
            </Label>
            <p className="text-xs text-muted-foreground">
              Identify different speakers in meeting transcripts
            </p>
          </div>
          <Switch
            id="diarization-toggle"
            checked={diarizationEnabled}
            onCheckedChange={setDiarizationEnabled}
          />
        </div>

        {diarizationEnabled && (
          <>
            <div className="h-px bg-border" />

            {/* Requirements Info */}
            <div className="space-y-2">
              <div className="flex items-start gap-2 text-xs">
                <InfoIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium">Requirements</p>
                  <p className="text-muted-foreground">
                    Speaker diarization requires AssemblyAI as your STT provider.
                    Select "AssemblyAI (with Speaker Diarization)" in STT Providers above.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2 text-xs">
                <DollarSignIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium">Pricing</p>
                  <p className="text-muted-foreground">
                    AssemblyAI Universal with Speaker Labels: $0.17/hr ($0.00283/min)
                  </p>
                  <p className="text-muted-foreground">
                    This includes the base transcription + speaker diarization addon.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2 text-xs">
                <UsersIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium">How it works</p>
                  <ul className="text-muted-foreground space-y-0.5 list-disc list-inside">
                    <li>Speakers are labeled as A, B, C, etc.</li>
                    <li>Click on speaker labels to assign names</li>
                    <li>Assignments persist throughout the session</li>
                    <li>Enroll voices below for automatic matching</li>
                  </ul>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
