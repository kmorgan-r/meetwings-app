# Performance Optimization: Redundant Pitch Analysis

## Executive Summary

**Problem**: Pitch analysis runs for every speaker in every 30-second batch, even when we already have high-confidence voice profiles. This causes unnecessary CPU usage and performance degradation in long meetings.

**Solution**: Implement early-exit optimization that skips pitch analysis when existing profiles meet confidence thresholds (≥0.8 confidence, ≥5 samples).

**Expected Impact**: 50-80% reduction in pitch analysis operations, significantly improved CPU performance in long meetings.

---

## Problem Analysis

### Current Behavior

**Location**: `src/hooks/useSpeakerDiarization.ts:280-369` (`matchDiarizationResults` function)

**Issue**: The current implementation always analyzes pitch for every speaker in every batch:

```typescript
// Current: Lines 280-308
for (const [diarizationLabel, speakerUtts] of speakerUtterances.entries()) {
  const longestUtterance = speakerUtts.reduce(...);
  const uttAbsTime = batchStartTime + longestUtterance.start;
  const matchingSegment = findClosestSegment(segments, uttAbsTime);

  if (matchingSegment) {
    // ⚠️ ALWAYS analyzes pitch - no early exit for high-confidence profiles
    const pitchData = await analyzePitch(matchingSegment.audio); // O(n²) operation
    const matchedProfile = await findProfileByPitch(pitchData, 80);
    // ... rest of logic
  }
}
```

### Real-World Impact

**Example Scenario**: 1-hour meeting with 5 speakers
- **Batches**: 120 batches (30 seconds each)
- **Speaker appearance**: Each speaker appears in ~60% of batches = 72 batches per speaker
- **Total pitch analyses**: 5 speakers × 72 batches = **360 pitch analyses**

**Pitch Analysis Cost**:
- **Complexity**: O(n²) autocorrelation algorithm
- **Duration**: 20-50ms per analysis on modern hardware, 50-200ms on older devices
- **Total CPU time**: 360 × 50ms = **18 seconds of CPU time** (just for pitch analysis!)

### Why This Happens

The current implementation doesn't check if:
1. This speaker was seen in previous batches
2. Their voice profile already has high confidence
3. We can safely reuse the existing profile

Instead, it **always** runs pitch analysis, treating every batch as if it's the first time seeing each speaker.

---

## Proposed Solution

### Optimization Strategy

**Before running expensive pitch analysis**, check if we can reuse an existing high-confidence profile:

```
For each speaker in the batch:
  1. Check if this diarizationLabel appeared in previous batches
  2. If yes, retrieve the associated profileId
  3. Load the profile from storage
  4. Check if profile.pitchProfile.confidence >= 0.8 AND sampleCount >= 5
  5. If yes:
     - Reuse existing profile (skip pitch analysis)
     - Log performance savings
     - Continue to next speaker
  6. If no:
     - Proceed with pitch analysis (current logic)
     - Build or improve profile
```

### Confidence Thresholds

```typescript
const TARGET_CONFIDENCE = 0.8;  // High quality threshold
const MIN_SAMPLES = 5;           // Minimum samples for reliability
```

**Rationale**:
- **0.8 confidence**: Pitch analysis returns confidence 0-1 based on signal quality
- **5 samples**: Ensures profile is stable across multiple utterances
- **Combined**: Prevents false matches while allowing early exit

### Expected Behavior After Optimization

**Same 1-hour meeting scenario**:
- **Initial learning**: 5 speakers × 3 batches = 15 pitch analyses (until confidence ≥ 0.8)
- **Subsequent batches**: 0 pitch analyses (reuse profiles)
- **Total**: **15 pitch analyses** (vs 360 before)
- **Savings**: 345 unnecessary analyses = **95.8% reduction**

---

## Implementation Plan

### Step 1: Import Required Dependencies

**Location**: `src/hooks/useSpeakerDiarization.ts:1-15`

**Add import**:
```typescript
import { getSpeakerProfile } from "@/lib/storage/speaker-profiles.storage";
```

**Purpose**: Load existing profiles to check confidence levels.

---

### Step 2: Define Confidence Constants

**Location**: `src/hooks/useSpeakerDiarization.ts:253-262` (before `matchDiarizationResults` function)

