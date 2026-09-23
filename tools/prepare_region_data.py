"""
Prepares region-level HV lines, power plant, and substation data for EPM Explorer.
Clips to actual country polygon boundaries (not just bbox).

Data source: maps/worldwide.gpkg  (sibling of epm-explorer-v2, not committed to git)

Usage:
    python tools/prepare_region_data.py                    # all regions
    python tools/prepare_region_data.py --regions asean eu # specific regions only

Outputs (data-source/cache/):
    region_lines_{id}.json       -- HV segments with voltage + OSM attributes
    region_plants_{id}.json      -- power plants with fuel/capacity
    region_capacity_{id}.json    -- capacity summary per country
    region_substations_{id}.json -- HV substations
"""
import argparse
import json
import math
import sqlite3
import yaml
from pathlib import Path

from shapely.geometry import shape
from shapely.wkb import loads as wkb_loads
from shapely.ops import unary_union
from shapely.validation import make_valid

_ROOT    = Path(__file__).resolve().parents[1]
GPKG     = _ROOT.parent / "maps" / "worldwide.gpkg"
DATA_DIR = _ROOT / "data-source"
OUT_DIR  = DATA_DIR / "cache"
OUT_DIR.mkdir(parents=True, exist_ok=True)

LINE_MIN_KV    = 110_000        # fallback when a region has no min_kv in regions.yaml
LINE_TOLERANCE = 0.04
COORD_PREC     = 3

# OSM columns carried through to the map/download layer
LINE_COLUMNS = ["id", "name", "name_en", "ref", "operator", "max_voltage",
                "frequency", "circuits", "location", "construction"]

# Lines with no voltage tag are the bulk of the network in poorly-mapped countries
# (WAPP: 2,692 untagged vs 1,206 >=110 kV) but pure noise in dense ones (EU: 330k).
# Same idea as UNTAGGED_CAP for substations: keep them only where they stay countable.
UNKNOWN_KV_CAP = 15_000

# Untagged lines are dominated by tiny fragments (EAPP: 80% under 1 km, 1% carrying
# any name or operator — service drops and distribution stubs). Requiring 1 km drops
# 80% of the segments while keeping 93% of the untagged network length.
UNKNOWN_MIN_KM = 1.0


def load_regions(only=None):
    with open(DATA_DIR / "regions.yaml", encoding="utf-8") as f:
        regions = [r for r in yaml.safe_load(f)["regions"] if r["status"] == "available"]
    if only:
        regions = [r for r in regions if r["id"] in only]
    return regions


def load_region_countries(region_id):
    """The region's member polygons from its detail extract. The coarse world
    file drops islands under 0.2 deg and shifts coasts by kilometres, which
    misplaces coastal plants and loses small-island regions entirely."""
    path = DATA_DIR.parent / "public" / "data" / "geo" / "region" / f"{region_id}.geojson"
    if not path.exists():
        print(f"  {path.name} not found -- run tools/prepare_gad.py first")
        return []
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    rows, repaired = [], 0
    for feat in gj["features"]:
        p = feat["properties"]
        # Skip the areas the Bank does not attribute to a country; they carry no
        # code and belong to no region. See tools/prepare_gad.py.
        if p.get("STATUS") == "non-determined":
            continue
        iso = p.get("ISO_A3") or ""
        try:
            geom = shape(feat["geometry"])
        except Exception:
            continue
        # A few boundary polygons self-intersect, and GEOS refuses to union them
        # ("side location conflict"). make_valid repairs them while keeping the
        # area, unlike buffer(0) which can quietly swallow slivers.
        if not geom.is_valid:
            geom = make_valid(geom)
            # It can hand back a collection with 1D leftovers; only the polygonal
            # parts mean anything for a region union.
            if geom.geom_type not in ("Polygon", "MultiPolygon"):
                polys = [g for g in geom.geoms
                         if g.geom_type in ("Polygon", "MultiPolygon")]
                if not polys:
                    continue
                geom = unary_union(polys)
            repaired += 1
        rows.append({"ISO_A3": iso, "geometry": geom})
    if repaired:
        print(f"Repaired {repaired} invalid country polygon(s)")
    return rows


