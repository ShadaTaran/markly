"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Generates a tiny, silent test video entirely client-side (a <canvas>
 * animation captured via captureStream + MediaRecorder) and plays it back
 * in a real HTML5 <video controls> element — see this directory's page.tsx
 * for why: no bundled/fetched video asset, so nothing here is or could be
 * copyrighted footage. Deterministic ~12-second duration, short enough for
 * a full real watch-through to stay fast during manual testing while still
 * being long enough for Stage 24's meaningful-playback-accumulation rule
 * (MEANINGFUL_PLAYBACK_RATIO in extension/src/tracking/video/completion.ts)
 * to mean something real in seconds, not fractions of one.
 */
const DURATION_SECONDS = 12;

function useGeneratedTestVideo() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"generating" | "ready" | "unsupported">("generating");

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function generate() {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext("2d");
      // Manual capture mode (frameRate 0) + an explicit requestFrame() per
      // tick below, driven by setInterval rather than requestAnimationFrame
      // — rAF is tied to the page's actual paint cycle and can be throttled
      // to near-zero in a backgrounded/automated tab, which silently
      // starves captureStream(30)'s automatic timer of real frames (the
      // recording completes at the right wall-clock time but the resulting
      // file has almost no actual frame data — observed directly while
      // testing this harness). setInterval keeps firing reliably enough for
      // a local generated test clip regardless of paint visibility.
      const stream = canvas.captureStream?.(0);
      const track = stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
      if (!ctx || !stream || !track?.requestFrame || typeof MediaRecorder === "undefined") {
        if (!cancelled) setStatus("unsupported");
        return;
      }

      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
        (candidate) => MediaRecorder.isTypeSupported?.(candidate),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      const start = performance.now();
      const FRAME_INTERVAL_MS = 1000 / 15;
      const drawFrame = () => {
        const elapsed = (performance.now() - start) / 1000;
        const hue = (elapsed / DURATION_SECONDS) * 300;
        ctx.fillStyle = `hsl(${hue}, 60%, 45%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "white";
        ctx.font = "bold 28px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Markly test video", canvas.width / 2, canvas.height / 2 - 16);
        ctx.font = "20px monospace";
        ctx.fillText(`${elapsed.toFixed(1)}s / ${DURATION_SECONDS}s`, canvas.width / 2, canvas.height / 2 + 20);
        track.requestFrame?.();
      };

      recorder.start();
      const intervalId = setInterval(drawFrame, FRAME_INTERVAL_MS);
      drawFrame();
      await new Promise((resolve) => setTimeout(resolve, DURATION_SECONDS * 1000));
      clearInterval(intervalId);
      recorder.stop();
      await stopped;

      if (cancelled) return;
      const blob = new Blob(chunks, { type: mimeType ?? "video/webm" });
      objectUrl = URL.createObjectURL(blob);
      setVideoUrl(objectUrl);
      setStatus("ready");
    }

    void generate();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  return { videoUrl, status };
}

export function VideoTestHarness({ episodeNumber }: { episodeNumber: number }) {
  const { videoUrl, status } = useGeneratedTestVideo();
  const videoRef = useRef<HTMLVideoElement>(null);

  function seekAndPlay(ratio: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(video.duration * ratio, video.duration - 0.05);
    void video.play();
  }

  function playFromStart() {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    void video.play();
  }

  return (
    <div className="mt-6 space-y-3">
      {status === "generating" && (
        <p className="text-sm text-muted-foreground">Generating a {DURATION_SECONDS}s test video locally (canvas + MediaRecorder)…</p>
      )}
      {status === "unsupported" && (
        <p className="text-sm text-danger">
          This browser doesn&apos;t support canvas.captureStream()/MediaRecorder — the test video can&apos;t be generated here.
        </p>
      )}
      {videoUrl && (
        <>
          <video ref={videoRef} src={videoUrl} controls width={480} height={270} className="rounded-md border border-border" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={playFromStart} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background">
              ▶ Play from start
            </button>
            <button type="button" onClick={() => seekAndPlay(0.1)} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground">
              Seek to 10%
            </button>
            <button type="button" onClick={() => seekAndPlay(0.5)} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground">
              Seek to 50%
            </button>
            <button type="button" onClick={() => seekAndPlay(0.85)} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground">
              Seek to 85%
            </button>
            <button
              type="button"
              onClick={() => seekAndPlay(0.99)}
              className="rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger"
              title="Test E: seek-cheat — should NOT complete despite reaching 'ended'"
            >
              Seek to 99% (cheat test)
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Episode {episodeNumber} · &quot;Play from start&quot; is the only button that should ever result in Markly marking this
            episode complete — the others test that seeking alone (even all the way to the end) does not.
          </p>
        </>
      )}
    </div>
  );
}
