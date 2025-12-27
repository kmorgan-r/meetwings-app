import { openDB, DBSchema, IDBPDatabase } from "idb";

/**
 * Speaker profile for voice enrollment and identification.
 */
export interface SpeakerProfile {
  id: string; // UUID
  name: string; // "You", "Sarah Chen", etc.
  type: "user" | "colleague" | "client" | "other";
  color: string; // Hex color for visual distinction
  createdAt: number; // Timestamp
  lastSeenAt: number; // Last time this speaker was identified

  // Enrollment data
  audioSampleBase64?: string; // Raw audio sample (stored in IndexedDB)
  embedding?: number[]; // Voice embedding vector (512 dimensions)
  enrollmentQuality: "excellent" | "good" | "fair" | "poor" | "none";
}

/**
 * Audio sample for voice enrollment.
 */
export interface AudioSample {
  profileId: string;
  audioBase64: string;
  recordedAt: number;
}

interface SpeakerProfilesDB extends DBSchema {
  profiles: {
    key: string;
    value: SpeakerProfile;
    indexes: { "by-type": string };
  };
  audioSamples: {
    key: string; // profileId
    value: AudioSample;
  };
}

let db: IDBPDatabase<SpeakerProfilesDB> | null = null;

/**
 * Gets or creates the IndexedDB database.
 */
async function getDB(): Promise<IDBPDatabase<SpeakerProfilesDB>> {
  if (!db) {
    db = await openDB<SpeakerProfilesDB>("speaker-profiles", 1, {
      upgrade(db) {
        // Create profiles store
        const profileStore = db.createObjectStore("profiles", { keyPath: "id" });
        profileStore.createIndex("by-type", "type");

        // Create audio samples store
        db.createObjectStore("audioSamples", { keyPath: "profileId" });
      },
    });
  }
  return db;
}

/**
 * Gets all speaker profiles.
 */
export async function getSpeakerProfiles(): Promise<SpeakerProfile[]> {
  const database = await getDB();
  return database.getAll("profiles");
}

/**
 * Gets a specific speaker profile by ID.
 */
export async function getSpeakerProfile(
  id: string
): Promise<SpeakerProfile | undefined> {
  const database = await getDB();
  return database.get("profiles", id);
}

/**
 * Gets the user's own profile (type = 'user').
 */
export async function getUserProfile(): Promise<SpeakerProfile | undefined> {
  const database = await getDB();
  const profiles = await database.getAllFromIndex("profiles", "by-type", "user");
  return profiles[0]; // Should only be one user profile
}

/**
 * Gets all profiles except the user's own.
 */
export async function getOtherProfiles(): Promise<SpeakerProfile[]> {
  const database = await getDB();
  const allProfiles = await database.getAll("profiles");
  return allProfiles.filter((p) => p.type !== "user");
}

/**
 * Saves a speaker profile.
 */
export async function saveSpeakerProfile(profile: SpeakerProfile): Promise<void> {
  const database = await getDB();
  await database.put("profiles", profile);
}

/**
 * Deletes a speaker profile and its audio sample.
 */
export async function deleteSpeakerProfile(id: string): Promise<void> {
  const database = await getDB();
  await database.delete("profiles", id);
  await database.delete("audioSamples", id);
}

/**
 * Saves an audio sample for a profile.
 */
export async function saveAudioSample(
  profileId: string,
  audioBase64: string
): Promise<void> {
  const database = await getDB();
  await database.put("audioSamples", {
    profileId,
    audioBase64,
    recordedAt: Date.now(),
  });
}

/**
 * Gets the audio sample for a profile.
 */
export async function getAudioSample(
  profileId: string
): Promise<string | undefined> {
  const database = await getDB();
  const sample = await database.get("audioSamples", profileId);
  return sample?.audioBase64;
}

/**
 * Creates a new speaker profile with default values.
 */
export function createSpeakerProfile(
  name: string,
  type: SpeakerProfile["type"],
  color?: string
): SpeakerProfile {
  return {
    id: crypto.randomUUID(),
    name,
    type,
    color: color || getRandomColor(),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    enrollmentQuality: "none",
  };
}

/**
 * Gets a random color for a speaker profile.
 */
function getRandomColor(): string {
  const colors = [
    "#3b82f6", // blue
    "#22c55e", // green
    "#a855f7", // purple
    "#f97316", // orange
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#eab308", // yellow
    "#ef4444", // red
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Updates the embedding for a profile.
 */
export async function updateProfileEmbedding(
  profileId: string,
  embedding: number[]
): Promise<void> {
  const database = await getDB();
  const profile = await database.get("profiles", profileId);
  if (profile) {
    profile.embedding = embedding;
    profile.enrollmentQuality = "good";
    await database.put("profiles", profile);
  }
}

/**
 * Gets all profiles with embeddings (for matching).
 */
export async function getProfilesWithEmbeddings(): Promise<
  Array<{ id: string; name: string; embedding: number[] }>
> {
  const database = await getDB();
  const profiles = await database.getAll("profiles");
  return profiles
    .filter((p) => p.embedding && p.embedding.length > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      embedding: p.embedding!,
    }));
}

/**
 * Deletes all speaker profiles and audio samples.
 */
export async function deleteAllSpeakerData(): Promise<void> {
  const database = await getDB();
  await database.clear("profiles");
  await database.clear("audioSamples");
}
