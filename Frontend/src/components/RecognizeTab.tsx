import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CameraFeed, { CameraFeedHandle, CameraStats } from "./CameraFeed";
import { ApiError, recognizeFace } from "../services/api";

type RecognizeResult = {
  match: string;
  confidence: number | null;
  distance: number | null;
  livenessLabel: string;
  livenessScore: number;
  snapshotUrl: string;
};

function isMultipleFaceError(detail: string): boolean {
  const d = detail.toLowerCase();
  return d.includes("exactly 1 face") || d.includes("multiple faces");
}

export default function RecognizeTab() {
  const cameraRef = useRef<CameraFeedHandle | null>(null);

  const [scanActive, setScanActive] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [threshold, setThreshold] = useState(0.5);
  const [scanStatus, setScanStatus] = useState("Paused");
  const [faceStatus, setFaceStatus] = useState("No face");
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [requestsPerSecond, setRequestsPerSecond] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [lastBackendResponse, setLastBackendResponse] = useState<unknown>(null);
  const [result, setResult] = useState<RecognizeResult | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    return () => {
      if (result?.snapshotUrl) {
        URL.revokeObjectURL(result.snapshotUrl);
      }
    };
  }, [result]);

  useEffect(() => {
    if (!scanActive) {
      return;
    }

    const timer = window.setTimeout(() => {
      setScanActive(false);
      setScanStatus("Paused");
      setTimedOut(true);
      setStatusMessage("No match found within 15 seconds.");
    }, 15000);

    return () => window.clearTimeout(timer);
  }, [scanActive]);

  const onStats = useCallback((stats: CameraStats) => {
    setRequestsPerSecond(stats.requestsPerSecond);
    setPageVisible(stats.pageVisible);
  }, []);

  const onScanError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.isNetworkError) {
      setErrorMessage(`Backend unreachable: ${error.detail}`);
      return;
    }
    if (error instanceof Error) {
      setErrorMessage(error.message);
    }
  }, []);

  const startRecognize = useCallback(() => {
    setErrorMessage(null);
    setResult(null);
    setTimedOut(false);
    setFaceStatus("No face");
    setStatusMessage("Scanning for matches...");
    setScanStatus("Scanning");
    setScanActive(true);
  }, []);

  const handleFrame = useCallback(
    async (blob: Blob) => {
      try {
        const response = await recognizeFace(blob, threshold);
        setLastBackendResponse(response);

        if (typeof response.match === "string" && response.match.length > 0) {
          const snapshotUrl = URL.createObjectURL(blob);
          setResult({
            match: response.match,
            confidence: response.confidence ?? null,
            distance: response.distance ?? null,
            livenessLabel: response.liveness?.label ?? "Real",
            livenessScore: response.liveness?.score ?? 0,
            snapshotUrl,
          });

          setFaceStatus("Real face");
          setStatusMessage("Match found.");
          setScanStatus("Success");
          setScanActive(false);
          cameraRef.current?.stopCamera();
          return;
        }

        if (response.message === "Spoof detected.") {
          setFaceStatus("Fake face");
          setStatusMessage("Spoof detected. Keep scanning.");
          return;
        }

        if (response.liveness?.label === "Real") {
          setFaceStatus("Real face");
        }

        setStatusMessage("No match yet...");
      } catch (error) {
        if (error instanceof ApiError) {
          setLastBackendResponse({ status: error.status, detail: error.detail, data: error.data });

          if (error.isNetworkError) {
            throw error;
          }

          if (error.status === 400) {
            const detail = error.detail;
            if (isMultipleFaceError(detail)) {
              setFaceStatus("Multiple faces");
              setStatusMessage("Multiple faces detected. Keep only one face in frame.");
            } else if (detail.toLowerCase().includes("no face")) {
              setFaceStatus("No face");
              setStatusMessage("No face detected. Keep scanning.");
            } else {
              setStatusMessage(detail);
            }
            return;
          }

          setErrorMessage(error.detail);
          return;
        }

        if (error instanceof Error) {
          setErrorMessage(error.message);
          return;
        }

        setErrorMessage("Unknown recognize error.");
      }
    },
    [threshold],
  );

  const statusColor = useMemo(() => {
    if (scanStatus === "Success") {
      return "text-emerald-200";
    }
    if (scanStatus === "Scanning") {
      return "text-cyan-200";
    }
    return "text-slate-200";
  }, [scanStatus]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/15 bg-white/5 p-4">
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm font-semibold text-slate-100">Threshold: {threshold.toFixed(2)}</label>
          <span className="text-xs text-slate-300">Range 0.35 - 0.80</span>
        </div>
        <input
          type="range"
          min={0.35}
          max={0.8}
          step={0.01}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="mt-2 w-full"
        />

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={startRecognize}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950"
          >
            Start Recognize
          </button>
          <button
            type="button"
            onClick={() => {
              setScanActive(false);
              setScanStatus("Paused");
              setStatusMessage("Recognition paused.");
            }}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-100"
          >
            Pause
          </button>
          {timedOut ? (
            <button
              type="button"
              onClick={startRecognize}
              className="rounded-lg border border-amber-400/40 bg-amber-500/20 px-4 py-2 text-sm text-amber-100"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>

      <CameraFeed
        ref={cameraRef}
        scanEnabled={scanActive}
        scanIntervalMs={400}
        jpegQuality={0.8}
        autoStart
        onFrame={handleFrame}
        onStatsChange={onStats}
        onScanError={onScanError}
        onCameraStateChange={setCameraOn}
      />

      <div className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-slate-100">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <p>Camera: <span className="font-semibold">{cameraOn ? "ON" : "OFF"}</span></p>
          <p>
            Scan: <span className={`font-semibold ${statusColor}`}>{scanStatus}</span>
          </p>
          <p>Face status: <span className="font-semibold">{faceStatus}</span></p>
          <p>RPS: <span className="font-semibold">{requestsPerSecond}</span></p>
          <p>Visibility: <span className="font-semibold">{pageVisible ? "Visible" : "Hidden"}</span></p>
          <p>Threshold: <span className="font-semibold">{threshold.toFixed(2)}</span></p>
        </div>

        <p className="mt-2 text-slate-300">{statusMessage}</p>

        {errorMessage ? <p className="mt-2 text-red-300">Error: {errorMessage}</p> : null}

        <button
          type="button"
          onClick={() => setDebug((v) => !v)}
          className="mt-3 rounded-md border border-white/20 px-3 py-1 text-xs"
        >
          {debug ? "Hide Debug" : "Show Debug"}
        </button>

        {debug ? (
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/40 p-2 text-xs">
            {JSON.stringify(lastBackendResponse, null, 2)}
          </pre>
        ) : null}
      </div>

      {timedOut ? (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/15 p-4 text-amber-100">
          No match found.
        </div>
      ) : null}

      {result ? (
        <div className="rounded-2xl border border-emerald-400/40 bg-emerald-500/15 p-4 text-slate-50">
          <h3 className="text-lg font-semibold">Recognized</h3>
          <p>Name: {result.match}</p>
          <p>Confidence: {result.confidence !== null ? result.confidence.toFixed(4) : "-"}</p>
          <p>Distance: {result.distance !== null ? result.distance.toFixed(4) : "-"}</p>
          <p>
            Liveness: {result.livenessLabel} ({result.livenessScore.toFixed(3)})
          </p>
          <img src={result.snapshotUrl} alt="Recognized snapshot" className="mt-3 w-full rounded-xl border border-white/20" />
        </div>
      ) : null}
    </div>
  );
}
