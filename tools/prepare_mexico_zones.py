"""Build the EPM zone geometry for the Mexico model (branch mexico_old).

The mexico_old branch of the EPM repo ships a complete input folder but no
geometry, and RegionPage hides the map entirely for a region that declares an
epm block without zones.geojson. CENACE's nine control regions are not a
published boundary layer, so they are assembled here from the states they
cover, using the same World Bank source the app's other admin-1 layers come
from -- prepare_admin1.py reads the identical service.

The control regions do not follow state lines exactly: Guerrero, Zacatecas and
San Luis Potosi are split in reality, and each is assigned whole to the region
that carries most of its load. The result is right for a map and wrong for an
area calculation; nothing in the app measures these polygons.

Source: WB-GAD Medium Resolution, layer 4 (WB_GAD_ADM1)
        https://geowb.worldbank.org/hosting/rest/services/Hosted/
        WB_GAD_Medium_Resolution/FeatureServer/4

Outputs (into an EPM input folder, default epm/input/data_mexico_ccdr):
    zones.geojson       one polygon per model zone -- properties z, ISO_A3, c,
                        the shape epm/postprocessing/create_geojson.py writes
                        and the shape src/pages/RegionPage.jsx reads
    zones_ext.geojson   one feature per external zone in trade/zext.csv

Guatemala is a country, so it keeps its own boundary from the app's WB-GAD
country file (public/data/geo, see prepare_gad.py) and draws as a grey neighbour. CAISO, ERCOT and WEPP are
US market areas with no boundary in any Bank layer; they are written as points
placed on the interconnection, which is all the map draws them as anyway. A
made-up polygon would read as an official footprint, so there is none.

Requires: geopandas, shapely, topojson

Usage:
    python tools/prepare_mexico_zones.py --out ../EPM/epm/input/data_mexico_ccdr
"""
import argparse
import json
import re
import unicodedata
from pathlib import Path
from urllib.parse import urlencode

import geopandas as gpd
import topojson as tp

from geometry import polygons_only, round_coords

ADM1_URL = ("https://geowb.worldbank.org/hosting/rest/services/Hosted/"
            "WB_GAD_Medium_Resolution/FeatureServer/4/query")
SOURCE_NAME = "World Bank Global Administrative Divisions (WB-GAD), ADM1"
SOURCE_LICENSE = "CC BY 4.0"
TOL = 0.001
PREC = 4

COUNTRY = "MEXICO"   # the c column of zcmap.csv, which zones.geojson must match
ISO = "MEX"

_ROOT = Path(__file__).resolve().parent.parent
GEO_COUNTRY = _ROOT / "public" / "data" / "geo" / "country"
DEFAULT_OUT = _ROOT.parent / "EPM" / "epm" / "input" / "data_mexico_ccdr"

# CENACE control region -> the states it covers, keyed on fold() of WB-GAD nam_1.
# The service returns names with mojibake in place of accents, so matching on the
# accent-stripped, letters-only form is the only stable key.
ZONE_STATES = {
    "SIBC":  ["bajacalifornia"],
    "SIBCS": ["bajacaliforniasur"],
    "NOR":   ["sonora", "sinaloa", "nayarit"],
    "NTE":   ["chihuahua", "durango", "zacatecas"],
    "NES":   ["coahuiladezaragoza", "nuevolen", "tamaulipas", "sanluispotos"],
    "OCC":   ["jalisco", "michoacndeocampo", "guanajuato", "quertaro",
              "aguascalientes", "colima", "guerrero"],
    "CEN":   ["ciudaddemxico", "mxico", "morelos", "hidalgo", "tlaxcala"],
    "ORI":   ["puebla", "veracruzdeignaciodelallave", "oaxaca", "tabasco", "chiapas"],
    "PEN":   ["yucatn", "campeche", "quintanaroo"],
}

# Where each external zone is drawn. The corridors in trade/pExtTransferLimit.csv
# are SIBC-CAISO, NES-ERCOT, NTE-WEPP and ORI-GUA, so each point sits on its own
# side of the crossing it serves rather than at the centre of the market area.
EXT_POINTS = {
    "CAISO": ([-115.55, 32.75], "Imperial Valley, on the SIBC interconnection"),
    "ERCOT": ([-99.50, 28.70], "South Texas, on the NES DC ties"),
    "WEPP":  ([-107.60, 32.20], "Southern New Mexico, on the NTE interconnection"),
}
EXT_COUNTRY = {"GUA": "GTM"}   # external zone -> ISO_A3 of a country we can draw


