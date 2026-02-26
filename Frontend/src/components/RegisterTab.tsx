import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CameraFeed, { CameraFeedHandle, CameraStats } from "./CameraFeed";
import { ApiError, checkLiveness, registerFace } from "../services/api";

type RegisterResult = {
  name: string;
  livenessLabel: string;
  livenessScore: number;
  message: string;
  snapshotUrl: string;
};

function isMultipleFaceError(detail: string): boolean {
  const d = detail.toLowerCase();
  return d.includes("exactly 1 face") || d.includes("multiple faces");
}

export default function RegisterTab() {
  const cameraRef = useRef<CameraFeedHandle | null>(null);
  const registerInFlightRef = useRef(false);

  const [name, setName] = useState("");
  const [scanActive, setScanActive] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [faceStatus, setFaceStatus] = useState("No face");
  const [scanStatus, setScanStatus] = useState("Paused");
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [stableCount, setStableCount] = useState(0);
  const [stableFramesRequired, setStableFramesRequired] = useState(3);
  const [minLivenessScore, setMinLivenessScore] = useState(0.85);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [requestsPerSecond, setRequestsPerSecond] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [lastBackendResponse, setLastBackendResponse] = useState<unknown>(null);

  useEffect(() => {
    return () => {
      if (result?.snapshotUrl) {
        URL.revokeObjectURL(result.snapshotUrl);
      }
    };
  }, [result]);

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

  const resetForStart = useCallback(() => {
    setErrorMessage(null);
    setResult(null);
    setStableCount(0);
    setFaceStatus("No face");
    setStatusMessage("Scanning for a stable real face...");
    setScanStatus("Scanning");
  }, []);

  const startRegister = useCallback(() => {
    if (!name.trim()) {
      setErrorMessage("Name is required before starting register.");
      return;
    }
    resetForStart();
    setScanActive(true);
  }, [name, resetForStart]);

  const registerFromFrame = useCallback(
    async (blob: Blob) => {
      const safeName = name.trim();
      if (!safeName || registerInFlightRef.current) {
        return;
      }

      registerInFlightRef.current = true;
      try {
        const response = await registerFace(safeName, blob);
        setLastBackendResponse(response);

        const snapshotUrl = URL.createObjectURL(blob);
        setResult({
          name: safeName,
          message: response.message,
          livenessLabel: response.liveness.label,
          livenessScore: response.liveness.score,
          snapshotUrl,
        });

        setScanActive(false);
        setScanStatus("Success");
        setStatusMessage("Registration success.");
        cameraRef.current?.stopCamera();
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.isNetworkError) {
            throw error;
          }
          if (error.status === 403) {
            setFaceStatus("Fake face");
            setStatusMessage(`Spoof warning: ${error.detail}`);
            setStableCount(0);
            return;
          }
          setErrorMessage(error.detail);
          return;
        }
        setErrorMessage("Unexpected register error.");
      } finally {
        registerInFlightRef.current = false;
      }
    },
    [name],
  );

  const onFrame = useCallback(
    async (blob: Blob) => {
      const liveness = await checkLiveness(blob);
      setLastBackendResponse(liveness);

      if (liveness.label === "Real" && liveness.score >= minLivenessScore) {
        setFaceStatus("Real face");
        setStatusMessage(`Stable frame ${stableCount + 1}/${stableFramesRequired}`);

        const nextCount = stableCount + 1;
        setStableCount(nextCount);

        if (nextCount >= stableFramesRequired) {
          await registerFromFrame(blob);
        }
        return;
      }

      setStableCount(0);
      setFaceStatus("Fake face");
      setStatusMessage(`Spoof / low liveness (${liveness.label}, ${liveness.score.toFixed(3)})`);
    },
    [minLivenessScore, registerFromFrame, stableCount, stableFramesRequired],
  );

  const handleFrame = useCallback(
    async (blob: Blob) => {
      try {
        await onFrame(blob);
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
              setStatusMessage("Multiple faces detected. Keep only one face in view.");
            } else if (detail.toLowerCase().includes("no face")) {
              setFaceStatus("No face");
              setStatusMessage("No face detected. Center your face in frame.");
            } else {
              setStatusMessage(detail);
            }
            setStableCount(0);
            return;
          }

          setErrorMessage(error.detail);
          return;
        }

        if (error instanceof Error) {
          setErrorMessage(error.message);
          return;
        }

        setErrorMessage("Unknown error while scanning.");
      }
    },
    [onFrame],
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
        <label className="mb-2 block text-sm font-semibold text-slate-100">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter person name"
          className="w-full rounded-lg border border-white/20 bg-slate-950/70 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 placeholder:text-slate-400 focus:ring"
        />

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-200">
          <label className="space-y-1">
            <span>Stable Frames</span>
            <select
              value={stableFramesRequired}
              onChange={(e) => setStableFramesRequired(Number(e.target.value))}
              className="w-full rounded-lg border border-white/20 bg-slate-950/70 px-2 py-2"
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label className="space-y-1">
            <span>Min Liveness ({minLivenessScore.toFixed(2)})</span>
            <input
              type="range"
              min={0.7}
              max={0.95}
              step={0.01}
              value={minLivenessScore}
              onChange={(e) => setMinLivenessScore(Number(e.target.value))}
              className="w-full"
            />
          </label>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={startRegister}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950"
          >
            Start Register
          </button>
          <button
            type="button"
            onClick={() => {
              setScanActive(false);
              setScanStatus("Paused");
              setStatusMessage("Registration paused.");
            }}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-100"
          >
            Pause
          </button>
          {result ? (
            <button
              type="button"
              onClick={() => {
                if (result.snapshotUrl) {
                  URL.revokeObjectURL(result.snapshotUrl);
                }
                setResult(null);
                setScanStatus("Paused");
                setStatusMessage("Ready");
                setStableCount(0);
              }}
              className="rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-4 py-2 text-sm text-emerald-100"
            >
              Register Again
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
          <p>Stable: <span className="font-semibold">{stableCount}/{stableFramesRequired}</span></p>
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

      {result ? (
        <div className="rounded-2xl border border-emerald-400/40 bg-emerald-500/15 p-4 text-slate-50">
          <h3 className="text-lg font-semibold">Registered</h3>
          <p>Name: {result.name}</p>
          <p>Message: {result.message}</p>
          <p>
            Liveness: {result.livenessLabel} ({result.livenessScore.toFixed(3)})
          </p>
          <img src={result.snapshotUrl} alt="Registered snapshot" className="mt-3 w-full rounded-xl border border-white/20" />
        </div>
      ) : null}
    </div>
  );
}
