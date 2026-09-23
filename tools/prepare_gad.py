"""Build the country / non-determined-area interaction geometry from World Bank GAD.

Source: World Bank Global Administrative Divisions (GAD), public FeatureServer
        https://services.arcgis.com/iQ1dY19aHwbSDYIF/arcgis/rest/services/
            World_Bank_Global_Administrative_Divisions/FeatureServer
        ArcGIS Online item d1b630859ed84e92a3782fed6a612b63
        layer 4, WB_GAD_ADM0_NDLSA: every admin-0 polygon (251 countries) plus
        the 24 areas the Bank draws as "Non-determined legal status area".

This is the same product the approved World Bank vector basemap
(src/constants.js WB_BASEMAP_STYLE_URL) is tiled from, so the highlight outlines
this geometry draws register with the boundary lines the basemap draws. The
previous pipeline, tools/prepare_boundaries.py, pulled the Data Catalog 10m
Admin 0 file and the internal medium-resolution GAD service, whose edges sit up
to ~2 km off the tiles; that script is kept for reference but its outputs are
no longer read by the app.

The service generalises server-side (maxAllowableOffset, in degrees) -- but only
for Esri JSON output, not f=geojson, and only down to roughly the 0.01 level --
so features are pulled as Esri JSON, converted here, and the coarse world file
gets a further Douglas-Peucker pass. Nothing here needs geopandas.

Outputs (public/data/geo/):
    world.geojson             every feature, coarse -- world and meta-region pages
    country/<ISO_A3>.geojson  one country plus the areas it is a claimant of, detail
                              -- only for countries that belong to a region, the
                              only ones with a country page
    region/<id>.geojson       a region's member countries plus its areas, detail
    bboxes.json               [minLon, minLat, maxLon, maxLat] per country and
                              region, for fitBounds -- so no page has to walk
                              geometry to frame itself

Feature properties (the contract src/utils/basemap.js and the pages rely on):
    ISO_A3     ISO 3166-1 alpha-3, the key every page joins on ("" on areas)
    WB_A3      World Bank country code
    WB_NAME    the Bank's name (NAM_0)
    WB_REGION  World Bank region
  and on the 24 areas only:
    STATUS     "non-determined"
    AREA_ID    stable slug, e.g. "aksai-chin", "jammu-and-kashmir-pak"
    CLAIMANTS  ISO_A3 codes of the parties, comma-separated, e.g. "IND,CHN".
               The map derives each area's fill from its claimants' fills --
               see ndlsaFill() in src/utils/basemap.js -- so this list is
               cartographic policy, not just metadata. See public/data/ndlsa.json.
    ADMIN      ISO_A3 of the administering party where the Bank records one
               (the two Jammu and Kashmir polygons), else absent

It also rewrites the `non_determined` list of every region in
public/data/regions.json: an area belongs to a region when any of its claimants
is a member. Those lists are keyed on WB_NAME, so they must move in lockstep
with this data.

Usage:
    python tools/prepare_gad.py                    # build everything
    python tools/prepare_gad.py --tolerance 0.002  # heavier detail geometry
    python tools/prepare_gad.py --dry-run          # fetch and report, write nothing
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

SERVICE = (
    "https://services.arcgis.com/iQ1dY19aHwbSDYIF/arcgis/rest/services/"
    "World_Bank_Global_Administrative_Divisions/FeatureServer/4/query"
)
SOURCE_NAME = "World Bank Global Administrative Divisions (GAD), layer WB_GAD_ADM0_NDLSA"
SOURCE_ITEM = "https://www.arcgis.com/home/item.html?id=d1b630859ed84e92a3782fed6a612b63"

NDLSA_STATUS = "Non-determined legal status area"
FIELDS = "FID,ISO_A3,WB_A3,WB_STATUS,SOV_ISO_A3,NAM_0,WB_REGION"

# Generalisation, in degrees of longitude at the equator (~111 km/deg).
#   0.005 ~ 550 m: Kenya 21 KB
#   0.002 ~ 220 m: Kenya 41 KB -- the default: at country-page zooms the
#                  coarser setting leaves visible slivers along coasts
# The world file only ever shows at z < 6, where 1 px is 2-10 km, so it is
# simplified far harder and loses islands smaller than a couple of pixels.
DETAIL_TOLERANCE = 0.002
WORLD_TOLERANCE = 0.08
WORLD_MIN_RING = 0.2    # drop rings whose extent is under this many degrees
PRECISION = 5           # decimal places kept, ~1 m
PAGE = 50               # features per request; geometry makes bigger pages time out

# The Bank's own code where the app's differs (regions.json, every data file).
ISO_ALIASES = {"XKX": "KOS"}

_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = _ROOT / "public" / "data"
OUT_DIR = DATA_DIR / "geo"
REGIONS_JSON = DATA_DIR / "regions.json"

# The parties to each non-determined area, keyed on the Bank's NAM_0, from
# public/data/ndlsa.json -- the one table both this script and the app read.
# It drives which regions an area appears in (here) and what colour it takes
# (src/utils/basemap.js). Every entry is a policy statement; see the file.
NDLSA_JSON = DATA_DIR / "ndlsa.json"
CLAIMANTS = {name: a["claimants"]
             for name, a in json.loads(NDLSA_JSON.read_text(encoding="utf-8"))["areas"].items()}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def query(params):
    url = SERVICE + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                data = json.load(r)
            if "error" in data:
                raise RuntimeError(data["error"])
            return data
        except Exception as e:          # noqa: BLE001 -- retry anything transient
            if attempt == 3:
                raise
            log(f"  retry {attempt + 1}: {e}")
            time.sleep(2 * (attempt + 1))


def fetch_layer(tolerance):
    """Every feature of layer 4 as GeoJSON, generalised to `tolerance` degrees."""
    feats = []
    offset = 0
    while True:
        data = query({
            "where": "1=1", "outFields": FIELDS, "f": "json", "outSR": 4326,
            "orderByFields": "FID", "resultOffset": offset, "resultRecordCount": PAGE,
            "geometryPrecision": PRECISION, "maxAllowableOffset": tolerance,
        })
        batch = data.get("features", [])
        feats.extend({"type": "Feature", "properties": f["attributes"],
                      "geometry": rings_to_geojson(f["geometry"]["rings"])} for f in batch)
        log(f"  {len(feats)} features")
        if not batch or (len(batch) < PAGE and not data.get("exceededTransferLimit")):
            break
        offset += len(batch)
    return feats


def ring_area(ring):
    """Signed shoelace area in square degrees: negative is clockwise, the Esri
    convention for an outer ring. Only ever compared, never reported."""
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def rings_to_geojson(rings):
    """Esri JSON rings (outer clockwise, holes counter-clockwise, in one flat
    list) to a GeoJSON MultiPolygon with each hole attached to the outer ring
    that contains it."""
    outers, holes = [], []
    for ring in rings:
        if len(ring) < 4:
            continue
        (holes if ring_area(ring) > 0 else outers).append(ring)
    polys = [[o] for o in outers]
    for h in holes:
        for poly in polys:
            if point_in_ring(h[0], poly[0]):
                poly.append(h)
                break
    return {"type": "MultiPolygon", "coordinates": polys}


def simplify_ring(ring, tolerance):
    """Douglas-Peucker on a closed ring; keeps the closing vertex."""
    pts = ring[:-1]
    if len(pts) < 4:
        return ring
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, best_i = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = (abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm
                 else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5)
            if d > best:
                best, best_i = d, i
        if best > tolerance:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    out = [p for p, k in zip(pts, keep) if k]
    return out + [out[0]]


def ring_extent(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def simplify_feature(feature, tolerance, min_ring):
    """Coarsen a feature for the world file. Drops rings (islands, lakes)
    smaller than `min_ring` degrees across, then Douglas-Peuckers the rest.
    A feature that loses every ring keeps its largest one, so no country
    vanishes from the world map."""
    polys = polygons(feature["geometry"])
    kept = []
    for poly in polys:
        if ring_extent(poly[0]) < min_ring:
            continue
        rings = [simplify_ring(r, tolerance) for r in poly if ring_extent(r) >= min_ring]
        rings = [r for r in rings if len(r) >= 4]
        if rings:
            kept.append(rings)
    if not kept:
        biggest = max(polys, key=lambda p: abs(ring_area(p[0])))
        kept = [[simplify_ring(biggest[0], tolerance)]]
    return {"type": "Feature", "properties": feature["properties"],
            "geometry": {"type": "MultiPolygon", "coordinates": kept}}


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def clean(feature):
    """Map a service feature onto the app's property contract."""
    p = {k: (v.strip() if isinstance(v, str) else v) for k, v in feature["properties"].items()}
    name = p["NAM_0"]
    iso = ISO_ALIASES.get(p["ISO_A3"], p["ISO_A3"])
    out = {"ISO_A3": iso, "WB_A3": p["WB_A3"], "WB_NAME": name, "WB_REGION": p["WB_REGION"]}
    if p["WB_STATUS"] == NDLSA_STATUS:
        if name not in CLAIMANTS:
            raise SystemExit(f"new non-determined area in the service, add it to {NDLSA_JSON.name}: {name!r}")
        out["ISO_A3"] = ""       # areas must never match an ISO-keyed layer or click
        out["STATUS"] = "non-determined"
        out["AREA_ID"] = slug(name) + (f"-{p['SOV_ISO_A3'].lower()}" if p["SOV_ISO_A3"] else "")
        out["CLAIMANTS"] = ",".join(CLAIMANTS[name])
        if p["SOV_ISO_A3"]:
            out["ADMIN"] = p["SOV_ISO_A3"]
    return {"type": "Feature", "properties": out, "geometry": feature["geometry"]}


