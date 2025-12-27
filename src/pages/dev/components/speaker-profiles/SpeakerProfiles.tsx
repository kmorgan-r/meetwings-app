import { useState, useRef, useEffect } from "react";
import { Button, Header } from "@/components";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  MicIcon,
  StopCircleIcon,
  TrashIcon,
  UserIcon,
  PlusIcon,
} from "lucide-react";
import {
  saveSpeakerProfile,
  deleteSpeakerProfile,
  saveAudioSample,
  getUserProfile,
  getOtherProfiles,
  createSpeakerProfile,
  SpeakerProfile,
} from "@/lib/storage/speaker-profiles.storage";

const ENROLLMENT_DURATION = 30; // seconds

export function SpeakerProfiles() {
  const [profiles, setProfiles] = useState<SpeakerProfile[]>([]);
  const [userProfile, setUserProfile] = useState<SpeakerProfile | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [recordingFor, setRecordingFor] = useState<"user" | string | null>(null);
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileType, setNewProfileType] = useState<"colleague" | "client" | "other">("colleague");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  async function loadProfiles() {
    const user = await getUserProfile();
    const others = await getOtherProfiles();
    setUserProfile(user || null);
    setProfiles(others);
  }

  async function startRecording(forProfile: "user" | string) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        await handleRecordingComplete(forProfile, audioBlob);
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
      setRecordingFor(forProfile);
      setRecordingProgress(0);

      // Progress timer
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        setRecordingProgress(Math.min(elapsed / ENROLLMENT_DURATION, 1));

        if (elapsed >= ENROLLMENT_DURATION) {
          stopRecording();
        }
      }, 100);
    } catch (error) {
      console.error("Failed to start recording:", error);
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  async function handleRecordingComplete(
    forProfile: "user" | string,
    audioBlob: Blob
  ) {
    // Convert to base64
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;

      if (forProfile === "user") {
        // Create or update user profile
        const profile: SpeakerProfile = {
          id: userProfile?.id || crypto.randomUUID(),
          name: "You",
          type: "user",
          color: "#3b82f6",
          createdAt: userProfile?.createdAt || Date.now(),
          lastSeenAt: Date.now(),
          enrollmentQuality: "good",
        };
        await saveSpeakerProfile(profile);
        await saveAudioSample(profile.id, base64);
        setUserProfile(profile);
      } else {
        // Update existing profile
        const profile = profiles.find((p) => p.id === forProfile);
        if (profile) {
          profile.enrollmentQuality = "good";
          profile.lastSeenAt = Date.now();
          await saveSpeakerProfile(profile);
          await saveAudioSample(profile.id, base64);
          await loadProfiles();
        }
      }

      setRecordingFor(null);
    };
    reader.readAsDataURL(audioBlob);
  }

  async function handleAddProfile() {
    if (!newProfileName.trim()) return;

    const profile = createSpeakerProfile(newProfileName.trim(), newProfileType);
    await saveSpeakerProfile(profile);
    await loadProfiles();

    setNewProfileName("");
    setShowAddProfile(false);
  }

  async function handleDeleteProfile(id: string) {
    await deleteSpeakerProfile(id);
    await loadProfiles();
  }

  function getEnrollmentQualityBadge(quality: SpeakerProfile["enrollmentQuality"]) {
    switch (quality) {
      case "excellent":
        return "bg-green-500/20 text-green-700 dark:text-green-300";
      case "good":
        return "bg-blue-500/20 text-blue-700 dark:text-blue-300";
      case "fair":
        return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300";
      case "poor":
        return "bg-orange-500/20 text-orange-700 dark:text-orange-300";
      default:
        return "bg-muted text-muted-foreground";
    }
  }

  return (
    <div className="space-y-6">
      {/* User Voice Profile */}
      <div className="space-y-3">
        <Header
          title="Your Voice Profile"
          description="Record your voice for automatic speaker identification in meetings."
        />

        <div className="p-4 border rounded-lg">
          {isRecording && recordingFor === "user" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 bg-red-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium">Recording...</span>
              </div>
              <Progress value={recordingProgress * 100} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {Math.round(recordingProgress * ENROLLMENT_DURATION)}/
                {ENROLLMENT_DURATION} seconds
              </p>
              <p className="text-xs text-muted-foreground">
                Speak naturally about anything - your day, what you see, or read
                something aloud.
              </p>
              <Button variant="destructive" size="sm" onClick={stopRecording}>
                <StopCircleIcon className="h-4 w-4 mr-2" />
                Stop Recording
              </Button>
            </div>
          ) : userProfile ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <UserIcon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">Voice Enrolled</p>
                  <p className="text-xs text-muted-foreground">
                    Quality:{" "}
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] ${getEnrollmentQualityBadge(
                        userProfile.enrollmentQuality
                      )}`}
                    >
                      {userProfile.enrollmentQuality}
                    </span>
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => startRecording("user")}
              >
                <MicIcon className="h-4 w-4 mr-2" />
                Re-record
              </Button>
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground mb-3">
                Record a 30-second voice sample to enable automatic
                identification.
              </p>
              <Button onClick={() => startRecording("user")}>
                <MicIcon className="h-4 w-4 mr-2" />
                Start Recording
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Other Speaker Profiles */}
      <div className="space-y-3">
        <Header
          title="Other Speaker Profiles"
          description="Add profiles for colleagues and clients you meet with regularly."
        />

        {profiles.length === 0 && !showAddProfile ? (
          <p className="text-sm text-muted-foreground py-2">
            No other speakers enrolled yet.
          </p>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="h-8 w-8 rounded-full flex items-center justify-center text-white text-sm font-medium"
                    style={{ backgroundColor: profile.color }}
                  >
                    {profile.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-sm">{profile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {profile.type} -{" "}
                      {profile.enrollmentQuality === "none" ? (
                        "Not enrolled"
                      ) : (
                        <span
                          className={`px-1 py-0.5 rounded text-[10px] ${getEnrollmentQualityBadge(
                            profile.enrollmentQuality
                          )}`}
                        >
                          {profile.enrollmentQuality}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {isRecording && recordingFor === profile.id ? (
                    <div className="flex items-center gap-2 mr-2">
                      <div className="h-2 w-2 bg-red-500 rounded-full animate-pulse" />
                      <span className="text-xs">
                        {Math.round(recordingProgress * ENROLLMENT_DURATION)}s
                      </span>
                      <Button
                        variant="destructive"
                        size="icon"
                        className="h-7 w-7"
                        onClick={stopRecording}
                      >
                        <StopCircleIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => startRecording(profile.id)}
                      title="Record voice sample"
                    >
                      <MicIcon className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => handleDeleteProfile(profile.id)}
                    title="Delete profile"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add new profile form */}
        {showAddProfile ? (
          <div className="p-3 border rounded-lg space-y-3">
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="Name (e.g., Sarah Chen)"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddProfile();
                  if (e.key === "Escape") {
                    setShowAddProfile(false);
                    setNewProfileName("");
                  }
                }}
                className="flex-1"
                autoFocus
              />
              <select
                value={newProfileType}
                onChange={(e) =>
                  setNewProfileType(
                    e.target.value as "colleague" | "client" | "other"
                  )
                }
                className="px-2 py-1 border rounded text-sm bg-background"
              >
                <option value="colleague">Colleague</option>
                <option value="client">Client</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAddProfile}>
                <PlusIcon className="h-4 w-4 mr-1" />
                Add Profile
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowAddProfile(false);
                  setNewProfileName("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddProfile(true)}
          >
            <PlusIcon className="h-4 w-4 mr-1" />
            Add Speaker Profile
          </Button>
        )}
      </div>
    </div>
  );
}
