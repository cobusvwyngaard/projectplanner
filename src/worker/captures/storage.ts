// R2 key construction and MIME-to-extension mapping for captured audio.

/** Map a MIME type (possibly with parameters) to a file extension. */
export function extensionForMime(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/mp4":
    case "video/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/ogg":
    case "audio/vorbis":
    case "application/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/aac":
      return "aac";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    default:
      return "bin";
  }
}

/** Build the R2 key for a capture: captures/<yyyy>/<mm>/<id>.<ext> (UTC). */
export function captureKey(id: string, mime: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `captures/${yyyy}/${mm}/${id}.${extensionForMime(mime)}`;
}