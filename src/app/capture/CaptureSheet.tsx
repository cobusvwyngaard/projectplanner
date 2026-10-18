// The capture sheet: record, upload or type a note. Recordings are kept in
// memory until they are saved, so a failed upload never loses them.

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import { store } from "../store";
import { reportError, showToast } from "../toast";
import { CloseIcon } from "../components/icons";

interface Props {
  autoStart: boolean;
  onClose: () => void;
}

type Mode = "record" | "upload" | "text";

function extensionFor(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "audio/mp4" || base === "video/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/wav" || base === "audio/wave") return "wav";
  return "webm";
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_RECORDING_MS = 30 * 60 * 1000;

export function CaptureSheet({ autoStart, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("record");

  // Recording state.
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobDuration, setBlobDuration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const saveOnStopRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const mimeRef = useRef<string>("");
  const maxTimerRef = useRef<number | null>(null);

  // Upload state.
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadFileError, setUploadFileError] = useState<string | null>(null);

  // Text state.
  const [text, setText] = useState("");
  const [textSaving, setTextSaving] = useState(false);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  const revokeBlobUrl = useCallback(() => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      setBlobUrl(null);
    }
  }, [blobUrl]);

  /** Upload a finished recording; it stays in memory (and downloadable) if this fails. */
  const uploadBlob = useCallback(
    async (recorded: Blob, durationS: number) => {
      setSaving(true);
      setProgress(0);
      setUploadError(null);
      const mime = recorded.type || mimeRef.current || "audio/webm";
      const file = new File([recorded], `recording.${extensionFor(mime)}`, { type: mime });
      try {
        const result = await api.createCaptureFile(file, "voice", durationS, (p) => setProgress(p));
        store.putCapture(result.row);
        showToast("Saved to the Inbox");
        setBlob(null);
        revokeBlobUrl();
        onClose();
      } catch (err) {
        setUploadError(errorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [onClose, revokeBlobUrl],
  );

  const startRecording = useCallback(async () => {
    setMicError(null);
    setBlob(null);
    revokeBlobUrl();
    setElapsed(0);
    setLevel(0);
    chunksRef.current = [];
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError("Microphone not available. You can still upload a recording or type a note.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicError("Microphone not available. You can still upload a recording or type a note.");
      return;
    }
    streamRef.current = stream;

    const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    const supported = candidates.find((t) => {
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    });
    const mimeType = supported ?? "";
    mimeRef.current = mimeType;

    // Level meter.
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = ((data[i] ?? 0) - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Level meter is optional.
    }

    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      setMicError("Microphone not available. You can still upload a recording or type a note.");
      stopTracks();
      return;
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopTracks();
      setRecording(false);
      if (discardRef.current) {
        // Cancelled: the chunks were dropped with the recording.
        discardRef.current = false;
        saveOnStopRef.current = false;
        chunksRef.current = [];
        return;
      }
      const type = mimeRef.current || recorder.mimeType || "audio/webm";
      const recorded = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      const durationS = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      setBlob(recorded);
      setBlobDuration(durationS);
      setBlobUrl(URL.createObjectURL(recorded));
      if (saveOnStopRef.current) {
        saveOnStopRef.current = false;
        void uploadBlob(recorded, durationS);
      }
    };

    startedAtRef.current = Date.now();
    recorder.start(250);
    setRecording(true);
    setElapsed(0);
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    maxTimerRef.current = window.setTimeout(() => {
      // Half an hour is the limit: stop and save.
      saveOnStopRef.current = true;
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    }, MAX_RECORDING_MS);
  }, [revokeBlobUrl, stopTracks, uploadBlob]);

  const stopRecording = useCallback((save: boolean) => {
    if (!save) {
      // Discard: drop the chunks before the recorder's onstop can read them.
      discardRef.current = true;
      chunksRef.current = [];
      setBlob(null);
      revokeBlobUrl();
      setElapsed(0);
    } else {
      saveOnStopRef.current = true;
    }
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
    else if (!save) setRecording(false);
  }, [revokeBlobUrl]);

  // Auto-start on open.
  useEffect(() => {
    if (autoStart) {
      setMode("record");
      void startRecording();
    }
    return () => {
      // Closing the sheet: stop the recording without keeping it.
      discardRef.current = true;
      chunksRef.current = [];
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
      stopTracks();
      revokeBlobUrl();
    };
  }, []);

  const retrySaveRecording = useCallback(() => {
    if (!blob) return;
    setUploadError(null);
    void uploadBlob(blob, blobDuration > 0 ? blobDuration : elapsed);
  }, [blob, blobDuration, elapsed, uploadBlob]);

  const saveToDevice = useCallback(() => {
    if (!blob || !blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `recording-${Date.now()}.${extensionFor(blob.type || "audio/webm")}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [blob, blobUrl]);

  // Upload audio.
  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setUploadFile(f);
    setUploadFileError(null);
    setUploadProgress(0);
  };

  const saveUpload = useCallback(async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadFileError(null);
    try {
      const result = await api.createCaptureFile(uploadFile, "file", null, (p) => setUploadProgress(p));
      store.putCapture(result.row);
      showToast("Saved to the Inbox");
      setUploadFile(null);
      onClose();
    } catch (err) {
      setUploadFileError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }, [uploadFile, onClose]);

  // Text.
  const saveText = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setTextSaving(true);
    try {
      const result = await api.createCaptureText(trimmed, () => undefined);
      store.putCapture(result.row);
      showToast("Saved to the Inbox");
      setText("");
      onClose();
    } catch (err) {
      reportError(err);
      // Keep text.
    } finally {
      setTextSaving(false);
    }
  }, [text, onClose]);

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void saveText();
    }
  };

  const cancelRecording = useCallback(() => {
    if (recording) {
      stopRecording(false);
    }
    setBlob(null);
    revokeBlobUrl();
    setElapsed(0);
    setMicError(null);
    setUploadError(null);
  }, [recording, stopRecording, revokeBlobUrl]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Capture">
      <div className="modal capture-sheet">
        <header className="modal-head">
          <h2>Capture</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="segmented" role="tablist" aria-label="Capture mode">
          <button type="button" className="segment" aria-pressed={mode === "record"} onClick={() => setMode("record")}>
            Record
          </button>
          <button type="button" className="segment" aria-pressed={mode === "upload"} onClick={() => setMode("upload")}>
            Upload
          </button>
          <button type="button" className="segment" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
            Quick text
          </button>
        </div>

        {mode === "record" && (
          <div className="capture-record">
            {micError && <p className="notice notice--error" role="alert">{micError}</p>}

            {recording && (
              <>
                <div className="record-timer" aria-live="polite">{formatDuration(elapsed)}</div>
                <div className="level-meter" aria-hidden="true">
                  <div className="level-bar" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
                <div className="button-row">
                  <button type="button" className="button button--primary" onClick={() => stopRecording(true)}>
                    Stop and save
                  </button>
                  <button type="button" className="button button--quiet" onClick={() => stopRecording(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {!recording && !blob && !micError && (
              <button type="button" className="button button--primary" onClick={() => void startRecording()}>
                Start recording
              </button>
            )}

            {!recording && blob && (
              <div className="capture-saved-pending">
                <p className="muted">Recording ready ({formatDuration(blobDuration || elapsed)}).</p>
                {saving && (
                  <>
                    <div className="progress" aria-label="Upload progress">
                      <div className="progress-bar" style={{ width: `${progress}%` }} />
                    </div>
                    <p className="muted small">Uploading… {progress}%</p>
                  </>
                )}
                {uploadError && (
                  <>
                    <p className="notice notice--error" role="alert">{uploadError}</p>
                    <div className="button-row">
                      <button type="button" className="button button--primary" onClick={retrySaveRecording} disabled={saving}>
                        Try again
                      </button>
                      <button type="button" className="button" onClick={saveToDevice}>
                        Save to this device
                      </button>
                      <button type="button" className="button button--quiet" onClick={cancelRecording}>
                        Discard
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {mode === "upload" && (
          <div className="capture-upload">
            <label className="button">
              Choose audio file
              <input type="file" accept="audio/*" hidden onChange={onFileChange} />
            </label>
            {uploadFile && (
              <div className="upload-meta">
                <p>{uploadFile.name}</p>
                <p className="muted small">{formatBytes(uploadFile.size)}</p>
                {uploading && (
                  <div className="progress" aria-label="Upload progress">
                    <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
                  </div>
                )}
                {!uploading && (
                  <button type="button" className="button button--primary" onClick={() => void saveUpload()}>
                    Upload to Inbox
                  </button>
                )}
                {uploadFileError && <p className="notice notice--error" role="alert">{uploadFileError}</p>}
              </div>
            )}
          </div>
        )}

        {mode === "text" && (
          <form className="capture-text" onSubmit={(e) => void saveText(e)}>
            <textarea
              className="input textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleTextKeyDown}
              placeholder="Type a note…"
              rows={6}
            />
            <div className="button-row">
              <button type="button" className="button button--primary" disabled={textSaving || text.trim() === ""} onClick={() => void saveText()}>
                {textSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}