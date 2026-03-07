# geo.py
import math
from dataclasses import dataclass

# Earth radius in meters
EARTH_RADIUS_M = 6371000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Returns distance in meters between two lat/lng points using the Haversine formula.
    """
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
    effective_distance_m: float | None = None
    reason: str | None = None


def is_accuracy_ok(accuracy_m: float, max_allowed_accuracy_m: float = 30.0) -> bool:
    """
    True if the GPS reading is accurate enough.
    Typical phone GPS accuracy:
      - Outdoors: ~5-20m
      - Indoors: 20m-200m+
    """
    try:
        return float(accuracy_m) <= float(max_allowed_accuracy_m)
    except Exception:
        return False


def geofence_check(
    user_lat: float,
    user_lng: float,
    event_lat: float,
    event_lng: float,
    radius_m: float,
    accuracy_m: float | None = None,
    max_allowed_accuracy_m: float = 30.0,
    require_accuracy: bool = False,
) -> GeoCheckResult:
    """
    Checks if user is inside a circular geofence.
    Optionally checks GPS accuracy (recommended).
    """
    if require_accuracy and accuracy_m is None:
        return GeoCheckResult(
            ok=False,
            distance_m=0.0,
            radius_m=float(radius_m),
            effective_distance_m=None,
            reason="gps_accuracy_missing",
        )

    normalized_accuracy: float | None = None
    if accuracy_m is not None:
        try:
            normalized_accuracy = float(accuracy_m)
        except Exception:
            return GeoCheckResult(
                ok=False,
                distance_m=0.0,
                radius_m=float(radius_m),
                effective_distance_m=None,
                reason="gps_accuracy_invalid",
            )

        if not math.isfinite(normalized_accuracy) or normalized_accuracy <= 0:
            return GeoCheckResult(
                ok=False,
                distance_m=0.0,
                radius_m=float(radius_m),
                effective_distance_m=None,
                reason="gps_accuracy_invalid",
            )

        if not is_accuracy_ok(accuracy_m, max_allowed_accuracy_m):
            return GeoCheckResult(
                ok=False,
                distance_m=0.0,
                radius_m=float(radius_m),
                effective_distance_m=None,
                reason=f"gps_accuracy_too_low:{normalized_accuracy:.1f}m",
            )

    dist = haversine_m(user_lat, user_lng, event_lat, event_lng)
    effective_distance = dist + normalized_accuracy if normalized_accuracy is not None else dist
    ok = effective_distance <= float(radius_m)

    reason = None
    if not ok:
        reason = "outside_geofence_with_uncertainty" if normalized_accuracy is not None else "outside_geofence"

    return GeoCheckResult(
        ok=ok,
        distance_m=float(dist),
        radius_m=float(radius_m),
        effective_distance_m=float(effective_distance),
        reason=reason,
    )