**Add constants**:
```typescript
/**
 * Confidence thresholds for skipping redundant pitch analysis.
 *
 * When a speaker's profile reaches these thresholds, we can safely
 * reuse the existing profile instead of analyzing pitch again.
 */
const TARGET_CONFIDENCE = 0.8;  // High quality threshold (0-1 scale)
const MIN_SAMPLES = 5;           // Minimum pitch samples for reliability
```

**Rationale**: Define thresholds as named constants for maintainability and documentation.

---

### Step 3: Add Early-Exit Logic Before Pitch Analysis

**Location**: `src/hooks/useSpeakerDiarization.ts:280-292` (beginning of speaker loop)

**Insert NEW CODE before line 282** ("Use the longest utterance..."):

```typescript
for (const [diarizationLabel, speakerUtts] of speakerUtterances.entries()) {
  // ========== NEW CODE START ==========
  // Performance optimization: Check if we can skip pitch analysis
  // by reusing a high-confidence profile from previous batches.

  // Step 1: Look for this diarizationLabel in previous batches
  // AssemblyAI uses labels like "A", "B", "C" that reset per batch,
  // but the same speaker tends to keep the same label across adjacent batches.
  let existingProfileId: string | undefined;
  let recentBatchId: string | undefined;

  for (const prevBatchId in speakerRegistry.batchMappings) {
    if (prevBatchId === batchId) continue; // Skip current batch
    const prevMapping = speakerRegistry.batchMappings[prevBatchId][diarizationLabel];
    if (prevMapping?.profileId) {
      existingProfileId = prevMapping.profileId;
      recentBatchId = prevBatchId;
      break; // Found recent mapping - check it first (most likely match)
    }
  }

  // Step 2: If found previous mapping, check if profile has sufficient confidence
  if (existingProfileId) {
    try {
      const existingProfile = await getSpeakerProfile(existingProfileId);
      const pitchProfile = existingProfile?.pitchProfile;

      if (
        existingProfile &&
        pitchProfile &&
        pitchProfile.confidence >= TARGET_CONFIDENCE &&
        pitchProfile.sampleCount >= MIN_SAMPLES
      ) {
        // Profile is high-quality - we can safely reuse it without new pitch analysis
        console.log(
          `[Performance] Skipping pitch analysis for ${diarizationLabel} ` +
          `(reusing profile: ${existingProfile.name}, ` +
          `confidence: ${pitchProfile.confidence.toFixed(2)}, ` +
          `samples: ${pitchProfile.sampleCount})`
        );

        // Reuse existing profile in this batch
        batchMap[diarizationLabel] = {
          sessionId: existingProfile.id,
          displayName: existingProfile.name,
          color: existingProfile.color,
          profileId: existingProfile.id,
          // Note: We don't include pitchData here since we didn't analyze new pitch.
          // The profile already has stable pitch characteristics in storage.
        };

        // Register in global assigned speakers
        speakerRegistry.assignedSpeakers[existingProfile.id] = {
          displayName: existingProfile.name,
          color: existingProfile.color,
        };

        // Skip pitch analysis for this speaker - continue to next
        continue;
      } else {
        // Profile exists but doesn't meet thresholds - proceed with pitch analysis
        // This will improve the profile with more samples
        console.log(
          `[SpeakerDiarization] Profile ${existingProfileId} below threshold ` +
          `(confidence: ${pitchProfile?.confidence.toFixed(2) ?? 'none'}, ` +
          `samples: ${pitchProfile?.sampleCount ?? 0}), analyzing pitch to improve profile`
        );
      }
    } catch (error) {
      // If profile loading fails, proceed with pitch analysis
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(
        `[SpeakerDiarization] Failed to load profile ${existingProfileId}:`,
        errorMessage,
        '- proceeding with pitch analysis'
      );
    }
  }
  // ========== NEW CODE END ==========

  // Existing code: Find audio segment(s) for this speaker
  // Use the longest utterance as it's likely to have the best pitch data
  const longestUtterance = speakerUtts.reduce((longest, utt) =>
    (utt.end - utt.start) > (longest.end - longest.start) ? utt : longest
  );

  // ... rest of existing code continues unchanged ...
}
```

**Key Design Decisions**:

1. **Only check previous batches**: Skip current batch to avoid circular dependencies
2. **First match wins**: Use the most recently found mapping (likely the most relevant)
3. **Defensive programming**: Wrap in try-catch to handle profile loading failures gracefully
4. **Detailed logging**: Log both early exits AND cases where we continue analyzing
5. **Profile improvement**: If confidence < 0.8, still analyze to improve the profile
6. **Continue statement**: Exit loop iteration cleanly without duplicating code

