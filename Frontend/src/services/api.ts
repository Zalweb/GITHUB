const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

export type LivenessResponse = { label: "Real" | "Fake"; score: number };

export type RegisterResponse = {
  message: string;
  liveness: LivenessResponse;
};

export type RecognizeResponse = {
  match: string | null;
  confidence?: number;
  distance?: number;
  message?: string;
  liveness?: LivenessResponse;
};

export type FaceRecord = { id: number; name: string };

export type EventRecord = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  is_active: boolean;
  created_at: string;
};

export type AttendanceRecord = {
  id: number;
  event_id: number;
  person_name: string;
  distance_m: number;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  liveness_label: string;
  liveness_score: number;
  created_at: string;
};

export type LocationPayload = {
  lat: number;
  lng: number;
  accuracy_m?: number;
};

export type VerifyLocationResponse = {
  ok: true;
  distance_m: number;
  radius_m: number;
};

export type CheckInPayload = {
  event_id: number;
  lat: number;
  lng: number;
  accuracy_m?: number;
};

export type AttendanceCheckinResponse = {
  ok: boolean;
  stage: "liveness" | "recognize" | "geofence" | "saved";
  match?: string | null;
  distance?: number;
  distance_face?: number;
  message?: string;
  geo?: {
    ok: boolean;
    reason?: string;
    distance_m: number;
    radius_m: number;
  };
  liveness?: LivenessResponse & { reason?: string };
  created_at?: string;
};

export class ApiError extends Error {
  status: number;
  detail: string;
  data: unknown;
  isNetworkError: boolean;

  constructor(message: string, status = 0, detail = message, data: unknown = null, isNetworkError = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.data = data;
    this.isNetworkError = isNetworkError;
  }
}

function toQuery(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => search.set(k, String(v)));
  return search.toString();
}

async function parseErrorBody(response: Response): Promise<{ detail: string; data: unknown }> {
  const text = await response.text();
  if (!text) {
    return { detail: `HTTP ${response.status}`, data: null };
  }

  try {
    const json = JSON.parse(text) as { detail?: unknown };
    let detail = text;
    if (typeof json.detail === "string") {
      detail = json.detail;
    } else if (json.detail !== undefined) {
      detail = JSON.stringify(json.detail);
    }
    return { detail, data: json };
  } catch {
    return { detail: text, data: text };
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, init);
  } catch (error) {
    throw new ApiError(
      "Network error. Check backend URL/CORS/server status.",
      0,
      error instanceof Error ? error.message : "Network error",
      error,
      true,
    );
  }

  if (!response.ok) {
    const { detail, data } = await parseErrorBody(response);
    throw new ApiError(`Request failed (${response.status})`, response.status, detail, data, false);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("Invalid JSON response from backend.", response.status, "Invalid JSON response", null, false);
  }
}

function fileFormData(blob: Blob): FormData {
  const form = new FormData();
  form.append("file", blob, "frame.jpg");
  return form;
}

function checkinFormData(blob: Blob, payload: CheckInPayload): FormData {
  const form = new FormData();
  form.append("file", blob, "frame.jpg");
  form.append("payload", JSON.stringify(payload));
  return form;
}

export async function checkLiveness(blob: Blob): Promise<LivenessResponse> {
  return request<LivenessResponse>("/liveness", {
    method: "POST",
    body: fileFormData(blob),
  });
}

export async function registerFace(name: string, blob: Blob): Promise<RegisterResponse> {
  const query = toQuery({ name });
  return request<RegisterResponse>(`/register?${query}`, {
    method: "POST",
    body: fileFormData(blob),
  });
}

export async function recognizeFace(blob: Blob, threshold: number): Promise<RecognizeResponse> {
  const query = toQuery({ threshold });
  return request<RecognizeResponse>(`/recognize?${query}`, {
    method: "POST",
    body: fileFormData(blob),
  });
}

export async function listFaces(): Promise<FaceRecord[]> {
  return request<FaceRecord[]>("/faces", { method: "GET" });
}

export async function deleteFace(id: number): Promise<{ message: string }> {
  return request<{ message: string }>(`/faces/${id}`, { method: "DELETE" });
}

export async function createEvent(name: string, lat: number, lng: number, radius_m = 50): Promise<EventRecord> {
  const query = toQuery({ name, lat, lng, radius_m });
  return request<EventRecord>(`/events?${query}`, { method: "POST" });
}

export async function listEvents(): Promise<EventRecord[]> {
  return request<EventRecord[]>("/events", { method: "GET" });
}

export async function setEventActive(eventId: number, active: boolean): Promise<{ message: string }> {
  const query = toQuery({ active: active ? 1 : 0 });
  return request<{ message: string }>(`/events/${eventId}/active?${query}`, { method: "PATCH" });
}

export async function deleteEvent(eventId: number): Promise<{ message: string }> {
  return request<{ message: string }>(`/events/${eventId}`, { method: "DELETE" });
}

export async function verifyEventLocation(eventId: number, payload: LocationPayload): Promise<VerifyLocationResponse> {
  return request<VerifyLocationResponse>(`/events/${eventId}/verify-location`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function attendanceCheckin(
  blob: Blob,
  payload: CheckInPayload,
  threshold: number,
): Promise<AttendanceCheckinResponse> {
  const query = toQuery({ threshold });
  return request<AttendanceCheckinResponse>(`/attendance/checkin?${query}`, {
    method: "POST",
    body: checkinFormData(blob, payload),
  });
}

export async function listAttendance(eventId?: number): Promise<AttendanceRecord[]> {
  const path = eventId === undefined ? "/attendance" : `/attendance?${toQuery({ event_id: eventId })}`;
  return request<AttendanceRecord[]>(path, { method: "GET" });
}

export function getApiBaseUrl(): string {
  return BASE_URL;
}