def _gpkg_wkb_to_shapely(raw):
    if raw is None:
        return None
    b = bytes(raw)
    if len(b) >= 8 and b[:2] == b'GP':
        flags = b[3]
        env_size = [0, 4, 6, 6, 8][(flags >> 1) & 7] if ((flags >> 1) & 7) < 5 else 0
        header_len = 8 + env_size * 8
        wkb = b[header_len:]
    else:
        wkb = b
    try:
        return wkb_loads(wkb)
    except Exception:
        return None


def _gpkg_query(table, bbox, columns):
    minx, miny, maxx, maxy = bbox
    conn = sqlite3.connect(str(GPKG))
    try:
        cur = conn.execute(f"PRAGMA table_info({table})")
        cols_info = cur.fetchall()
        geom_col = "geom"
        for ci in cols_info:
            if ci[2].upper() in ("GEOMETRY", "MULTILINESTRING", "LINESTRING", "POINT",
                                  "MULTIPOLYGON", "POLYGON", "BLOB") or "geom" in ci[1].lower():
                geom_col = ci[1]
                break

        idx_table = f"rtree_{table}_{geom_col}"
        try:
            conn.execute(f"SELECT 1 FROM {idx_table} LIMIT 1")
            has_rtree = True
        except Exception:
            has_rtree = False

        sel_cols = ", ".join([f"t.{c}" for c in columns] + [f"t.{geom_col}"])
        if has_rtree:
            sql = (f"SELECT {sel_cols} FROM {table} t "
                   f"JOIN {idx_table} r ON t.fid=r.id "
                   f"WHERE r.minx<={maxx} AND r.maxx>={minx} "
                   f"AND r.miny<={maxy} AND r.maxy>={miny}")
        else:
            sql = f"SELECT {sel_cols} FROM {table}"

        cur = conn.execute(sql)
        rows = []
        for row in cur.fetchall():
            d = {col: row[i] for i, col in enumerate(columns)}
            d["geometry"] = _gpkg_wkb_to_shapely(row[len(columns)])
            rows.append(d)
        return rows
    finally:
        conn.close()


def _geom_to_segments(geom):
    if geom is None or geom.is_empty:
        return
    if geom.geom_type == "LineString":
        yield list(geom.coords)
    elif geom.geom_type == "MultiLineString":
        for part in geom.geoms:
            yield list(part.coords)


def _segment_km(coords):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        mid_lat = math.radians((y1 + y2) / 2)
        total += math.hypot((x2 - x1) * 111 * math.cos(mid_lat), (y2 - y1) * 111)
    return total


def _line_attrs(row):
    """OSM tags worth showing on hover / carrying into the download. Empties are
    dropped so sparsely-tagged regions pay almost nothing for them."""
    attrs = {}
    name = (row.get("name") or row.get("name_en") or row.get("ref") or "").strip()
    if name:
        attrs["nm"] = name
    operator = (row.get("operator") or "").strip()
    if operator:
        attrs["op"] = operator
    circuits = row.get("circuits")
    if circuits:
        try:
            attrs["c"] = int(circuits)
        except (ValueError, TypeError):
            pass
    freq = (row.get("frequency") or "").strip()
    if freq:
        attrs["f"] = freq                      # "0" = DC link
    location = (row.get("location") or "").strip()
    if location and location != "overhead":    # overhead is 95% of rows — implied by absence
        attrs["l"] = location
    if (row.get("construction") or "").strip():
        attrs["st"] = "construction"
    osm_id = row.get("id")
    if osm_id:
        attrs["oid"] = int(osm_id)
    return attrs


