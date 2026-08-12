import { useEffect, useMemo, useState } from "react";
import {
  useCompletion,
  useMeetingAutoRecord,
  useMeetingLog,
  useOdooTarget,
  useQuickActions,
  type MeetingAutoRecordAudio,
} from "@/hooks";
import { useApp } from "@/contexts";
import { shouldUseMeetwingsAPI } from "@/lib";
import { Screenshot } from "./Screenshot";
import { Files } from "./Files";
import { Audio } from "./Audio";
import { Input } from "./Input";
import { MeetingAssistToggle } from "./MeetingAssistToggle";
import { ContactPicker } from "./ContactPicker";
import { MeetingLogStrip } from "./MeetingLogStrip";

export const Completion = ({
  isHidden,
  systemAudio,
}: {
  isHidden: boolean;
  systemAudio: MeetingAutoRecordAudio;
}) => {
  const completion = useCompletion();
  const quickActions = useQuickActions();

  // Mounted HERE, not in the app page: it needs enableVAD and meetingAssistMode,
  // which useCompletion owns. See the hook's doc comment.
  useMeetingAutoRecord({
    systemAudio,
    enableVAD: completion.enableVAD,
    setEnableVAD: completion.setEnableVAD,
    meetingAssistMode: completion.meetingAssistMode,
    flushUnsavedMeetingTranscript: completion.flushUnsavedMeetingTranscript,
  });

  // Mounted HERE, beside useMeetingAutoRecord, because slice 2's useMeetingLog
  // reads targetRef from the same component.
  //
  // isContactPickerOpen/setIsContactPickerOpen come from useCompletion, not
  // from this hook - they are threaded through so useCompletion's resize
  // effect can see the picker open, exactly like isFilesPopoverOpen already
  // does for Files.tsx. The main window is 600x54 and non-resizable; without
  // this the popover has no way to make the window grow around it.
  const odoo = useOdooTarget({
    meetingAssistMode: completion.meetingAssistMode,
    isPickerOpen: completion.isContactPickerOpen,
    setIsPickerOpen: completion.setIsContactPickerOpen,
  });

  // The AI provider, built exactly as useCompletion.ts:1313-1324 does it.
  //
  // NOT optional in practice: fetchAIResponse needs { provider,
  // selectedProvider }, and generateMeetingLogSummary returns null without one
  // whenever the Meetwings API is off - so every BYO-provider user would get
  // the "Summarization failed" fallback body on EVERY meeting, silently.
  // `useApp` here is the CONTEXT one, not the unrelated hook of the same name
  // in @/hooks (which instantiates useSystemAudio and useTitles).
  const { allAiProviders, selectedAIProvider, meetwingsApiEnabled } = useApp();
  const [useMeetwingsAPI, setUseMeetwingsAPI] = useState(false);
  // Keyed on the context flag, not `[]`. Every other caller in this repo
  // re-reads shouldUseMeetwingsAPI per use (useCompletion.ts:910, :1089,
  // :1314) because the dashboard window can flip it mid-session; frozen at
  // mount, a user who turns the Meetwings API off would get `providerConfig`
  // stuck at undefined and the "Summarization failed" body on every meeting
  // thereafter.
  useEffect(() => {
    void shouldUseMeetwingsAPI().then(setUseMeetwingsAPI);
  }, [meetwingsApiEnabled]);
  const providerConfig = useMemo(() => {
    if (useMeetwingsAPI) return undefined;
    const provider = allAiProviders.find((p) => p.id === selectedAIProvider.provider);
    return provider ? { provider, selectedProvider: selectedAIProvider } : undefined;
  }, [useMeetwingsAPI, allAiProviders, selectedAIProvider]);

  // Slice 2. Mounted beside useOdooTarget because it reads the SAME targetRef,
  // and beside useMeetingAutoRecord because it owns the other half of the
  // meeting lifecycle. It registers its own meeting-ended listener rather than
  // hooking handleStop - see the hook's doc comment.
  const meetingLog = useMeetingLog({
    targetRef: odoo.targetRef,
    meetingTranscript: completion.meetingTranscript,
    currentConversationId: completion.currentConversationId,
    meetingAssistMode: completion.meetingAssistMode,
    providerConfig,
  });

  // The picker's popover is CONTROLLED by useCompletion's isContactPickerOpen,
  // and Radix does not fire onOpenChange when the tree unmounts. Swapping the
  // trigger out while the popover is open would therefore strand that flag at
  // `true`: useCompletion's resize effect would expand the 54px bar to 600px
  // with nothing in it on its next dep change, and when the hold ends and
  // <ContactPicker> remounts with open={true} the popover would spring open
  // unbidden. Closing it as the hold begins is the whole fix.
  useEffect(() => {
    if (meetingLog.holding) completion.setIsContactPickerOpen(false);
  }, [meetingLog.holding, completion.setIsContactPickerOpen]);

  // Use meeting-aware quick action handler when in Meeting Assist Mode
  const handleQuickAction = (action: string) => {
    if (completion.meetingAssistMode) {
      // In Meeting Assist Mode, use the context-aware submit
      completion.submitWithMeetingContext(action);
    } else {
      // Normal mode: just submit the action
      completion.submit(action);
    }
  };

  return (
    <>
      <MeetingAssistToggle
        meetingAssistMode={completion.meetingAssistMode}
        setMeetingAssistMode={completion.setMeetingAssistMode}
        meetingTranscript={completion.meetingTranscript}
      />
      {meetingLog.holding || meetingLog.undoBlockedMessage ? (
        <MeetingLogStrip
          holding={meetingLog.holding}
          contactName={odoo.pickerProps.contactName}
          onUndo={meetingLog.onUndo}
          undoBlockedMessage={meetingLog.undoBlockedMessage}
        />
      ) : (
        <ContactPicker {...odoo.pickerProps} />
      )}
      <Audio {...completion} />
      <Input
        {...completion}
        isHidden={isHidden}
        quickActions={quickActions}
        onQuickActionClick={handleQuickAction}
      />
      <Screenshot {...completion} />
      <Files {...completion} />
    </>
  );
};
