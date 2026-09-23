"""Small geometry helpers shared by the pipeline scripts."""
from shapely.geometry import MultiPolygon, Polygon
from shapely.validation import make_valid


def polygons_only(geom):
    """Repair a geometry and keep only its polygonal parts."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    parts, stack = [], [geom]
    while stack:
        g = stack.pop()
        if g.is_empty:
            continue
        if isinstance(g, Polygon):
            parts.append(g)
        elif hasattr(g, "geoms"):
            stack.extend(g.geoms)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def round_coords(obj, precision):
    if isinstance(obj, float):
        return round(obj, precision)
    if isinstance(obj, (list, tuple)):
        return [round_coords(x, precision) for x in obj]
    return obj
