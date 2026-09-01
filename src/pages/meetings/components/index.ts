// The two retired pages' barrels, merged by hand: `git mv` can move a file but
// not fold two `index.ts` into one path.
//
// `View.tsx` is what this barrel exists for - it imports its five siblings from
// "." and would otherwise need five leaf paths. Nothing else should reach for
// it: View pulls in `@/hooks`, whose barrel star-exports useCompletion and
// useSystemAudio, so importing this file drags that whole graph in. The
// meetings page imports the three queue components by their LEAF paths for
// exactly that reason.
export * from "./ChatAudio";
export * from "./ChatScreenshot";
export * from "./ChatFiles";
export * from "./AudioRecorder";
export * from "./DeleteConfirmation";
export * from "./View";
export { QueueRow } from "./QueueRow";
export { ProviderConfigReader } from "./ProviderConfigReader";
export { AssignDialog, type AssignPayload } from "./AssignDialog";
