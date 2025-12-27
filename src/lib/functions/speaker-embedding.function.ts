/**
 * Speaker Embedding Functions
 *
 * This module provides voice embedding extraction and matching capabilities
 * for cross-session speaker identification.
 *
 * NOTE: Full TensorFlow.js integration requires a pre-trained speaker verification model.
 * This implementation provides the interface and cosine similarity matching.
 * The actual embedding extraction can be enhanced with a real model later.
 */

/**
 * Result of finding the best matching profile.
 */
export interface SpeakerMatch {
  profileId: string;
  profileName: string;
  confidence: number;
  needsConfirmation: boolean;
}

// Confidence thresholds
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Calculate cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have same length");
  }

  if (a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Find the best matching profile for an embedding.
 */
export function findBestMatch(
  embedding: number[],
  profiles: Array<{ id: string; name: string; embedding: number[] }>
): SpeakerMatch | null {
  if (!embedding || embedding.length === 0 || profiles.length === 0) {
    return null;
  }

  let bestMatch: SpeakerMatch | null = null;

  for (const profile of profiles) {
    if (!profile.embedding || profile.embedding.length === 0) {
      continue;
    }

    const similarity = cosineSimilarity(embedding, profile.embedding);
    const confidence = (similarity + 1) / 2; // Normalize to 0-1

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        profileId: profile.id,
        profileName: profile.name,
        confidence,
        needsConfirmation:
          confidence >= MEDIUM_CONFIDENCE_THRESHOLD &&
          confidence < HIGH_CONFIDENCE_THRESHOLD,
      };
    }
  }

  // Only return match if it meets minimum threshold
  if (bestMatch && bestMatch.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
    return bestMatch;
  }

  return null;
}

/**
 * Check if a match is high confidence (auto-accept).
 */
export function isHighConfidenceMatch(match: SpeakerMatch | null): boolean {
  return match !== null && match.confidence >= HIGH_CONFIDENCE_THRESHOLD;
}

/**
 * Check if a match needs user confirmation.
 */
export function needsConfirmation(match: SpeakerMatch | null): boolean {
  return match !== null && match.needsConfirmation;
}

/**
 * Placeholder for audio preprocessing.
 * This would convert raw audio to the format expected by the model.
 *
 * In a full implementation, this would:
 * 1. Resample to 16kHz
 * 2. Compute mel spectrogram
 * 3. Normalize values
 */
export async function preprocessAudio(
  audioBlob: Blob
): Promise<Float32Array | null> {
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    return new Float32Array(arrayBuffer);
  } catch (error) {
    console.error("[Speaker Embedding] Failed to preprocess audio:", error);
    return null;
  }
}

/**
 * Placeholder for embedding extraction.
 *
 * In a full implementation with TensorFlow.js, this would:
 * 1. Load a pre-trained speaker verification model
 * 2. Preprocess the audio into model-expected format
 * 3. Run inference to get embedding vector
 * 4. Return the 512-dimensional embedding
 *
 * For now, this returns null to indicate embedding is not available.
 * The system will fall back to session-level speaker assignment.
 */
export async function extractEmbedding(
  _audioBlob: Blob
): Promise<number[] | null> {
  console.log(
    "[Speaker Embedding] Embedding extraction not implemented. Using session-level speaker assignment."
  );

  // TODO: Implement TensorFlow.js speaker embedding model
  // Options for implementation:
  // 1. Use a pre-trained model like VGGVox or SpeakerNet
  // 2. Host a converted TensorFlow.js model
  // 3. Use WebAssembly for faster inference

  return null;
}

/**
 * Generate a simple audio fingerprint for basic matching.
 * This is a fallback when full embeddings are not available.
 *
 * NOTE: This is not a real voice fingerprint - it's based on basic audio statistics.
 * Real speaker identification requires proper voice embeddings from a trained model.
 */
export async function generateSimpleFingerprint(
  audioBlob: Blob
): Promise<number[] | null> {
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioData = new Float32Array(arrayBuffer);

    if (audioData.length === 0) {
      return null;
    }

    // Calculate basic statistics as a pseudo-fingerprint
    // This is NOT suitable for real speaker identification
    const stats: number[] = [];

    // Mean
    let sum = 0;
    for (const val of audioData) {
      sum += val;
    }
    stats.push(sum / audioData.length);

    // Variance
    const mean = stats[0];
    let varianceSum = 0;
    for (const val of audioData) {
      varianceSum += (val - mean) ** 2;
    }
    stats.push(varianceSum / audioData.length);

    // Zero crossing rate (approximation)
    let zeroCrossings = 0;
    for (let i = 1; i < audioData.length; i++) {
      if ((audioData[i] >= 0) !== (audioData[i - 1] >= 0)) {
        zeroCrossings++;
      }
    }
    stats.push(zeroCrossings / audioData.length);

    // Energy
    let energy = 0;
    for (const val of audioData) {
      energy += val * val;
    }
    stats.push(energy / audioData.length);

    return stats;
  } catch (error) {
    console.error("[Speaker Embedding] Failed to generate fingerprint:", error);
    return null;
  }
}