def is_area(f):
    return f["properties"].get("STATUS") == "non-determined"


def bbox(geometry):
    xs, ys = [], []
    for poly in polygons(geometry):
        for x, y in poly[0]:        # outer ring is enough for an extent
            xs.append(x)
            ys.append(y)
    return [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]


def union_bbox(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def collection(features):
    return {"type": "FeatureCollection", "features": features}


def write_json(path, obj, compact=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.write("\n")
    return path.stat().st_size


def polygons(geometry):
    return geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]


def merge_by_iso(countries):
    """One feature per ISO_A3.

    The service keeps dependencies that share their parent's code as their own
    polygons -- Ceuta and Melilla under ESP, Akrotiri and Dhekelia under GBR,
    Ashmore and Cartier under AUS, the three BES islands -- and every page keys
    on ISO_A3, so they are folded into one MultiPolygon named after the largest
    piece. Features without a code are reported: no page can reach them.
    """
    by_iso = defaultdict(list)
    for f in countries:
        by_iso[f["properties"]["ISO_A3"]].append(f)
    blank = [f["properties"]["WB_NAME"] for f in by_iso.pop("", [])]
    if blank:
        log(f"  WARNING {len(blank)} countries without ISO_A3 (unreachable by page): {blank}")
    merged = {}
    for iso, feats in by_iso.items():
        if len(feats) == 1:
            merged[iso] = feats[0]
            continue
        feats.sort(key=lambda f: -sum(abs(ring_area(p[0])) for p in polygons(f["geometry"])))
        log(f"  merging under {iso}: {[f['properties']['WB_NAME'] for f in feats]}")
        merged[iso] = {
            "type": "Feature",
            "properties": feats[0]["properties"],
            "geometry": {"type": "MultiPolygon",
                         "coordinates": [p for f in feats for p in polygons(f["geometry"])]},
        }
    return merged


def derive_non_determined(regions, areas):
    """Areas a region shows: those with a claimant among its members."""
    by_region = {}
    for r in regions:
        if r.get("type") == "meta":
            continue
        members = {c["iso"] for c in r.get("countries", [])}
        names = sorted({f["properties"]["WB_NAME"] for f in areas
                        if members & set(f["properties"]["CLAIMANTS"].split(","))})
        by_region[r["id"]] = names
    return by_region


def update_regions_json(regions_doc, derived, dry_run):
    changed = []
    for r in regions_doc["regions"]:
        if r["id"] not in derived:
            continue
        old = r.get("non_determined") or []
        new = derived[r["id"]]
        if old != new:
            changed.append((r["id"], old, new))
            if new:
                r["non_determined"] = new
            else:
                r.pop("non_determined", None)
    for rid, old, new in changed:
        log(f"  regions.json {rid}: {old} -> {new}")
    if changed and not dry_run:
        write_json(REGIONS_JSON, regions_doc, compact=False)
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tolerance", type=float, default=DETAIL_TOLERANCE,
                    help="maxAllowableOffset in degrees for the detail files (default %(default)s)")
    ap.add_argument("--world-tolerance", type=float, default=WORLD_TOLERANCE,
                    help="Douglas-Peucker tolerance in degrees for world.geojson (default %(default)s)")
    ap.add_argument("--world-min-ring", type=float, default=WORLD_MIN_RING,
                    help="drop rings narrower than this many degrees from world.geojson (default %(default)s)")
    ap.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    args = ap.parse_args()

    regions_doc = json.loads(REGIONS_JSON.read_text(encoding="utf-8"))
    regions = regions_doc["regions"]

    log(f"detail geometry @ {args.tolerance} deg")
    detail = [clean(f) for f in fetch_layer(args.tolerance)]

    countries = [f for f in detail if not is_area(f)]
    areas = [f for f in detail if is_area(f)]
    log(f"{len(countries)} countries, {len(areas)} non-determined areas")
    by_iso = merge_by_iso(countries)
    log(f"world geometry: Douglas-Peucker @ {args.world_tolerance} deg, rings >= {args.world_min_ring} deg")
    world = [simplify_feature(f, args.world_tolerance, args.world_min_ring)
             for f in list(by_iso.values()) + areas]
    if len(areas) != len(CLAIMANTS) + 1:      # Jammu and Kashmir is two polygons
        log(f"  WARNING expected {len(CLAIMANTS) + 1} area polygons, got {len(areas)}")

    derived = derive_non_determined(regions, areas)
    areas_by_name = defaultdict(list)
    for f in areas:
        areas_by_name[f["properties"]["WB_NAME"]].append(f)

    boxes = {
        "source": SOURCE_NAME, "item": SOURCE_ITEM,
        "tolerance": args.tolerance, "world_tolerance": args.world_tolerance,
        "countries": {iso: bbox(f["geometry"]) for iso, f in by_iso.items()},
        "regions": {},
    }
    for r in regions:
        if r.get("type") == "meta":
            continue
        boxes["regions"][r["id"]] = union_bbox(
            [boxes["countries"].get(c["iso"]) for c in r.get("countries", [])])

    if args.dry_run:
        log("dry run: nothing written")
        update_regions_json(regions_doc, derived, dry_run=True)
        return

    sizes = {}
    sizes["world.geojson"] = write_json(OUT_DIR / "world.geojson", collection(world))
    sizes["bboxes.json"] = write_json(OUT_DIR / "bboxes.json", boxes)

    paged = {c["iso"] for r in regions for c in r.get("countries", [])}
    for iso in sorted(paged & by_iso.keys()):
        mine = [a for a in areas if iso in a["properties"]["CLAIMANTS"].split(",")]
        sizes[f"country/{iso}"] = write_json(OUT_DIR / "country" / f"{iso}.geojson",
                                             collection([by_iso[iso]] + mine))
    if paged - by_iso.keys():
        log(f"  WARNING no GAD polygon for region members {sorted(paged - by_iso.keys())}")

    for r in regions:
        if r.get("type") == "meta":
            continue
        members = [by_iso[c["iso"]] for c in r.get("countries", []) if c["iso"] in by_iso]
        mine = [a for n in derived[r["id"]] for a in areas_by_name[n]]
        sizes[f"region/{r['id']}"] = write_json(
            OUT_DIR / "region" / f"{r['id']}.geojson", collection(members + mine))

    update_regions_json(regions_doc, derived, dry_run=False)

    log(f"wrote {len(sizes)} files under {OUT_DIR.relative_to(_ROOT)}")
    for k in ("world.geojson", "bboxes.json"):
        log(f"  {k:24s} {sizes[k]:>10,} bytes")
    region_sizes = sorted(((v, k) for k, v in sizes.items() if k.startswith("region/")), reverse=True)
    log("  largest region files: " + ", ".join(f"{k[7:]} {v:,}" for v, k in region_sizes[:5]))
    country_sizes = sorted(((v, k) for k, v in sizes.items() if k.startswith("country/")), reverse=True)
    log("  largest country files: " + ", ".join(f"{k[8:]} {v:,}" for v, k in country_sizes[:5]))


if __name__ == "__main__":
    main()
