import { useEffect, useState } from "react";
import { Loader2, MessageSquare, XIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  ScrollArea,
  Input as InputComponent,
  Markdown,
  Switch,
  CopyButton,
} from "@/components";
import { UseCompletionReturn } from "@/types";
import { MessageHistory } from "./MessageHistory";
import { QuickActions } from "./QuickActions";
import { MeetingTranscriptPanel } from "./MeetingTranscriptPanel";
import { ActiveModels } from "./ActiveModels";
import { UseQuickActionsReturn } from "@/hooks/useQuickActions";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";

/** Empty and blurred this long before the Ask box folds. Longer than the
 *  100 ms post-answer re-focus in useCompletion, so that re-focus wins. */
export const ASK_COLLAPSE_DEBOUNCE_MS = 300;

interface InputProps extends UseCompletionReturn {
  isHidden: boolean;
  askExpanded: boolean;
  onAskExpand: () => void;
  onAskCollapse: () => void;
  quickActions?: UseQuickActionsReturn;
  onQuickActionClick?: (action: string) => void;
  /** Meetwings Cloud is answering, so its models are not the selected ones */
  cloudMode?: boolean;
}

export const Input = ({
  isPopoverOpen,
  isLoading,
  reset,
  input,
  setInput,
  handleKeyPress,
  handlePaste,
  currentConversationId,
  conversationHistory,
  startNewConversation,
  messageHistoryOpen,
  setMessageHistoryOpen,
  error,
  response,
  setResponse,
  cancel,
  scrollAreaRef,
  inputRef,
  attachInput,
  isHidden,
  askExpanded,
  onAskExpand,
  onAskCollapse,
  isContactPickerOpen,
  isFilesPopoverOpen,
  keepEngaged,
  setKeepEngaged,
  setMeetingPanelHidden,
  meetingTranscriptHidden,
  setMeetingTranscriptHidden,
  enableVAD,
  quickActions,
  onQuickActionClick,
  meetingAssistMode,
  meetingTranscript,
  currentMeetingTranscript,
  clearMeetingTranscript,
  assignSpeaker,
  respondedModel,
  cloudMode = false,
}: InputProps) => {
  const { sttTranslationEnabled } = useApp();
  const [focused, setFocused] = useState(false);

  // Fold back to the icon once the box is empty, unfocused and idle. The
  // re-check at fire time lets a re-focus that landed meanwhile win.
  useEffect(() => {
    if (
      !askExpanded ||
      input ||
      focused ||
      isLoading ||
      messageHistoryOpen ||
      isContactPickerOpen ||
      isFilesPopoverOpen
    ) {
      return;
    }
    const t = setTimeout(() => {
      if (document.activeElement !== inputRef.current) onAskCollapse();
    }, ASK_COLLAPSE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [
    askExpanded,
    input,
    focused,
    isLoading,
    messageHistoryOpen,
    isContactPickerOpen,
    isFilesPopoverOpen,
    inputRef,
    onAskCollapse,
  ]);

  // Get the last user message for display when conversation mode is OFF
  const lastUserMessage = conversationHistory
    .filter(msg => msg.role === "user")
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  // Show meeting transcript panel when:
  // - Meeting mode is ON
  // - This conversation has transcripts (hasContent and xHidesPanel below
  //   keep the session-wide length: they guard reset(), which would drop the
  //   conversation)
  // - The stop did not hide them
  // - No AI response yet (once response comes, show normal view)
  // - Conversation mode is OFF (when ON, show conversation history instead)
  const showMeetingPanel =
    meetingAssistMode &&
    currentMeetingTranscript.length > 0 &&
    !meetingTranscriptHidden &&
    !response &&
    !keepEngaged &&
    !isLoading;

  // Check if we have content that should prevent auto-reset
  const hasContent = response !== "" || (meetingAssistMode && meetingTranscript.length > 0);

  // A meeting is in the panel: X only hides it (issue #72). Clearing would
  // start a new conversation and drop the Odoo targets mid-meeting. The
  // transcript panel's own Clear button is the explicit fresh start.
  const xHidesPanel = !isLoading && meetingAssistMode && meetingTranscript.length > 0;

  return (
    <div className={cn("relative", askExpanded && "flex-1")}>
      <Popover
        open={isPopoverOpen}
        onOpenChange={(open) => {
          // Clicking the input brings back a panel the X hid.
          if (open) {
            setMeetingPanelHidden(false);
            setMeetingTranscriptHidden(false);
          }
          // Only reset if popover is closing AND:
          // - Not loading
          // - Not in conversation mode
          // - No response content
          // - No meeting transcript (in meeting mode)
          if (!open && !isLoading && !keepEngaged && !hasContent) {
            reset();
          }
        }}
      >
        <PopoverTrigger asChild className="!border-none !bg-transparent">
          <div className="relative select-none">
            {askExpanded ? (
              <InputComponent
                ref={attachInput}
                autoFocus
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Ask me anything..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                onPaste={handlePaste}
                disabled={isLoading || isHidden}
                className={`${
                  currentConversationId && conversationHistory.length > 0
                    ? "pr-14"
                    : "pr-2"
                }`}
              />
            ) : (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Ask"
                title="Ask"
                className="cursor-pointer"
                onClick={() => {
                  // Same as clicking the box did: bring back a panel the X hid.
                  setMeetingPanelHidden(false);
                  setMeetingTranscriptHidden(false);
                  onAskExpand();
                }}
              >
                <MessageSquare />
              </Button>
            )}

            {/* Conversation thread indicator */}
            {askExpanded &&
              currentConversationId &&
              conversationHistory.length > 0 &&
              !isLoading && (
                <div className="absolute select-none right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  <MessageHistory
                    conversationHistory={conversationHistory}
                    currentConversationId={currentConversationId}
                    onStartNewConversation={startNewConversation}
                    messageHistoryOpen={messageHistoryOpen}
                    setMessageHistoryOpen={setMessageHistoryOpen}
                    quickActions={quickActions}
                    onQuickActionClick={onQuickActionClick}
                    enableVAD={enableVAD}
                    isLoading={isLoading}
                  />
                </div>
              )}

            {/* Loading indicator */}
            {isLoading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 animate-pulse">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </PopoverTrigger>

        {/* Response Panel */}
        <PopoverContent
          align="end"
          side="bottom"
          className="w-screen p-0 border shadow-lg overflow-hidden flex flex-col h-[calc(100vh-4rem)]"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30">
            <div className="flex flex-row gap-2 items-center min-w-0">
              <h3
                className="font-semibold text-xs select-none shrink-0"
                title="Use arrow keys to scroll"
              >
                {keepEngaged ? "Conversation Mode" : "AI Response"}
              </h3>
              <ActiveModels
                respondedModel={respondedModel}
                isLoading={isLoading}
                cloudMode={cloudMode}
                listening={enableVAD}
              />
            </div>
            <div className="flex items-center gap-2 select-none shrink-0">
              <div className="flex flex-row items-center gap-2 mr-2">
                <p className="text-[10px]">{`Toggle ${
                  keepEngaged ? "AI response" : "conversation mode"
                }`}</p>
                <span className="text-[10px] text-muted-foreground/60 bg-muted/30 px-1 py-0 rounded border border-input/50">
                  {navigator.platform.toLowerCase().includes("mac")
                    ? "⌘"
                    : "Ctrl"}{" "}
                  + K
                </span>
                <Switch
                  checked={keepEngaged}
                  onCheckedChange={(checked) => {
                    setKeepEngaged(checked);
                    // Focus input after toggle
                    setTimeout(() => {
                      inputRef?.current?.focus();
                    }, 100);
                  }}
                />
              </div>
              <CopyButton content={response} />
              <Button
                size="icon"
                variant="ghost"
                onClick={async () => {
                  if (isLoading) {
                    cancel();
                  } else if (xHidesPanel) {
                    // Dismiss the answer, but not reset(): that also drops a
                    // half-typed question and its attachments.
                    setResponse("");
                    setMeetingPanelHidden(true);
                  } else if (keepEngaged) {
                    // When keepEngaged is on, close everything and start new conversation.
                    // Awaited in sequence: startNewConversation flushes any unsaved
                    // transcript and clears currentConversationIdRef itself, so by the
                    // time clearMeetingTranscript runs there is nothing left for it to
                    // (redundantly) flush.
                    setKeepEngaged(false);
                    await startNewConversation();
                    // Also clear meeting transcript if in meeting mode
                    if (meetingAssistMode && clearMeetingTranscript) {
                      await clearMeetingTranscript();
                    }
                  } else {
                    reset();
                    // Also clear meeting transcript if in meeting mode
                    if (meetingAssistMode && clearMeetingTranscript) {
                      await clearMeetingTranscript();
                    }
                  }
                }}
                className="cursor-pointer"
                title={
                  isLoading
                    ? "Cancel loading"
                    : xHidesPanel
                    ? "Hide panel"
                    : keepEngaged
                    ? "Close and start new conversation"
                    : "Clear conversation"
                }
              >
                <XIcon />
              </Button>
            </div>
          </div>

          {/* Show Meeting Transcript Panel when in meeting mode without response */}
          {showMeetingPanel ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <MeetingTranscriptPanel
                meetingTranscript={currentMeetingTranscript}
                clearMeetingTranscript={clearMeetingTranscript}
                assignSpeaker={assignSpeaker}
              />
            </div>
          ) : (
            <ScrollArea ref={scrollAreaRef} className="flex-1 min-h-0">
              <div className="p-4">
                {error && (
                  <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
                    <strong>Error:</strong> {error}
                  </div>
                )}
                {isLoading && (
                  <div className="flex items-center gap-2 my-4 text-muted-foreground animate-pulse select-none">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">Generating response...</span>
                  </div>
                )}

                {/* When conversation mode is OFF, show the last user message above the AI response */}
                {!keepEngaged && lastUserMessage && response && (
                  <div className="mb-4 p-3 rounded-lg text-sm bg-primary/10 border-l-4 border-primary">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-medium text-muted-foreground uppercase">You</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(lastUserMessage.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <Markdown>{lastUserMessage.content}</Markdown>
                    {/* Translation display */}
                    {sttTranslationEnabled && lastUserMessage.translation && (
                      <div className="mt-2 pt-2 border-t border-primary/20">
                        <p className="text-foreground/80 italic" dir="auto">
                          {lastUserMessage.translation}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {response && <Markdown>{response}</Markdown>}

                {/* Conversation History - Separate scroll, no auto-scroll */}
                {keepEngaged && conversationHistory.length > 0 && (
                  <div className="space-y-3 pt-3">
                    {/* Copy before sorting: sort reorders in place, and this
                        array is live state that the meeting autosave reads to
                        decide what still needs writing. */}
                    {[...conversationHistory]
                      .sort((a, b) => b?.timestamp - a?.timestamp)
                      .map((message, index) => {
                        // Only skip the first message if it's an assistant response already displayed above
                        // Never skip user messages - they should always be shown
                        if (!isLoading && index === 0 && response && message.role === "assistant") {
                          return null;
                        }
                        return (
                          <div
                            key={message.id}
                            className={`p-3 rounded-lg text-sm ${
                              message.role === "user"
                                ? "bg-primary/10 border-l-4 border-primary"
                                : "bg-muted/50"
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs font-medium text-muted-foreground uppercase">
                                {message.role === "user"
                                  ? (message.speaker?.speakerLabel || "You")
                                  : "AI"}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {new Date(message.timestamp).toLocaleTimeString(
                                  [],
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }
                                )}
                              </span>
                            </div>
                            <Markdown>{message.content}</Markdown>
                            {/* Translation display for user messages */}
                            {sttTranslationEnabled && message.role === "user" && message.translation && (
                              <div className="mt-2 pt-2 border-t border-primary/20">
                                <p className="text-foreground/80 italic" dir="auto">
                                  {message.translation}
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </ScrollArea>
          )}

          {/* Quick Actions - Show at bottom of response panel */}
          {quickActions && onQuickActionClick && (
            <div className="border-t border-input/50 p-3 bg-muted/30 shrink-0">
              <QuickActions
                {...quickActions}
                onActionClick={(action) => {
                  onQuickActionClick(action);
                }}
                disabled={isLoading}
              />
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
};