def fold(s):
    """Accent-stripped, letters-only form of a division name."""
    return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", s).lower())


def fetch_states():
    gdf = gpd.read_file(ADM1_URL + "?" + urlencode({
        "where": f"iso_a3 = '{ISO}'",
        "outFields": "iso_a3,nam_1",
        "returnGeometry": "true", "outSR": "4326", "f": "geojson",
        "resultOffset": 0, "resultRecordCount": 500,
    }))
    if gdf.empty:
        raise SystemExit("WB-GAD returned no divisions for MEX")
    gdf["key"] = [fold(n) for n in gdf["nam_1"]]
    return gdf


def assign(gdf):
    """Attach the zone each state belongs to, refusing anything unaccounted for."""
    by_state = {}
    for zone, states in ZONE_STATES.items():
        for s in states:
            if s in by_state:
                raise SystemExit(f"{s} claimed by both {by_state[s]} and {zone}")
            by_state[s] = zone

    have = set(gdf["key"])
    missing = sorted(set(by_state) - have)
    extra = sorted(have - set(by_state))
    if missing:
        raise SystemExit(f"mapped states absent from WB-GAD: {', '.join(missing)}")
    if extra:
        raise SystemExit(f"WB-GAD states with no zone: {', '.join(extra)}")

    gdf = gdf.copy()
    gdf["z"] = [by_state[k] for k in gdf["key"]]
    return gdf


def dissolve(gdf):
    """One polygon per zone, simplified on the shared topology so the seams hold."""
    zones = gdf.dissolve(by="z", as_index=False)[["z", "geometry"]]
    simplified = tp.Topology(zones, prequantize=1e6,
                             shared_coords=False).toposimplify(TOL).to_gdf()
    simplified["geometry"] = simplified.geometry.apply(polygons_only)
    lost = simplified.geometry.isna()
    if lost.any():
        simplified.loc[lost, "geometry"] = zones.loc[lost, "geometry"].values
    return simplified


def guatemala():
    """Guatemala's boundary from the app's WB-GAD country file."""
    iso = EXT_COUNTRY["GUA"]
    path = GEO_COUNTRY / f"{iso}.geojson"
    doc = json.loads(path.read_text(encoding="utf-8"))
    for f in doc["features"]:
        if f["properties"].get("ISO_A3") == iso:
            return f["geometry"]
    raise SystemExit(f"{iso} not in {path.name} -- run tools/prepare_gad.py")


def write_zones(gdf, path):
    features = [{
        "type": "Feature",
        "properties": {"z": row.z, "ISO_A3": ISO, "c": COUNTRY},
        "geometry": {"type": row.geometry.__geo_interface__["type"],
                     "coordinates": round_coords(
                         row.geometry.__geo_interface__["coordinates"], PREC)},
    } for row in gdf.itertuples() if row.geometry is not None]
    if len(features) != len(ZONE_STATES):
        raise SystemExit(f"{len(features)} zones written, expected {len(ZONE_STATES)}")
    doc = {"type": "FeatureCollection", "name": "zones",
           "source": SOURCE_NAME, "license": SOURCE_LICENSE, "features": features}
    path.write_text(json.dumps(doc), encoding="utf-8")
    print(f"  {path.name}: {len(features)} zones, {path.stat().st_size / 1e6:.2f} MB")


def write_zones_ext(path):
    features = [{
        "type": "Feature",
        "properties": {"z": "GUA", "name": "Guatemala", "note": "ORI interconnection"},
        "geometry": guatemala(),
    }]
    for z, (coords, note) in EXT_POINTS.items():
        features.append({
            "type": "Feature",
            "properties": {"z": z, "name": z, "note": note, "centroid": coords},
            "geometry": {"type": "Point", "coordinates": coords},
        })
    doc = {"type": "FeatureCollection", "name": "zones_ext",
           "source": "World Bank Global Administrative Divisions (GUA); interconnection points",
           "license": SOURCE_LICENSE, "features": features}
    path.write_text(json.dumps(doc), encoding="utf-8")
    print(f"  {path.name}: {len(features)} external zones, "
          f"{path.stat().st_size / 1e6:.2f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="EPM input folder to write into")
    args = ap.parse_args()
    if not args.out.is_dir():
        raise SystemExit(f"no such folder: {args.out}")

    print(f"  WB-GAD ADM1 for {ISO}")
    zones = dissolve(assign(fetch_states()))
    write_zones(zones, args.out / "zones.geojson")
    write_zones_ext(args.out / "zones_ext.geojson")


if __name__ == "__main__":
    main()
