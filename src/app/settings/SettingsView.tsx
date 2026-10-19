// Settings (SPEC 8): labels, people, transcription, signed-in browsers and
// Claude connections.

import { ClaudeSection } from "./ClaudeSection";
import { LabelsSection } from "./LabelsSection";
import { PeopleSection } from "./PeopleSection";
import { SessionsSection } from "./SessionsSection";
import { TranscriptionSection } from "./TranscriptionSection";

export function SettingsView() {
  return (
    <div className="page settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <LabelsSection />
      <PeopleSection />
      <TranscriptionSection />
      <SessionsSection />
      <ClaudeSection />
    </div>
  );
}
