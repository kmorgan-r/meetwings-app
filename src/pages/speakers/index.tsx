import { PageLayout } from "@/layouts";
import { DiarizationSettings } from "../dev/components/speaker-profiles/DiarizationSettings";
import { SpeakerProfiles } from "../dev/components/speaker-profiles/SpeakerProfiles";

const Speakers = () => {
  return (
    <PageLayout
      title="Speakers"
      description="Manage speaker identification and voice profiles for meetings"
    >
      {/* Speaker Diarization Settings */}
      <DiarizationSettings />

      {/* Speaker Profiles for Voice Enrollment */}
      <SpeakerProfiles />
    </PageLayout>
  );
};

export default Speakers;