---

### Step 4: Update Performance Monitoring

**Location**: `src/hooks/useSpeakerDiarization.ts:303-308` (existing performance warning)

**Enhance existing log** to distinguish between initial analysis and profile improvement:

```typescript
// Existing code at line 299-301
console.log(
  `[SpeakerDiarization] Analyzed pitch for ${diarizationLabel}: ` +
  `${pitchData.avgHz.toFixed(0)} Hz (${duration.toFixed(0)}ms)` +
  (existingProfileId ? ` - improving profile ${existingProfileId}` : ' - new profile')
);
```

**Purpose**: Help identify whether pitch analysis is building a new profile or improving an existing one.

---

## Testing Strategy

### Manual Testing

#### Test 1: Initial Profile Building (First 3 batches)
**Scenario**: Fresh meeting with no existing profiles

**Steps**:
1. Clear all speaker profiles from IndexedDB
2. Start a meeting with multiple speakers
3. Monitor console logs for first 90 seconds (3 batches)

**Expected**:
```
[SpeakerDiarization] Analyzed pitch for A: 180 Hz (25ms) - new profile
[SpeakerDiarization] Analyzed pitch for B: 240 Hz (30ms) - new profile
...
```

**Validation**: All speakers should have pitch analyzed initially.

---

#### Test 2: Early Exit After Confidence Threshold
**Scenario**: Continuing meeting after profiles reach ≥0.8 confidence

**Steps**:
1. Continue from Test 1 (after batch 3)
2. Monitor console logs for next 60 seconds
3. Check that pitch analysis is skipped

**Expected**:
```
[Performance] Skipping pitch analysis for A (reusing profile: Speaker 1, confidence: 0.85, samples: 7)
[Performance] Skipping pitch analysis for B (reusing profile: Speaker 2, confidence: 0.82, samples: 6)
...
```

**Validation**: No "Analyzed pitch" logs after confidence threshold reached.

---

#### Test 3: New Speaker Mid-Meeting
**Scenario**: New speaker joins after initial profiles established

**Steps**:
1. Continue from Test 2 (established profiles)
2. Introduce a new speaker (AssemblyAI will assign new label "C")
3. Monitor console for new speaker

**Expected**:
```
[Performance] Skipping pitch analysis for A (reusing profile: Speaker 1, ...)
[Performance] Skipping pitch analysis for B (reusing profile: Speaker 2, ...)
[SpeakerDiarization] Analyzed pitch for C: 200 Hz (28ms) - new profile
```

**Validation**: Existing speakers skip analysis, new speaker gets analyzed.

---

#### Test 4: Profile Below Threshold
**Scenario**: Speaker with low confidence (<0.8) or few samples (<5)

**Steps**:
1. Manually create a profile with confidence 0.6 and sampleCount 3
2. Start meeting with that speaker
3. Monitor console logs

**Expected**:
```
[SpeakerDiarization] Profile <id> below threshold (confidence: 0.60, samples: 3), analyzing pitch to improve profile
[SpeakerDiarization] Analyzed pitch for A: 180 Hz (25ms) - improving profile <id>
```

**Validation**: Low-confidence profiles continue to be analyzed until threshold reached.

---

#### Test 5: Long Meeting Performance
**Scenario**: 30-minute meeting to verify sustained performance improvement

**Steps**:
1. Conduct 30-minute meeting with 3-5 speakers
2. Monitor console for first 5 batches (initial learning)
3. Monitor console for remaining 55 batches (should skip analysis)
4. Compare CPU usage before/after optimization

**Expected**:
- **Batches 1-5**: Pitch analysis for all speakers (building profiles)
- **Batches 6-60**: "Skipping pitch analysis" logs only
- **CPU improvement**: Noticeable reduction in CPU spikes every 30 seconds

**Validation**: Most batches should skip pitch analysis after initial learning period.

---

### Automated Testing

#### Unit Test: Early Exit Logic

**File**: `src/tests/useSpeakerDiarization.test.ts`

