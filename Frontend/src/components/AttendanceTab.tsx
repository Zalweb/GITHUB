import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CameraFeed, { CameraFeedHandle, CameraStats } from "./CameraFeed";
import {
  ApiError,
  AttendanceCheckinResponse,
  EventRecord,
  attendanceCheckin,
  listEvents,
} from "../services/api";

type BrowserLocation = {
  lat: number;
  lng: number;
  accuracy_m?: number;
  at: string;
};

type CheckinResult = {
  eventName: string;
  match: string;
  distanceFace: number;
  geoDistance: number;
  geoRadius: number;
  livenessLabel: string;
  livenessScore: number;
  createdAt: string;
  snapshotUrl: string;
};

const MAX_ALLOWED_ACCURACY_M = Number(import.meta.env.VITE_MAX_ALLOWED_ACCURACY_M ?? 30);

function resolveStageMessage(res: AttendanceCheckinResponse): string {
  if (res.stage === "liveness") {
    return "Spoof / low liveness. Keep scanning.";
  }
  if (res.stage === "recognize") {
    return res.message ?? "No match yet...";
  }
  if (res.stage === "geofence") {
    const reason = res.geo?.reason ?? "outside_geofence";
    if (reason === "gps_accuracy_missing") {
      return "GPS accuracy is required. Refresh location and try again.";
    }
    if (reason === "gps_accuracy_invalid") {
      return "Invalid GPS accuracy reading. Refresh location.";
    }
    if (reason.startsWith("gps_accuracy_too_low")) {
      return `GPS accuracy too low (${reason.split(":")[1]}). Refresh location.`;
    }
    if (reason.startsWith("implausible_travel_speed")) {
      return "Location jump detected. Mock/fake GPS suspected.";
    }
    if (reason === "outside_geofence_with_uncertainty") {
      return "Face matched, but location confidence is outside geofence.";
    }
    return "Face matched, but outside event geofence.";
  }
  return "Check-in success.";
}

function resolveGeoStatus(reason?: string): string {
  if (!reason) {
    return "Outside geofence";
  }
  if (reason === "gps_accuracy_missing" || reason === "gps_accuracy_invalid") {
    return "GPS invalid";
  }
  if (reason.startsWith("gps_accuracy_too_low")) {
    return "GPS too weak";
  }
  if (reason.startsWith("implausible_travel_speed")) {
    return "GPS spoof suspected";
  }
  if (reason === "outside_geofence_with_uncertainty") {
    return "Outside (uncertain GPS)";
  }
  return "Outside geofence";
}

function readGeoPosition(): Promise<BrowserLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          at: new Date().toISOString(),
        });
      },
      (err) => reject(new Error(err.message || "Failed to get GPS location.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 3000 },
    );
  });
}