def build_lines(region_id, region_union, min_kv=LINE_MIN_KV):
    bbox = region_union.bounds
    print(f"  Lines: reading GPKG...")
    rows = _gpkg_query("power_line", bbox, LINE_COLUMNS)

    tagged  = [r for r in rows if r.get("max_voltage") is not None
               and r["max_voltage"] >= min_kv]
    unknown = [r for r in rows if r.get("max_voltage") is None]
    print(f"  {len(tagged):,} lines >= {min_kv//1000} kV in bbox "
          f"({len(unknown):,} with no voltage tag)")

    def clip_to_segments(rows_in):
        out_segments = []
        for row in rows_in:
            geom = row["geometry"]
            if geom is None or geom.is_empty:
                continue
            try:
                clipped = geom.intersection(region_union)
            except Exception:
                continue
            if clipped.is_empty:
                continue
            simplified = clipped.simplify(LINE_TOLERANCE, preserve_topology=False)
            if simplified is None or simplified.is_empty:
                continue
            v     = int(row.get("max_voltage") or 0)   # 0 = voltage unknown
            attrs = _line_attrs(row)
            for coords in _geom_to_segments(simplified):
                lats = [round(y, COORD_PREC) for x, y in coords]
                lons = [round(x, COORD_PREC) for x, y in coords]
                # Rounding to ~110 m makes neighbouring vertices coincide. Drop the
                # duplicates, and the whole segment when a single point is all that
                # survives (10% of EAPP's): invisible on the map, but dead weight in
                # the file and in every download made from it.
                keep = [i for i in range(len(lats))
                        if i == 0 or (lats[i], lons[i]) != (lats[i - 1], lons[i - 1])]
                if len(keep) < 2:
                    continue
                out_segments.append({
                    "v":    v,
                    "lats": [lats[i] for i in keep],
                    "lons": [lons[i] for i in keep],
                    **attrs,
                })
        return out_segments

    segments = clip_to_segments(tagged)
    # Cap the untagged ones on the post-clip count: a region bbox drags in whole
    # neighbouring countries (EAPP's reaches into Arabia), so the bbox count is
    # no measure of how well the region itself is mapped.
    unknown_segments = [
        seg for seg in clip_to_segments(unknown)
        if _segment_km(list(zip(seg["lons"], seg["lats"]))) >= UNKNOWN_MIN_KM
    ]
    if len(unknown_segments) > UNKNOWN_KV_CAP:
        print(f"  Dropping {len(unknown_segments):,} untagged segments — "
              f"well-mapped region, over the {UNKNOWN_KV_CAP:,} cap")
    else:
        print(f"  Keeping {len(unknown_segments):,} untagged segments")
        segments += unknown_segments

    print(f"  {len(segments):,} segments after clip")
    out = OUT_DIR / f"region_lines_{region_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"segments": segments}, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(segments):,} segments)")


def build_plants(region_id, region_union, region_countries):
    bbox = region_union.bounds
    print(f"  Plants: reading GPKG...")
    try:
        rows = _gpkg_query("power_plant", bbox, ["name", "name_en", "source", "output"])
    except Exception as e:
        print(f"  Warning: {e}")
        return
    print(f"  {len(rows):,} plants in bbox")

    region_buf = region_union.buffer(0.05)
    plants_in = []
    for row in rows:
        g = row["geometry"]
        if g is None or g.is_empty:
            continue
        pt = g.centroid if g.geom_type != "Point" else g
        try:
            if pt.within(region_buf):
                plants_in.append((row, pt))
        except Exception:
            pass
    print(f"  {len(plants_in):,} plants within region")

    def find_country(pt):
        for c in region_countries:
            try:
                if c["geometry"].contains(pt):
                    return c["ISO_A3"]
            except Exception:
                pass
        return None

    print(f"  Assigning country ISO...")
    plants = []
    capacity = {}
    for row, pt in plants_in:
        mw = None
        if row.get("output") is not None:
            try:
                mw = round(float(row["output"]) / 1000, 1)
            except (ValueError, TypeError):
                pass
        country = find_country(pt)
        fuel = str(row.get("source") or "").strip() or "unknown"
        plants.append({
            "lat":     round(pt.y, COORD_PREC),
            "lon":     round(pt.x, COORD_PREC),
            "name":    str(row.get("name") or row.get("name_en") or "").strip(),
            "fuel":    fuel,
            "mw":      mw,
            "country": country,
        })
        if country and mw and mw > 0:
            fuel_key = fuel.split(";")[0].strip().lower()
            capacity.setdefault(country, {})
            capacity[country][fuel_key] = round(
                capacity[country].get(fuel_key, 0) + mw, 1
            )

    out = OUT_DIR / f"region_plants_{region_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(plants, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(plants):,} plants)")

    out_cap = OUT_DIR / f"region_capacity_{region_id}.json"
    with open(out_cap, "w", encoding="utf-8") as f:
        json.dump({"countries": capacity}, f, separators=(",", ":"))
    print(f"  Saved {out_cap.name}")


