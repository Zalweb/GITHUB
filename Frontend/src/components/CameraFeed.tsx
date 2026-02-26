import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ApiError } from "../services/api";
import { computeBackoffDelay } from "../utils/backoff";
import { captureFrameAsBlob } from "../utils/captureFrame";

export type CameraStats = {
  requestsPerSecond: number;
  pageVisible: boolean;
  networkBackoffMs: number;
};

export type CameraFeedHandle = {
  startCamera: () => Promise<void>;
  stopCamera: () => void;
  switchCamera: () => Promise<void>;
};

type CameraFeedProps = {
  scanEnabled: boolean;
  scanIntervalMs?: number;
  jpegQuality?: number;
  autoStart?: boolean;
  onFrame: (blob: Blob) => Promise<void>;
  onStatsChange?: (stats: CameraStats) => void;
  onCameraStateChange?: (isOn: boolean) => void;
  onScanError?: (error: unknown) => void;
};

function humanCameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Camera permission denied. Enable camera access in browser settings and reload.";
    }
    if (error.name === "NotFoundError") {
      return "No camera device was found.";
    }
    if (error.name === "NotReadableError") {
      return "Camera is in use by another app/browser tab.";
    }
  }
  return error instanceof Error ? error.message : "Unable to access camera.";
}

function isSecureCameraContext(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  if (window.isSecureContext) {
    return true;
  }

  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Camera stream metadata failed to load."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
}

const CameraFeed = forwardRef<CameraFeedHandle, CameraFeedProps>(function CameraFeed(
  {
    scanEnabled,
    scanIntervalMs = 400,
    jpegQuality = 0.8,
    autoStart = true,
    onFrame,
    onStatsChange,
    onCameraStateChange,
    onScanError,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const networkFailuresRef = useRef(0);
  const requestTimesRef = useRef<number[]>([]);
  const visibleRef = useRef(document.visibilityState === "visible");

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");

  const emitStats = useCallback(
    (networkBackoffMs = 0) => {
      const now = Date.now();
      requestTimesRef.current = requestTimesRef.current.filter((ts) => now - ts <= 1000);
      onStatsChange?.({
        requestsPerSecond: requestTimesRef.current.length,
        pageVisible: visibleRef.current,
        networkBackoffMs,
      });
    },
    [onStatsChange],
  );

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraOn(false);
    onCameraStateChange?.(false);
  }, [onCameraStateChange]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    stopCamera();

    try {
      if (!isSecureCameraContext()) {
        throw new Error("Camera requires HTTPS on mobile/remote access. Use https:// or open from localhost.");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support camera access via getUserMedia.");
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      streamRef.current = stream;
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Video element unavailable.");
      }

      videoRef.current.srcObject = stream;
      await waitForVideoMetadata(videoRef.current);
      await videoRef.current.play();

      setCameraOn(true);
      onCameraStateChange?.(true);
    } catch (error) {
      setCameraOn(false);
      const message = humanCameraError(error);
      setCameraError(message);
      onScanError?.(new Error(message));
    }
  }, [facingMode, onCameraStateChange, onScanError, stopCamera]);

  const switchCamera = useCallback(async () => {
    const next = facingMode === "user" ? "environment" : "user";
    setFacingMode(next);
  }, [facingMode]);

  useImperativeHandle(
    ref,
    () => ({
      startCamera,
      stopCamera,
      switchCamera,
    }),
    [startCamera, stopCamera, switchCamera],
  );

  useEffect(() => {
    if (!cameraOn) {
      return;
    }
    startCamera().catch(() => undefined);
  }, [facingMode]);

  useEffect(() => {
    if (autoStart) {
      startCamera().catch(() => undefined);
    }

    return () => {
      stopCamera();
    };
  }, [autoStart, startCamera, stopCamera]);

  useEffect(() => {
    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
      emitStats();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [emitStats]);

  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const schedule = (delayMs: number) => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(loop, delayMs);
    };

    const loop = async () => {
      if (!scanEnabled || !cameraOn || !visibleRef.current) {
        emitStats();
        schedule(scanIntervalMs);
        return;
      }

      if (isProcessingRef.current) {
        schedule(scanIntervalMs);
        return;
      }

      if (!videoRef.current || !canvasRef.current || videoRef.current.readyState < 2) {
        schedule(scanIntervalMs);
        return;
      }

      isProcessingRef.current = true;
      let backoffMs = 0;

      try {
        const blob = await captureFrameAsBlob(videoRef.current, canvasRef.current, jpegQuality);
        requestTimesRef.current.push(Date.now());
        await onFrame(blob);
        networkFailuresRef.current = 0;
      } catch (error) {
        onScanError?.(error);
        if (error instanceof ApiError && error.isNetworkError) {
          networkFailuresRef.current += 1;
          backoffMs = computeBackoffDelay(networkFailuresRef.current, scanIntervalMs);
        } else {
          networkFailuresRef.current = 0;
        }
      } finally {
        isProcessingRef.current = false;
        emitStats(backoffMs);
      }

      schedule(scanIntervalMs + backoffMs);
    };

    schedule(scanIntervalMs);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [cameraOn, emitStats, jpegQuality, onFrame, onScanError, scanEnabled, scanIntervalMs]);

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-black shadow-soft">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="aspect-[3/4] w-full bg-black object-cover"
          style={{ transform: "scaleX(-1)" }}
        />
        <canvas ref={canvasRef} className="hidden" />
        <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
          {cameraOn ? "Camera ON" : "Camera OFF"}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => startCamera().catch(() => undefined)}
          className="rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-3 py-2 text-sm font-medium text-cyan-100"
        >
          Start Camera
        </button>
        <button
          type="button"
          onClick={stopCamera}
          className="rounded-lg border border-amber-400/40 bg-amber-500/20 px-3 py-2 text-sm font-medium text-amber-100"
        >
          Stop Camera
        </button>
        <button
          type="button"
          onClick={() => switchCamera().catch(() => undefined)}
          className="rounded-lg border border-violet-400/40 bg-violet-500/20 px-3 py-2 text-sm font-medium text-violet-100"
        >
          Switch Camera
        </button>
      </div>

      {cameraError ? (
        <div className="rounded-lg border border-red-400/40 bg-red-500/15 p-3 text-sm text-red-100">
          {cameraError}
        </div>
      ) : null}
    </div>
  );
});

export default CameraFeed;
