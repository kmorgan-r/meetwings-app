import {
  Badge,
  Card,
  Empty,
  Button,
  Input,
  Markdown,
  Textarea,
  GetLicense,
} from "@/components";
import { getConversationById } from "@/lib";
import { renameConversationManually } from "@/lib/database/chat-history.action";
import { CONVERSATION_RENAMED_KEY } from "@/lib/chat-constants";
import { safeLocalStorage } from "@/lib/storage/helper";
import { ChatConversation } from "@/types";
import {
  Download,
  MessageCircleIcon,
  MessageCircleReplyIcon,
  Trash2,
  SparklesIcon,
  UserIcon,
  UsersIcon,
  SendIcon,
  Check,
  XIcon,
  PencilIcon,
  Loader2,
} from "lucide-react";
import { useState, useEffect } from "react";
import moment from "moment";
import { useParams, useNavigate } from "react-router-dom";
import { PageLayout } from "@/layouts";
import { useHistory, useChatCompletion } from "@/hooks";
import { useApp } from "@/contexts";
import {
  DeleteConfirmationDialog,
  ChatAudio,
  ChatScreenshot,
  ChatFiles,
  AudioRecorder,
} from ".";

const View = () => {
  const { conversationId } = useParams();
  const { hasActiveLicense } = useApp();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatConversation | null>(null);

  const {
    handleDeleteConfirm,
    confirmDelete,
    cancelDelete,
    deleteConfirm,
    handleAttachToOverlay,
    handleDownload,
    isDownloaded,
    isAttached,
  } = useHistory();

  const completion = useChatCompletion(
    conversationId as string,
    messages,
    setMessages
  );

  useEffect(() => {
    // `ignore` because this read has no cancellation of its own: switching
    // conversations fast, or renaming right after navigating in, can let this
    // resolve AFTER a title patch from the listener below and overwrite it
    // with the stale row this effect started reading.
    let ignore = false;
    const getMessages = async () => {
      const conversation = await getConversationById(conversationId as string);
      if (!ignore) setMessages(conversation || null);
    };
    getMessages();
    return () => {
      ignore = true;
    };
  }, [conversationId]);

  // `[]`-deped with a functional, id-checked updater - NOT `[messages]`.
  // `setMessages` is shared with `useChatCompletion` above, which appends to
  // it during a live completion, so a `[messages]` dependency would re-register
  // this listener on every streamed chunk; and a `[]`-deped listener that wrote
  // `{ ...messages, title }` from a closure over the mount-time `messages`
  // would clobber everything appended since mount. Reading `prev` inside the
  // updater sidesteps both.
  useEffect(() => {
    const handleTitleUpdated = (event: Event) => {
      const { id, title } = (event as CustomEvent).detail || {};
      if (!id || typeof title !== "string") return;
      setMessages((prev) => (prev && prev.id === id ? { ...prev, title } : prev));
    };

    window.addEventListener("conversation-title-updated", handleTitleUpdated);
    return () =>
      window.removeEventListener("conversation-title-updated", handleTitleUpdated);
  }, []);

  useEffect(() => {
    // Scroll to bottom when messages load
    if (messages?.messages.length) {
      setTimeout(() => {
        completion.messagesEndRef.current?.scrollIntoView({
          behavior: "smooth",
        });
      }, 100);
    }
  }, [messages?.messages.length]);

  const handleDelete = async () => {
    await confirmDelete();
    navigate(-1);
  };

  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Guards re-entrancy: the editor stays open across the write, so Enter and
  // the tick button could otherwise both fire again mid-flight.
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const startRenamingTitle = () => {
    setTitleDraft(messages?.title ?? "");
    setTitleError(null);
    setIsRenamingTitle(true);
  };

  const cancelRenamingTitle = () => {
    setTitleError(null);
    setIsRenamingTitle(false);
  };

  const handleCommitTitleRename = async () => {
    if (savingTitle) return;
    const id = conversationId;
    if (!id) return;

    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleError("A conversation needs a name.");
      return;
    }

    // `false` means no row matched (deleted meanwhile) - do not announce a
    // rename that did not happen. `renameConversationManually` RETHROWS a
    // database error rather than returning false, and this runs from a
    // keydown/click handler, so without the catch a refused write is an
    // unhandled rejection nobody sees.
    setSavingTitle(true);
    setTitleError(null);
    let renamed = false;
    try {
      renamed = await renameConversationManually(id, trimmed);
    } catch (error) {
      console.error("Failed to rename conversation:", error);
    } finally {
      setSavingTitle(false);
    }
    if (!renamed) {
      // The editor stays open with the typed name still in it - the same
      // contract the meetings page's rows have. Closing over the text is how a
      // save failure reads as "it just does not save".
      setTitleError("That name could not be saved.");
      return;
    }
    setIsRenamingTitle(false);

    // BOTH channels, same pair the list row fires: the in-window event this
    // component's own listener above also consumes, and the localStorage key
    // the overlay webview reads. The timestamp is a nonce so a repeat rename
    // to the same title still produces a `storage` event on the overlay side.
    window.dispatchEvent(
      new CustomEvent("conversation-title-updated", { detail: { id, title: trimmed } })
    );
    safeLocalStorage.setItem(
      CONVERSATION_RENAMED_KEY,
      JSON.stringify({ id, title: trimmed, timestamp: Date.now() })
    );
  };

  return (
    <PageLayout
      isMainTitle={false}
      allowBackButton={true}
      title={messages?.title || ""}
      description={`${messages?.messages.length} messages in this conversation`}
      rightSlot={
        <div className="flex flex-row items-center gap-2">
          {isRenamingTitle ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={titleDraft}
                  disabled={savingTitle}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCommitTitleRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRenamingTitle();
                    }
                  }}
                  className="h-6 lg:h-8 text-[10px] lg:text-sm w-36 lg:w-56"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Save conversation name"
                  title="Save conversation name"
                  disabled={savingTitle}
                  className="size-6 lg:size-8"
                  onClick={() => void handleCommitTitleRename()}
                >
                  <Check className="size-3 lg:size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Cancel rename"
                  title="Cancel rename"
                  disabled={savingTitle}
                  className="size-6 lg:size-8"
                  onClick={cancelRenamingTitle}
                >
                  <XIcon className="size-3 lg:size-4" />
                </Button>
              </div>
              {titleError !== null && (
                <p className="text-[10px] lg:text-xs text-destructive">{titleError}</p>
              )}
            </div>
          ) : (
            <Button
              variant="outline"
              title="Rename conversation"
              aria-label="Rename conversation"
              className="text-[10px] lg:text-sm h-6 lg:h-8"
              onClick={startRenamingTitle}
            >
              Rename <PencilIcon className="size-3 lg:size-4" />
            </Button>
          )}
          <Button
            variant="outline"
            title="Open this conversation in overlay"
            className="text-[10px] lg:text-sm h-6 lg:h-8"
            onClick={() =>
              conversationId && handleAttachToOverlay(conversationId)
            }
            disabled={isAttached}
          >
            {isAttached ? (
              <>
                <Check className="size-3 lg:size-4 text-green-600" />
                Attached
              </>
            ) : (
              <>
                Open in Overlay{" "}
                <MessageCircleReplyIcon className="size-3 lg:size-4" />
              </>
            )}
          </Button>
          <Button
            variant={"outline"}
            title="Download conversation as markdown"
            className="text-[10px] lg:text-sm h-6 lg:h-8"
            onClick={(e) => handleDownload(messages, e)}
            disabled={isDownloaded}
          >
            {isDownloaded ? (
              <>
                <Check className="size-3 lg:size-4 text-green-600" />
                Downloaded
              </>
            ) : (
              <>
                Download <Download className="size-3 lg:size-4" />
              </>
            )}
          </Button>
          <Button
            variant="destructive"
            title="Delete conversation"
            onClick={() =>
              conversationId && handleDeleteConfirm(conversationId)
            }
            className="text-[10px] lg:text-sm h-6 lg:h-8"
          >
            Delete <Trash2 className="size-3 lg:size-4" />
          </Button>
        </div>
      }
    >
      {messages?.messages.length === 0 ? (
        <Empty
          isLoading={false}
          icon={MessageCircleIcon}
          title="No messages found"
          description="Start a new message to get started"
        />
      ) : (
        <div className="flex flex-col gap-4 pb-24 px-2">
          {messages?.messages.map((message, index, array) => {
            // Meeting segments are all role:"user" — the microphone is you,
            // system audio is whoever else was on the call. Without splitting
            // on audioSource a saved meeting reads as one person talking to
            // themselves.
            const isGuest = message.audioSource === "system";
            const isUser = message.role === "user" && !isGuest;
            const speakerLabel =
              message.speaker?.speakerLabel ?? (isGuest ? "Guest" : undefined);
            const showDate =
              index === 0 ||
              moment(message.timestamp).format("YYYY-MM-DD") !==
                moment(array[index - 1]?.timestamp).format("YYYY-MM-DD");

            return (
              <div key={message.id}>
                {/* Date separator */}
                {showDate && (
                  <Badge
                    variant={"outline"}
                    className="flex items-center justify-center my-4 w-fit mx-auto"
                  >
                    {moment(message.timestamp).format("ddd, MMM D")}
                  </Badge>
                )}

                {/* Message */}
                <div
                  className={`flex gap-3 ${
                    isUser ? "justify-end" : "justify-start"
                  }`}
                >
                  {/* Avatar - Left side for the AI and for other speakers */}
                  {!isUser && (
                    <div className="flex-shrink-0">
                      <div
                        className={`size-7 lg:size-8 rounded-full flex items-center justify-center ${
                          isGuest ? "bg-muted" : "bg-primary/10"
                        }`}
                      >
                        {isGuest ? (
                          <UsersIcon className="size-3 lg:size-4 text-muted-foreground" />
                        ) : (
                          <SparklesIcon className="size-3 lg:size-4 text-primary" />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Message content */}
                  <div
                    className={`flex flex-col gap-1 max-w-[70%] ${
                      isUser ? "items-end" : "items-start"
                    }`}
                  >
                    {speakerLabel && (
                      <span className="text-[10px] lg:text-xs font-medium text-muted-foreground px-1">
                        {speakerLabel}
                      </span>
                    )}
                    <Card
                      className={`px-4 text-xs lg:text-sm py-0 transition-all select-none shadow-none ${
                        isUser
                          ? "!bg-primary text-primary-foreground !border-primary rounded-tr-sm"
                          : "!bg-muted/50 dark:!bg-muted/30 rounded-tl-sm"
                      }`}
                    >
                      <Markdown>{message.content}</Markdown>
                    </Card>
                    <Badge
                      variant="outline"
                      className={`text-[10px] lg:text-xs bg-transparent border-none ${
                        isUser ? "-mr-1" : "-ml-1"
                      }`}
                    >
                      {moment(message.timestamp).format("hh:mm A")}
                    </Badge>
                  </div>

                  {/* Avatar - Right side for user */}
                  {isUser && (
                    <div className="flex-shrink-0">
                      <div className="size-7 lg:size-8 rounded-full bg-primary flex items-center justify-center">
                        <UserIcon className="size-3 lg:size-4 text-primary-foreground" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={completion.messagesEndRef} />
        </div>
      )}

      {/* Sticky Footer Input */}
      <div className="absolute bottom-0 left-0 right-0 bg-background/10 backdrop-blur">
        {completion.error && (
          <div className="px-4 pt-3 pb-0">
            <div className="p-2 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
              <strong>Error:</strong> {completion.error}
            </div>
          </div>
        )}

        <div className="relative flex items-start gap-2 p-4">
          {!hasActiveLicense && (
            <div className="select-none p-5 z-100 bg-primary/5 border border-primary/20 rounded-xl absolute top-4 left-4 right-4">
              <div className="max-w-sm mx-auto">
                <p className="text-sm font-medium text-center">
                  You need an active license to use this feature.
                </p>

                <GetLicense
                  buttonText="Get License"
                  buttonClassName="w-full mt-2"
                />
              </div>
            </div>
          )}
          <div className="flex-1 relative">
            {completion.isRecording ? (
              <AudioRecorder
                onTranscriptionComplete={(text) => {
                  completion.setIsRecording(false);
                  completion.submit(text);
                }}
                onCancel={() => completion.setIsRecording(false)}
              />
            ) : (
              <>
                <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
                  <ChatFiles
                    attachedFiles={completion.attachedFiles}
                    handleFileSelect={completion.handleFileSelect}
                    removeFile={completion.removeFile}
                    onRemoveAllFiles={completion.onRemoveAllFiles}
                    isLoading={completion.isLoading}
                    isFilesPopoverOpen={completion.isFilesPopoverOpen}
                    setIsFilesPopoverOpen={completion.setIsFilesPopoverOpen}
                    disabled={!hasActiveLicense}
                  />
                  <ChatAudio
                    micOpen={completion.micOpen}
                    setMicOpen={completion.setMicOpen}
                    isRecording={completion.isRecording}
                    setIsRecording={completion.setIsRecording}
                    disabled={!hasActiveLicense}
                  />
                  <ChatScreenshot
                    screenshotConfiguration={completion.screenshotConfiguration}
                    attachedFiles={completion.attachedFiles}
                    isLoading={completion.isLoading}
                    captureScreenshot={completion.captureScreenshot}
                    isScreenshotLoading={completion.isScreenshotLoading}
                    disabled={!hasActiveLicense}
                  />
                </div>

                <Textarea
                  ref={completion.inputRef}
                  placeholder="Type a message..."
                  className="pr-12 pl-2 resize-none pb-12 pt-3"
                  rows={2}
                  value={completion.input}
                  onChange={(e) => completion.setInput(e.target.value)}
                  onKeyDown={completion.handleKeyPress}
                  onPaste={completion.handlePaste}
                  disabled={completion.isLoading || !hasActiveLicense}
                />
                <Button
                  size="icon"
                  className="size-7 lg:size-9 rounded-lg lg:rounded-xl absolute right-2 bottom-2"
                  title="Send message"
                  onClick={() => completion.submit()}
                  disabled={
                    completion.isLoading ||
                    !completion.input.trim() ||
                    !hasActiveLicense
                  }
                >
                  {completion.isLoading ? (
                    <Loader2 className="size-3 lg:size-4 animate-spin" />
                  ) : (
                    <SendIcon className="size-3 lg:size-4" />
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        deleteConfirm={deleteConfirm}
        cancelDelete={cancelDelete}
        confirmDelete={handleDelete}
      />
    </PageLayout>
  );
};

export default View;