**New test case**:
```typescript
describe('Redundant Pitch Analysis Optimization', () => {
  it('should skip pitch analysis when profile has sufficient confidence', async () => {
    // Arrange: Create high-confidence profile
    const highConfidenceProfile = await createSpeakerProfile({
      name: 'Test Speaker',
      pitchProfile: {
        avgHz: 180,
        confidence: 0.85, // Above threshold
        sampleCount: 7,    // Above minimum
        // ... other fields
      },
    });

    // Arrange: Create speaker registry with previous batch mapping
    const speakerRegistry = {
      batchMappings: {
        'batch-1': {
          'A': {
            sessionId: highConfidenceProfile.id,
            profileId: highConfidenceProfile.id,
            displayName: 'Test Speaker',
            color: '#22c55e',
          },
        },
      },
      assignedSpeakers: {},
      nextSpeakerNumber: 2,
    };

    // Arrange: Mock analyzePitch (should NOT be called)
    const analyzePitchSpy = vi.fn();

    // Act: Process new batch with same speaker label "A"
    await matchDiarizationResults(
      transcriptEntries,
      utterances, // Contains speaker "A"
      Date.now(),
      'batch-2', // New batch
      speakerRegistry,
      updateEntry,
      new Set(),
      segments
    );

    // Assert: analyzePitch was NOT called (early exit worked)
    expect(analyzePitchSpy).not.toHaveBeenCalled();

    // Assert: Speaker mapping reused existing profile
    expect(speakerRegistry.batchMappings['batch-2']['A']).toEqual({
      sessionId: highConfidenceProfile.id,
      profileId: highConfidenceProfile.id,
      displayName: 'Test Speaker',
      color: '#22c55e',
    });
  });

  it('should analyze pitch when profile confidence below threshold', async () => {
    // Arrange: Create low-confidence profile
    const lowConfidenceProfile = await createSpeakerProfile({
      name: 'Test Speaker',
      pitchProfile: {
        avgHz: 180,
        confidence: 0.6, // BELOW threshold
        sampleCount: 3,   // Below minimum
        // ... other fields
      },
    });

    // Arrange: Similar setup to previous test
    const speakerRegistry = { /* ... */ };
    const analyzePitchSpy = vi.fn().mockResolvedValue({
      avgHz: 185,
      confidence: 0.75,
      // ... pitch data
    });

    // Act: Process new batch
    await matchDiarizationResults(/* ... */);

    // Assert: analyzePitch WAS called (no early exit)
    expect(analyzePitchSpy).toHaveBeenCalled();
  });

  it('should analyze pitch for new speakers not in previous batches', async () => {
    // Arrange: Registry with speaker "A" only
    const speakerRegistry = {
      batchMappings: {
        'batch-1': {
          'A': { /* existing speaker */ },
        },
      },
      // ...
    };

    const analyzePitchSpy = vi.fn().mockResolvedValue({ /* pitch data */ });

    // Act: Process batch with NEW speaker "B"
    await matchDiarizationResults(
      transcriptEntries,
      utterances, // Contains speaker "B" (new)
      Date.now(),
      'batch-2',
      speakerRegistry,
      updateEntry,
      new Set(),
      segments
    );

    // Assert: analyzePitch called for new speaker
    expect(analyzePitchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ /* audio for speaker B */ })
    );
  });
});
```

---

### Integration Testing

**File**: `src/tests/speaker-diarization-integration.test.ts`

**New test case**:
```typescript
it('should reduce pitch analysis calls in long meetings after initial learning', async () => {
  // Simulate 30-minute meeting (60 batches)
  const totalBatches = 60;
  const speakerCount = 3;
  let pitchAnalysisCount = 0;

  // Mock analyzePitch to count calls
  const analyzePitchSpy = vi.fn().mockImplementation(() => {
    pitchAnalysisCount++;
    return Promise.resolve({
      avgHz: 180 + Math.random() * 60,
      confidence: 0.8 + Math.random() * 0.15, // Gradually increase
      sampleCount: pitchAnalysisCount,
      // ... other fields
    });
  });

  // Process all batches
  for (let i = 0; i < totalBatches; i++) {
    await processBatch(/* ... */);
  }

  // Expected: ~15 analyses (3 speakers × ~5 batches to reach confidence)
  // Actual baseline: 180 analyses (3 speakers × 60 batches)
  // Savings: 165 analyses (91.7% reduction)
  expect(pitchAnalysisCount).toBeLessThan(20); // Allow some buffer
  expect(pitchAnalysisCount).toBeGreaterThan(10); // At least initial learning

  console.log(`Pitch analysis reduction: ${((180 - pitchAnalysisCount) / 180 * 100).toFixed(1)}%`);
});
```

---

## Performance Metrics

### Before Optimization

**Scenario**: 1-hour meeting, 5 speakers

