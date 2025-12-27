import { UseCompletionReturn } from "@/types";
import { Button, ScrollArea } from "@/components";
import { TrashIcon, UsersIcon, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useApp } from "@/contexts";

interface MeetingTranscriptPanelProps {
  meetingTranscript: UseCompletionReturn["meetingTranscript"];
  clearMeetingTranscript: UseCompletionReturn["clearMeetingTranscript"];
}

export const MeetingTranscriptPanel = ({
  meetingTranscript,
  clearMeetingTranscript,
}: MeetingTranscriptPanelProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { sttTranslationEnabled } = useApp();

  // Auto-scroll to bottom when new transcripts are added
  useEffect(() => {
    if (scrollRef.current) {
      const scrollElement = scrollRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (scrollElement) {
        scrollElement.scrollTo({
          top: scrollElement.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [meetingTranscript]);

  if (meetingTranscript.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <UsersIcon className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-sm font-medium">Meeting Assist Mode</p>
        <p className="text-xs mt-1 text-center max-w-[200px]">
          Start speaking to capture meeting audio. Use Quick Actions to get AI insights.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <UsersIcon className="h-4 w-4 text-primary" />
          <h3 className="font-semibold text-xs select-none">
            Meeting Transcript
          </h3>
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {meetingTranscript.length} segment{meetingTranscript.length !== 1 ? "s" : ""}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={clearMeetingTranscript}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
        >
          <TrashIcon className="h-3.5 w-3.5 mr-1" />
          Clear
        </Button>
      </div>

      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <div className="p-4 space-y-3">
          {meetingTranscript.map((entry, index) => (
            <div
              key={entry.timestamp}
              className="p-3 rounded-lg bg-muted/50 text-sm border-l-2 border-primary/30"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-muted-foreground font-medium">
                  #{index + 1}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {/* Original text */}
              <p className="text-foreground">{entry.original}</p>

              {/* Translation section */}
              {sttTranslationEnabled && (
                <div className="mt-2 pt-2 border-t border-muted">
                  {entry.translation ? (
                    <p className="text-foreground/80 italic" dir="auto">
                      {entry.translation}
                    </p>
                  ) : entry.translationError ? (
                    <p className="text-destructive/70 text-xs">
                      Translation unavailable
                    </p>
                  ) : (
                    <div className="flex items-center gap-1 text-muted-foreground text-xs">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Translating...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};
