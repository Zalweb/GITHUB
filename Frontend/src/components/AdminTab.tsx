import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  AttendanceRecord,
  EventRecord,
  FaceRecord,
  createEvent,
  deleteEvent,
  deleteFace,
  listAttendance,
  listEvents,
  listFaces,
  setEventActive,
} from "../services/api";

export default function AdminTab() {
  const [faces, setFaces] = useState<FaceRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventName, setEventName] = useState("");
  const [eventLat, setEventLat] = useState("");
  const [eventLng, setEventLng] = useState("");
  const [eventRadius, setEventRadius] = useState("50");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [faceData, eventData, attendanceData] = await Promise.all([listFaces(), listEvents(), listAttendance()]);
      setFaces(faceData);
      setEvents(eventData);
      setAttendance(attendanceData.slice(0, 20));
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to load admin data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await deleteFace(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to delete face.");
    }
  }, [load]);

  const handleCreateEvent = useCallback(async () => {
    if (!eventName.trim()) {
      setError("Event name is required.");
      return;
    }

    const lat = Number(eventLat);
    const lng = Number(eventLng);
    const radius = Number(eventRadius);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
      setError("Event lat/lng/radius must be valid numbers.");
      return;
    }

    try {
      setError(null);
      await createEvent(eventName.trim(), lat, lng, radius);
      setEventName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to create event.");
    }
  }, [eventLat, eventLng, eventName, eventRadius, load]);

  const handleToggleEvent = useCallback(async (event: EventRecord) => {
    try {
      await setEventActive(event.id, !event.is_active);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to toggle event.");
    }
  }, [load]);

  const handleDeleteEvent = useCallback(async (eventId: number) => {
    try {
      await deleteEvent(eventId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to delete event.");
    }
  }, [load]);

  const attendancePreview = useMemo(() => attendance.slice(0, 10), [attendance]);

  return (
    <div className="space-y-4 rounded-2xl border border-white/15 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">Admin</h2>
        <button
          type="button"
          onClick={() => load().catch(() => undefined)}
          className="rounded-lg border border-white/20 px-3 py-1 text-sm text-slate-100"
        >
          Refresh
        </button>
      </div>

      {loading ? <p className="text-sm text-slate-300">Loading...</p> : null}
      {error ? <p className="text-sm text-red-300">Error: {error}</p> : null}

      <div className="rounded-xl border border-white/10 bg-black/20 p-3">
        <h3 className="mb-3 text-sm font-semibold text-slate-100">Create Event</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            placeholder="Event name"
            className="rounded-lg border border-white/20 bg-slate-950/70 px-3 py-2 text-sm text-slate-100"
          />
          <input
            value={eventRadius}
            onChange={(e) => setEventRadius(e.target.value)}
            placeholder="Radius meters"
            className="rounded-lg border border-white/20 bg-slate-950/70 px-3 py-2 text-sm text-slate-100"
          />
          <input
            value={eventLat}
            onChange={(e) => setEventLat(e.target.value)}
            placeholder="Latitude"
            className="rounded-lg border border-white/20 bg-slate-950/70 px-3 py-2 text-sm text-slate-100"
          />
          <input
            value={eventLng}
            onChange={(e) => setEventLng(e.target.value)}
            placeholder="Longitude"
            className="rounded-lg border border-white/20 bg-slate-950/70 px-3 py-2 text-sm text-slate-100"
          />
        </div>
        <button
          type="button"
          onClick={() => handleCreateEvent().catch(() => undefined)}
          className="mt-3 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950"
        >
          Create Event
        </button>
      </div>

      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <h3 className="text-sm font-semibold text-slate-100">Events</h3>
        {events.map((event) => (
          <div key={event.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-3">
            <div>
              <p className="text-sm font-semibold text-slate-100">{event.name}</p>
              <p className="text-xs text-slate-400">
                #{event.id} | {event.lat.toFixed(5)}, {event.lng.toFixed(5)} | r={event.radius_m}m
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleToggleEvent(event).catch(() => undefined)}
                className="rounded-md border border-amber-400/40 bg-amber-500/20 px-2 py-1 text-xs text-amber-100"
              >
                {event.is_active ? "Deactivate" : "Activate"}
              </button>
              <button
                type="button"
                onClick={() => handleDeleteEvent(event.id).catch(() => undefined)}
                className="rounded-md border border-red-400/40 bg-red-500/20 px-2 py-1 text-xs text-red-100"
              >
                Delete
              </button>
            </div>
          </div>
        ))}

        {!loading && events.length === 0 ? <p className="text-sm text-slate-300">No events yet.</p> : null}
      </div>

      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <h3 className="text-sm font-semibold text-slate-100">Registered Faces</h3>
        {faces.map((face) => (
          <div key={face.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-3">
            <div>
              <p className="text-sm font-semibold text-slate-100">{face.name}</p>
              <p className="text-xs text-slate-400">ID: {face.id}</p>
            </div>
            <button
              type="button"
              onClick={() => handleDelete(face.id).catch(() => undefined)}
              className="rounded-md border border-red-400/40 bg-red-500/20 px-3 py-1 text-xs text-red-100"
            >
              Delete
            </button>
          </div>
        ))}

        {!loading && faces.length === 0 ? <p className="text-sm text-slate-300">No faces registered yet.</p> : null}
      </div>

      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <h3 className="text-sm font-semibold text-slate-100">Recent Attendance</h3>
        {attendancePreview.map((row) => (
          <div key={row.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="text-sm font-semibold text-slate-100">{row.person_name}</p>
            <p className="text-xs text-slate-400">
              event #{row.event_id} | distance {row.distance_m.toFixed(1)}m | liveness {row.liveness_label}{" "}
              {row.liveness_score.toFixed(3)}
            </p>
            <p className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString()}</p>
          </div>
        ))}
        {!loading && attendancePreview.length === 0 ? <p className="text-sm text-slate-300">No attendance yet.</p> : null}
      </div>
    </div>
  );
}