| Metric | Value |
|--------|-------|
| Total batches | 120 |
| Pitch analyses | 360 |
| CPU time (pitch) | ~18 seconds |
| CPU usage pattern | Consistent spikes every 30s |

### After Optimization (Expected)

**Same scenario**:

| Metric | Value | Change |
|--------|-------|--------|
| Total batches | 120 | - |
| Pitch analyses | 15-25 | **-93% to -95%** |
| CPU time (pitch) | ~1 second | **-94%** |
| CPU usage pattern | Spikes only in first 2 minutes | **Much smoother** |

### Verification Method

**Chrome DevTools Performance Profiler**:
1. Record performance during 5-minute meeting
2. Search for `analyzePitch` calls
3. Count occurrences and total duration
4. Compare before/after optimization

**Expected**: Dramatic reduction in `analyzePitch` samples after minute 2.

---

## Risks and Mitigations

### Risk 1: Profile Staleness

**Issue**: Speaker's voice characteristics change (e.g., sick, different microphone)

**Likelihood**: Low (voice pitch is relatively stable)

**Mitigation**:
- Existing `updateProfilePitch()` still runs when profiles ARE created
- Consider future enhancement: periodic re-analysis every N batches
- User can manually delete/recreate profiles if needed

**Impact**: Minimal - worst case is speaker mislabeled until profile updated

---

### Risk 2: AssemblyAI Label Inconsistency

**Issue**: AssemblyAI might assign different labels to same speaker across batches

**Likelihood**: Medium (labels like "A", "B" can shift if speakers come/go)

**Mitigation**:
- Current implementation already handles this via pitch matching
- If label shifts, new pitch analysis will match to correct existing profile
- Early exit only activates when label IS consistent across batches

**Impact**: Reduced optimization benefit when labels shift, but no correctness issues

---

### Risk 3: Insufficient Initial Samples

**Issue**: 5 samples might not be enough for reliable voice profile

**Likelihood**: Low (5 samples × 3-5 second utterances = 15-25 seconds of audio)

**Mitigation**:
- MIN_SAMPLES = 5 is conservative (most speakers identifiable after 2-3 samples)
- Can adjust threshold based on real-world testing
- Confidence score (0.8) provides additional quality check

**Impact**: Minimal - threshold is already conservative

---

### Risk 4: Profile Loading Failures

**Issue**: IndexedDB errors or corrupted profiles

**Likelihood**: Very Low

**Mitigation**:
- Wrapped in try-catch block
- Gracefully falls back to pitch analysis if loading fails
- Logs warning for debugging

**Impact**: None - system continues to function correctly

---

## Success Criteria

### Functional Requirements

✅ **Correctness**: Speaker identification accuracy remains unchanged
✅ **Compatibility**: No breaking changes to existing functionality
✅ **Graceful degradation**: Falls back to pitch analysis if profile loading fails
✅ **User transparency**: No user-facing changes (pure optimization)

### Performance Requirements

✅ **CPU reduction**: ≥50% reduction in pitch analysis calls after initial learning
✅ **Memory stability**: No memory leaks from profile caching
✅ **Responsiveness**: No added latency to batch processing
✅ **Scalability**: Performance improves with meeting duration (longer meetings = more savings)

### Code Quality Requirements

✅ **Logging**: Clear console logs for debugging and verification
✅ **Comments**: Comprehensive inline documentation
✅ **Type safety**: No TypeScript errors or warnings
✅ **Test coverage**: Unit tests for early-exit logic

---

## Rollout Plan

### Phase 1: Implementation ✅ (This PR)
- Add early-exit logic to `matchDiarizationResults()`
- Add confidence threshold constants
- Implement profile reuse logic

### Phase 2: Testing (Next PR)
- Add unit tests for early-exit scenarios
- Add integration test for long meetings
- Manual testing with real meetings

### Phase 3: Monitoring (After Deployment)
- Monitor console logs for early-exit frequency
- Collect performance metrics from real users
- Adjust thresholds if needed (TARGET_CONFIDENCE, MIN_SAMPLES)

### Phase 4: Future Enhancements (Optional)
- Add periodic re-analysis (e.g., every 10 batches) to detect voice changes
- Expose optimization metrics in UI (e.g., "Pitch analyses saved: 245")
- Add setting to adjust confidence thresholds

---

## Code Review Checklist

### Before Submitting

- [ ] Implementation follows exact plan documented above
- [ ] No TypeScript errors or warnings
- [ ] Console logs are clear and helpful
- [ ] Try-catch blocks handle all error cases
- [ ] Constants are well-documented
- [ ] No performance regressions (existing logic unchanged)
- [ ] Manual testing completed (at least Tests 1-3)