def build_substations(region_id, region_union):
    bbox = region_union.bounds
    print(f"  Substations: reading GPKG...")
    try:
        rows = _gpkg_query("power_substation_point", bbox, ["name", "name_en", "max_voltage"])
    except Exception as e:
        print(f"  Warning: {e}")
        return
    region_buf = region_union.buffer(0.02)
    tagged, untagged = [], []
    for row in rows:
        v_raw = row.get("max_voltage")
        try:
            v = int(v_raw) if v_raw is not None else 0
        except (ValueError, TypeError):
            v = 0
        # Skip explicitly low-voltage substations
        if 0 < v < 110_000:
            continue
        geom = row["geometry"]
        if geom is None or geom.is_empty:
            continue
        try:
            if not geom.within(region_buf):
                continue
        except Exception:
            continue
        entry = {
            "lat":  round(geom.y, COORD_PREC),
            "lon":  round(geom.x, COORD_PREC),
            "name": str(row.get("name") or row.get("name_en") or "").strip(),
            "v":    v,
        }
        (tagged if v >= 110_000 else untagged).append(entry)

    # In densely mapped regions (EU etc.) untagged points are mostly distribution boxes;
    # use tagged-only when the combined count would exceed the cap.
    UNTAGGED_CAP = 3_000
    if len(tagged) + len(untagged) > UNTAGGED_CAP:
        subs = tagged
        print(f"  {len(tagged):,} tagged substations >=110 kV (dropped {len(untagged):,} untagged — well-mapped region)")
    else:
        subs = tagged + untagged
        print(f"  {len(subs):,} substations (>=110 kV or untagged) within region")
    out = OUT_DIR / f"region_substations_{region_id}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(subs, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  Saved {out.name}  ({out.stat().st_size/1024:.0f} KB, {len(subs):,} substations)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--regions", nargs="+", metavar="ID",
                        help="Only process these region IDs (e.g. --regions asean eu)")
    parser.add_argument("--layers", nargs="+", default=["lines", "plants", "subs"],
                        choices=["lines", "plants", "subs"],
                        help="Only rebuild these layers (default: all three). The GPKG "
                             "moves faster than the committed cache, so rebuilding "
                             "everything mixes unrelated data changes into one commit.")
    args = parser.parse_args()

    if not GPKG.exists():
        print(f"ERROR: worldwide.gpkg not found at {GPKG}")
        raise SystemExit(1)

    regions = load_regions(only=set(args.regions) if args.regions else None)

    for region in regions:
        print(f"\n=== {region['name']} ({region['id']}) ===")
        region_countries = load_region_countries(region["id"])
        if not region_countries:
            print("  No matching countries, skipping")
            continue
        region_union = unary_union([c["geometry"] for c in region_countries])
        if "lines" in args.layers:
            build_lines(region["id"], region_union, region.get("min_kv", LINE_MIN_KV))
        if "plants" in args.layers:
            build_plants(region["id"], region_union, region_countries)
        if "subs" in args.layers:
            build_substations(region["id"], region_union)

    print("\nDone.")