export default function AttendanceTab() {
  const cameraRef = useRef<CameraFeedHandle | null>(null);

  const [events, setEvents] = useState<EventRecord[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [location, setLocation] = useState<BrowserLocation | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [scanActive, setScanActive] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [faceStatus, setFaceStatus] = useState("No face");
  const [geoStatus, setGeoStatus] = useState("Unknown");
  const [scanStatus, setScanStatus] = useState("Paused");
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [requestsPerSecond, setRequestsPerSecond] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [lastBackendResponse, setLastBackendResponse] = useState<unknown>(null);
  const [result, setResult] = useState<CheckinResult | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  const locationAccuracy = location?.accuracy_m;
  const locationAccuracyOk =
    typeof locationAccuracy === "number" && Number.isFinite(locationAccuracy) && locationAccuracy <= MAX_ALLOWED_ACCURACY_M;

  const loadEvents = useCallback(async () => {
    try {
      const data = await listEvents();
      setEvents(data);
      if (data.length > 0 && selectedEventId === null) {
        setSelectedEventId(data[0].id);
      }
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.detail : "Failed to load events.");
    }
  }, [selectedEventId]);

  const refreshLocation = useCallback(async (): Promise<BrowserLocation | null> => {
    setLocationLoading(true);
    setErrorMessage(null);
    try {
      const loc = await readGeoPosition();
      setLocation(loc);
      if (typeof loc.accuracy_m === "number" && loc.accuracy_m <= MAX_ALLOWED_ACCURACY_M) {
        setGeoStatus("Location ready");
      } else {
        setGeoStatus("GPS too weak");
      }
      return loc;
    } catch (error) {
      setGeoStatus("Location unavailable");
      setErrorMessage(error instanceof Error ? error.message : "Failed to fetch location.");
      return null;
    } finally {
      setLocationLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents().catch(() => undefined);
    refreshLocation().catch(() => undefined);
  }, [loadEvents, refreshLocation]);

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
      setTimedOut(true);
      setScanActive(false);
      setScanStatus("Paused");
      setStatusMessage("No successful check-in within 20 seconds.");
    }, 20000);

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

  const startCheckin = useCallback(async () => {
    if (!selectedEventId) {
      setErrorMessage("Select an event first.");
      return;
    }

    setErrorMessage(null);
    setTimedOut(false);
    setResult(null);
    setFaceStatus("No face");
    setGeoStatus("Checking location...");
    setScanStatus("Scanning");
    setStatusMessage("Scanning for liveness + match + geofence...");

    let currentLocation = location;
    if (!currentLocation) {
      currentLocation = await refreshLocation();
      if (!currentLocation) {
        setScanStatus("Paused");
        setStatusMessage("Could not get location. Try Refresh GPS.");
        return;
      }
    }

    const accuracy = currentLocation.accuracy_m;
    if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy > MAX_ALLOWED_ACCURACY_M) {
      setGeoStatus("GPS too weak");
      setScanStatus("Paused");
      setStatusMessage(`GPS accuracy too low (+/-${(accuracy ?? 0).toFixed(1)}m). Need <= ${MAX_ALLOWED_ACCURACY_M}m.`);
      return;
    }

    setScanActive(true);
  }, [location, refreshLocation, selectedEventId]);

  const handleFrame = useCallback(
    async (blob: Blob) => {
      if (!selectedEventId) {
        setScanActive(false);
        setScanStatus("Paused");
        setErrorMessage("No event selected.");
        return;
      }

      if (!location) {
        setGeoStatus("Location unavailable");
        setStatusMessage("Waiting for GPS location...");
        return;
      }

      const accuracy = location.accuracy_m;
      if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy > MAX_ALLOWED_ACCURACY_M) {
        setGeoStatus("GPS too weak");
        setScanActive(false);
        setScanStatus("Paused");
        setStatusMessage(`GPS accuracy too low (+/-${(accuracy ?? 0).toFixed(1)}m). Need <= ${MAX_ALLOWED_ACCURACY_M}m.`);
        return;
      }

      try {
        const response = await attendanceCheckin(
          blob,
          {
            event_id: selectedEventId,
            lat: location.lat,
            lng: location.lng,
            accuracy_m: location.accuracy_m,
          },
          threshold,
        );
        setLastBackendResponse(response);
        setStatusMessage(resolveStageMessage(response));

        if (response.stage === "liveness") {
          setFaceStatus("Fake face");
          return;
        }

        if (response.stage === "recognize") {
          setFaceStatus("Real face");
          setGeoStatus("Waiting geofence");
          return;
        }

        if (response.stage === "geofence") {
          setFaceStatus("Real face");
          setGeoStatus(resolveGeoStatus(response.geo?.reason));
          return;
        }

        if (response.ok && response.stage === "saved") {
          const snapshotUrl = URL.createObjectURL(blob);
          setResult({
            eventName: selectedEvent?.name ?? `Event ${selectedEventId}`,
            match: response.match ?? "Unknown",
            distanceFace: response.distance_face ?? 0,
            geoDistance: response.geo?.distance_m ?? 0,
            geoRadius: response.geo?.radius_m ?? 0,
            livenessLabel: response.liveness?.label ?? "Real",
            livenessScore: response.liveness?.score ?? 0,
            createdAt: response.created_at ?? new Date().toISOString(),
            snapshotUrl,
          });
          setFaceStatus("Real face");
          setGeoStatus("Inside geofence");
          setScanStatus("Success");
          setScanActive(false);
          cameraRef.current?.stopCamera();
        }
      } catch (error) {
        if (error instanceof ApiError) {
          setLastBackendResponse({ status: error.status, detail: error.detail, data: error.data });
          if (error.isNetworkError) {
            throw error;
          }
          setErrorMessage(error.detail);
          return;
        }

        if (error instanceof Error) {
          setErrorMessage(error.message);
          return;
        }

        setErrorMessage("Unknown check-in error.");
      }
    },
    [location, selectedEvent, selectedEventId, threshold],
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
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-sm font-semibold text-slate-100">Event</span>
            <select
              value={selectedEventId ?? ""}
              onChange={(e) => setSelectedEventId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-lg border border-white/20 bg-slate-950/70 px-3 py-2 text-sm text-slate-100"
            >
              {events.length === 0 ? <option value="">No events</option> : null}
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name} ({event.is_active ? "active" : "inactive"})
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-semibold text-slate-100">Threshold: {threshold.toFixed(2)}</span>
            <input
              type="range"
              min={0.35}
              max={0.8}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full"
            />
          </label>
        </div>

        <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
          <p>
            Location:{" "}
            {location
              ? `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)} (+/-${(location.accuracy_m ?? 0).toFixed(1)}m)`
              : "not available"}
          </p>
          <p>Updated: {location ? new Date(location.at).toLocaleTimeString() : "-"}</p>
          <p className={locationAccuracyOk ? "text-emerald-300" : "text-amber-300"}>
            Accuracy check:{" "}
            {locationAccuracyOk
              ? `OK (<= ${MAX_ALLOWED_ACCURACY_M}m)`
              : `Too low. Need <= ${MAX_ALLOWED_ACCURACY_M}m`}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => startCheckin().catch(() => undefined)}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950"
          >
            Start Check-in
          </button>
          <button
            type="button"
            onClick={() => refreshLocation().catch(() => undefined)}
            className="rounded-lg border border-indigo-400/40 bg-indigo-500/20 px-4 py-2 text-sm text-indigo-100"
          >
            {locationLoading ? "Refreshing GPS..." : "Refresh GPS"}
          </button>
          <button
            type="button"
            onClick={() => {
              setScanActive(false);
              setScanStatus("Paused");
              setStatusMessage("Check-in paused.");
            }}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-100"
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => loadEvents().catch(() => undefined)}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-100"
          >
            Refresh Events
          </button>
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
          <p>Geo status: <span className="font-semibold">{geoStatus}</span></p>
          <p>RPS: <span className="font-semibold">{requestsPerSecond}</span></p>
          <p>Visibility: <span className="font-semibold">{pageVisible ? "Visible" : "Hidden"}</span></p>
        </div>

        <p className="mt-2 text-slate-300">{statusMessage}</p>
        {timedOut ? <p className="mt-2 text-amber-300">No successful check-in. Retry.</p> : null}
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
          <h3 className="text-lg font-semibold">Attendance Saved</h3>
          <p>Event: {result.eventName}</p>
          <p>Person: {result.match}</p>
          <p>Face distance: {result.distanceFace.toFixed(4)}</p>
          <p>Geo distance: {result.geoDistance.toFixed(1)}m / {result.geoRadius.toFixed(1)}m</p>
          <p>
            Liveness: {result.livenessLabel} ({result.livenessScore.toFixed(3)})
          </p>
          <p>Created: {new Date(result.createdAt).toLocaleString()}</p>
          <img src={result.snapshotUrl} alt="Check-in snapshot" className="mt-3 w-full rounded-xl border border-white/20" />
        </div>
      ) : null}
    </div>
  );
}
