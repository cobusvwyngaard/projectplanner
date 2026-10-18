// Shared audio player for a capture's recording (Inbox and item history).

import type { Id } from "../../shared/types";
import { captureAudioUrl } from "../api";

export function CaptureAudio({ captureId }: { captureId: Id }) {
  return (
    <audio controls preload="none" src={captureAudioUrl(captureId)}>
      Your browser cannot play this recording.
    </audio>
  );
}