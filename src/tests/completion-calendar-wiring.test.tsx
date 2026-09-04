import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Task 15 fix round 1: pins the wiring `<Completion />` itself performs at
// mount - the useCalendarProposal call site, the calendarProps memo, and the
// `calendar` prop reaching ContactPicker. None of that is visible from
// odoo-contact-picker.test.tsx's two calendar tests (they render ContactPicker
// directly, never index.tsx), and settings-page.meeting-auto-record.test.tsx
// deliberately forces `present: false` in its own useCalendarProposal stub to
// keep this feature out of its unrelated assertions. A mutant deleting
// `calendar={calendarProps}` from the ContactPicker call site, or deleting the
// useCalendarProposal mount entirely, left the full suite green before this
// file existed.
//
// A NEW file, not an addition to odoo-contact-picker.test.tsx: that file
// imports the real ContactPicker at module scope, which fights the
// vi.resetModules()/vi.doMock pattern this test needs to swap `@/hooks` out
// from under `<Completion />`.
//
// ContactPicker itself is STUBBED, not rendered for real. `props -> DOM` is
// already pinned by odoo-contact-picker.test.tsx's "calendar proposal slot"
// tests; this file only has to prove `hook -> props`, and stubbing
// ContactPicker (rather than re-rendering the real one, with Radix and all)
// is what keeps the two files from re-covering each other's ground.
describe("<Completion /> wires useCalendarProposal into ContactPicker", () => {
  it("passes the live cache and the setter through, and keeps the memoized calendar prop stable across a rerender", async () => {
    vi.resetModules(); // or the cached module ignores the factories below

    const systemAudio = { capturing: false };
    const setCalendarBlockPresent = vi.fn();
    const contactsArray = [{ id: 1, name: "Ada Lovelace" }];
    const pickerSpy = vi.fn();

    // useCalendarProposal must return the SAME state/onPickCandidate/onRetry
    // references on every call for the rerender assertion at the bottom of
    // this test to mean anything: if it didn't, `calendarProps` would
    // recompute even with a perfectly correct memo, and the assertion would
    // fail for a reason that has nothing to do with the memo under test. That
    // stability is what "module-scope constant" buys here - these are
    // declared once, never reassigned, and closed over by the mock below.
    const calendarState = { kind: "no-meeting" as const };
    const onPickCandidate = vi.fn();
    const onRetry = vi.fn();
    const useCalendarProposal = vi.fn(() => ({
      present: true,
      state: calendarState,
      onPickCandidate,
      onRetry,
    }));

    // Mock @/hooks wholesale - the real useCompletion reaches for the app
    // context and the whole audio stack, same reasoning as
    // settings-page.meeting-auto-record.test.tsx's F34 block, which this
    // harness is copied from.
    vi.doMock("@/hooks", () => ({
      useCompletion: () => ({
        enableVAD: false,
        setEnableVAD: vi.fn(),
        meetingAssistMode: false,
        meetingTranscript: [],
        currentConversationId: null,
        setMeetingAssistMode: vi.fn(),
        submit: vi.fn(),
        submitWithMeetingContext: vi.fn(),
        flushUnsavedMeetingTranscript: vi.fn(),
        isContactPickerOpen: true,
        setIsContactPickerOpen: vi.fn(),
        setTargetCount: vi.fn(),
        setCalendarBlockPresent,
      }),
      useQuickActions: () => ({}),
      useMeetingAutoRecord: vi.fn(),
      useOdooTarget: () => ({
        targetRef: { current: null },
        targetsRef: { current: [] },
        pickerProps: {
          contactId: null,
          leadId: null,
          contactName: null,
          // "ready" with a real array, not "never-synced": the discriminating
          // assertion below needs a live `contacts` reference to prove
          // index.tsx actually threads THIS array through, not a hardcoded
          // null.
          cache: { kind: "ready", contacts: contactsArray, lastError: null },
          opportunities: null,
          opportunityError: null,
          isLookingUp: false,
          onSelect: vi.fn(),
          onSelectOpportunity: vi.fn(),
          onToggleColleague: vi.fn(),
          onRetryOpportunities: vi.fn(),
          onRefresh: vi.fn(),
          onOpenSettings: vi.fn(),
          targets: [],
          onAddTarget: vi.fn(),
          onRemoveTarget: vi.fn(),
          onExpandContact: vi.fn(),
          opportunitiesFor: vi.fn(() => null),
          errorFor: vi.fn(() => null),
          onRetryContactOpportunities: vi.fn(),
          open: false,
          onOpenChange: vi.fn(),
        },
      }),
      useCalendarProposal,
      useMeetingLog: () => ({
        holding: false,
        onUndo: vi.fn(),
        undoBlockedMessage: null,
      }),
    }));
    vi.doMock("@/contexts", () => ({
      useApp: () => ({
        customizable: { cursor: { type: "default" } },
        allAiProviders: [{ id: "openai" }],
        selectedAIProvider: { provider: "openai", variables: {} },
      }),
    }));
    vi.doMock("@/lib", () => ({
      getPlatform: () => "windows",
      shouldUseMeetwingsAPI: vi.fn(async () => false),
    }));
    // ABSOLUTE specifiers: vi.doMock resolves relative to THIS file, so a
    // relative "./Audio" would be a silent no-op and pull in the real
    // component (settings-page.meeting-auto-record.test.tsx's own comment on
    // this, verbatim reasoning).
    vi.doMock("@/pages/app/components/completion/Audio", () => ({
      Audio: () => null,
    }));
    vi.doMock("@/pages/app/components/completion/Input", () => ({
      Input: () => null,
    }));
    vi.doMock("@/pages/app/components/completion/Screenshot", () => ({
      Screenshot: () => null,
    }));
    vi.doMock("@/pages/app/components/completion/Files", () => ({
      Files: () => null,
    }));
    vi.doMock("@/pages/app/components/completion/MeetingAssistToggle", () => ({
      MeetingAssistToggle: () => null,
    }));
    // The one component under test is stubbed rather than mocked away like
    // the others above: capturing its props IS the assertion.
    vi.doMock("@/pages/app/components/completion/ContactPicker", () => ({
      ContactPicker: (p: any) => {
        pickerSpy(p);
        return null;
      },
    }));
    // MeetingLogStrip (unmocked - `meetingLog.holding` is false above, so it
    // never renders, and its own module needs no behavioural stub) still
    // imports Button from "@/components" at module scope, and that barrel
    // re-exports the real Markdown/shiki stack, which stalls indefinitely in
    // this test environment with no network access. Same reasoning as
    // settings-page.meeting-auto-record.test.tsx's own "@/components" mock -
    // required here for MeetingLogStrip's sake even though ContactPicker
    // itself no longer needs it.
    vi.doMock("@/components", () => ({
      Popover: ({ children }: any) => <>{children}</>,
      PopoverTrigger: ({ children }: any) => <>{children}</>,
      PopoverContent: ({ children }: any) => <>{children}</>,
      Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
      Input: (props: any) => <input {...props} />,
    }));

    const { Completion } = await import("@/pages/app/components/completion");
    const { rerender } = render(
      <Completion isHidden={false} systemAudio={systemAudio as any} />
    );

    expect(useCalendarProposal).toHaveBeenCalled();
    const args = useCalendarProposal.mock.calls[0][0];
    // Kills a mutant hardcoding `contacts: null` at index.tsx:64-65, which
    // today silently disables the feature for every user with a ready cache -
    // full suite green.
    expect(args.contacts).toBe(contactsArray);
    expect(args.setCalendarBlockPresent).toBe(setCalendarBlockPresent);
    expect(args.isPickerOpen).toBe(true);

    // Kills deletion of `calendar={calendarProps}` at the ContactPicker call
    // site, and deletion of the useCalendarProposal mount itself - either
    // leaves `calendar` undefined, and `.state` has nothing to read.
    expect(pickerSpy).toHaveBeenCalled();
    expect(pickerSpy.mock.calls[0][0].calendar.state).toBe(calendarState);

    // Same calendarProps identity is what keeps ContactPicker's memo intact
    // across this rerender - see the useMemo comment at
    // completion/index.tsx:88. This only proves memoization because
    // useCalendarProposal above returns the SAME state/onPickCandidate/onRetry
    // references on every call (declared once, above, never reassigned) - a
    // change to that mock would produce a false failure here that reads like
    // a real regression. First-vs-last, not first-vs-second: an unrelated
    // effect (e.g. the async shouldUseMeetwingsAPI probe resolving) could add
    // extra renders between them without invalidating the memo.
    rerender(<Completion isHidden={false} systemAudio={systemAudio as any} />);
    const calls = pickerSpy.mock.calls;
    expect(calls[calls.length - 1][0].calendar).toBe(calls[0][0].calendar);
  });
});