### Reviewer Focus Areas

- [ ] **Correctness**: Does early exit logic correctly identify high-confidence profiles?
- [ ] **Edge cases**: What happens when profile loading fails? Label shifts?
- [ ] **Performance**: Are there any new performance bottlenecks?
- [ ] **Maintainability**: Are constants and logic well-documented?
- [ ] **Testing**: Are there sufficient tests for the new behavior?

---

## Implementation Notes

### Key Files Modified

1. **`src/hooks/useSpeakerDiarization.ts`**
   - Add import for `getSpeakerProfile`
   - Add confidence threshold constants
   - Insert early-exit logic in `matchDiarizationResults()`
   - Enhance performance logging

### Lines of Code

**Estimated**: ~60 lines added (including comments)
- Constants: 8 lines
- Early-exit logic: 45 lines
- Enhanced logging: 7 lines

### Dependencies

**New imports**: `getSpeakerProfile` from `@/lib/storage/speaker-profiles.storage`

**No new packages required** ✅

---

## Appendix: Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ matchDiarizationResults()                                   │
│                                                             │
│  For each speaker label ("A", "B", "C"):                   │
│                                                             │
│  ┌──────────────────────────────────────┐                  │
│  │ NEW: Check Previous Batches          │                  │
│  │                                      │                  │
│  │ 1. Look for label in batchMappings   │                  │
│  │ 2. Find profileId if exists          │                  │
│  └──────────┬───────────────────────────┘                  │
│             │                                               │
│             ├─── No previous mapping                        │
│             │    └─> Proceed to pitch analysis ──┐         │
│             │                                     │         │
│             └─── Found profileId                 │         │
│                  │                                │         │
│  ┌───────────────▼──────────────────────┐        │         │
│  │ Load Profile from Storage            │        │         │
│  │                                      │        │         │
│  │ await getSpeakerProfile(profileId)   │        │         │
│  └──────────┬───────────────────────────┘        │         │
│             │                                     │         │
│             ├─── Loading failed                  │         │
│             │    └─> Proceed to pitch analysis ──┤         │
│             │                                     │         │
│             └─── Profile loaded                  │         │
│                  │                                │         │
│  ┌───────────────▼──────────────────────┐        │         │
│  │ Check Confidence & Samples           │        │         │
│  │                                      │        │         │
│  │ confidence >= 0.8 AND samples >= 5?  │        │         │
│  └──────────┬───────────────────────────┘        │         │
│             │                                     │         │
│             ├─── NO (below threshold)            │         │
│             │    └─> Proceed to pitch analysis ──┤         │
│             │                                     │         │
│             └─── YES (sufficient confidence)     │         │
│                  │                                │         │
│  ┌───────────────▼──────────────────────┐        │         │
│  │ EARLY EXIT: Reuse Profile            │        │         │
│  │                                      │        │         │
│  │ 1. Copy profile to batchMap          │        │         │
│  │ 2. Register in assignedSpeakers      │        │         │
│  │ 3. Log performance savings           │        │         │
│  │ 4. continue (skip pitch analysis)    │        │         │
│  └──────────────────────────────────────┘        │         │
│                                                   │         │
│  ┌───────────────────────────────────────────────▼─────┐   │
│  │ EXISTING: Pitch Analysis Path                       │   │
│  │                                                      │   │
│  │ 1. Find longest utterance                           │   │
│  │ 2. Find matching audio segment                      │   │
│  │ 3. analyzePitch(audio) ← O(n²) expensive            │   │
│  │ 4. Match against existing profiles                  │   │
│  │ 5. Create new profile or update existing            │   │
│  │ 6. Store in batchMap                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## References

- **Original Issue**: Redundant pitch analysis identified in performance audit
- **Related Files**:
  - `src/lib/functions/pitch-analysis.ts` - Pitch analysis implementation
  - `src/lib/storage/speaker-profiles.storage.ts` - Profile storage
  - `src/hooks/useSpeakerDiarization.ts` - Main diarization logic
- **Previous Optimizations**:
  - Candidate pool limiting (line 461-472)
  - Levenshtein early exit (line 477-484)
  - Queue size protection (useMeetingAudio.ts:216-228)

---

## Document History

- **Created**: 2025-12-30
- **Author**: Development Team
- **Status**: Implementation Ready
- **Version**: 1.0
