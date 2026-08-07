import {
  useCompletion,
  useMeetingAutoRecord,
  useOdooTarget,
  useQuickActions,
  type MeetingAutoRecordAudio,
} from "@/hooks";
import { Screenshot } from "./Screenshot";
import { Files } from "./Files";
import { Audio } from "./Audio";
import { Input } from "./Input";
import { MeetingAssistToggle } from "./MeetingAssistToggle";
import { ContactPicker } from "./ContactPicker";

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
      <ContactPicker {...odoo.pickerProps} />
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
