import math
from dataclasses import dataclass

EARTH_RADIUS_M = 6371000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2) + math.cos(phi1) * math.cos(phi2) * (math.sin(dlambda / 2) ** 2)
    c = 2 * math.asin(math.sqrt(a))
    return EARTH_RADIUS_M * c


@dataclass
class GeoCheckResult:
    ok: bool
    distance_m: float
    radius_m: float
    reason: str | None = None


def geofence_check(
    user_lat: float,
    user_lng: float,
    event_lat: float,
    event_lng: float,
    radius_m: float,
    accuracy_m: float | None = None,
    max_allowed_accuracy_m: float = 30.0,
) -> GeoCheckResult:
    if accuracy_m is not None and float(accuracy_m) > float(max_allowed_accuracy_m):
        return GeoCheckResult(
            ok=False,
            distance_m=0.0,
            radius_m=float(radius_m),
            reason=f"gps_accuracy_too_low:{float(accuracy_m):.1f}m",
        )

    dist = haversine_m(user_lat, user_lng, event_lat, event_lng)
    ok = dist <= float(radius_m)

    return GeoCheckResult(
        ok=ok,
        distance_m=float(dist),
        radius_m=float(radius_m),
        reason=None if ok else "outside_geofence",
    )
