"""Build the admin-1 layers from the World Bank Global Administrative Divisions.

Source: WB-GAD Medium Resolution, layer 4 (WB_GAD_ADM1)
        https://geowb.worldbank.org/hosting/rest/services/Hosted/
        WB_GAD_Medium_Resolution/FeatureServer/4

This replaces the Natural Earth admin-1 extraction previously shipped in
public/data/cache. It was the last boundary layer in the app that did not come
from the Bank -- the country geometry is built by prepare_gad.py from the same
WB-GAD product. The two now agree by construction, which is what map clearance
asks for.

The Bank's level 1 is not Natural Earth's: WB gives Bosnia its two entities
rather than cantons, Azerbaijan its economic regions rather than rayons, and it
carries Kosovo, which the Natural Earth extraction did not.

Outputs (public/data/cache/):
    region_admin1_<region>.geojson   -- one file per region that had one

Feature properties:
    ISO_A3     the app's country key, the one public/data/geo joins on
    name       the division's name (WB-GAD nam_1)
    wb_status  the Bank's status for the division, e.g. "Member State"

Only ISO_A3 is read by the app (see CountryPage.jsx, admin1-fills/admin1-borders);
the other two are kept so the file can be read on its own.

Requires: geopandas, shapely, topojson

Usage:
    python tools/prepare_admin1.py
"""
import json
from pathlib import Path
from urllib.parse import urlencode

import geopandas as gpd
import topojson as tp

from geometry import polygons_only, round_coords

ADM1_URL = ("https://geowb.worldbank.org/hosting/rest/services/Hosted/"
            "WB_GAD_Medium_Resolution/FeatureServer/4/query")
SOURCE_NAME = "World Bank Global Administrative Divisions (WB-GAD), ADM1"
SOURCE_LICENSE = "CC BY 4.0"
PAGE = 500
TOL = 0.001
PREC = 4

_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = _ROOT / "public" / "data" / "cache"
REGIONS = _ROOT / "public" / "data" / "regions.json"


def region_isos():
    """The ISO sets of the regions that already ship an admin-1 file."""
    regions = json.loads(REGIONS.read_text(encoding="utf-8"))["regions"]
    by_id = {r["id"]: [c["iso"] for c in r["countries"]] for r in regions}
    have = sorted(p.stem.replace("region_admin1_", "")
                  for p in OUT_DIR.glob("region_admin1_*.geojson"))
    missing = [r for r in have if r not in by_id]
    if missing:
        raise SystemExit(f"no such region in regions.json: {', '.join(missing)}")
    return {r: by_id[r] for r in have}


def fetch_adm1(isos):
    """Download the divisions of these countries, paging through the service.

    WB-GAD fills iso_a3 with the Bank's own code where ISO assigns none, so
    Kosovo arrives as iso_a3 KSV / wb_a3 KOS while the app keys it on KOS. Match
    on either field and report every row that did not come back on iso_a3.
    """
    wanted = set(isos)
    lst = ",".join(f"'{c}'" for c in sorted(wanted))
    frames, offset = [], 0
    while True:
        gdf = gpd.read_file(ADM1_URL + "?" + urlencode({
            "where": f"iso_a3 IN ({lst}) OR wb_a3 IN ({lst})",
            "outFields": "iso_a3,wb_a3,nam_0,nam_1,wb_status",
            "returnGeometry": "true", "outSR": "4326", "f": "geojson",
            "resultOffset": offset, "resultRecordCount": PAGE,
        }))
        if gdf.empty:
            break
        frames.append(gdf)
        offset += len(gdf)
        if len(gdf) < PAGE:
            break
    out = gpd.pd.concat(frames, ignore_index=True)
    out["ISO_A3"] = [iso if iso in wanted else wb
                     for iso, wb in zip(out["iso_a3"], out["wb_a3"])]
    for iso, wb, nam in sorted({(r.iso_a3, r.wb_a3, r.nam_0)
                                for r in out.itertuples() if r.iso_a3 not in wanted}):
        print(f"    keyed on wb_a3: {nam} (iso_a3 {iso} -> {wb})")
    return out


def write_region(gdf, path, name):
    features = []
    for row in gdf.itertuples():
        if row.geometry is None:
            continue
        geom = row.geometry.__geo_interface__
        features.append({
            "type": "Feature",
            "properties": {"ISO_A3": row.ISO_A3, "name": row.nam_1,
                           "wb_status": row.wb_status},
            "geometry": {"type": geom["type"],
                         "coordinates": round_coords(geom["coordinates"], PREC)},
        })
    doc = {"type": "FeatureCollection", "name": name,
           "source": SOURCE_NAME, "license": SOURCE_LICENSE,
           "features": features}
    path.write_text(json.dumps(doc), encoding="utf-8")
    print(f"    {path.name}: {len(features)} divisions, "
          f"{path.stat().st_size / 1e6:.2f} MB")


def main():
    for region, isos in region_isos().items():
        print(f"  {region}: {len(isos)} countries")
        gdf = fetch_adm1(isos)
        simplified = tp.Topology(gdf, prequantize=1e6,
                                 shared_coords=False).toposimplify(TOL).to_gdf()
        simplified["geometry"] = simplified.geometry.apply(polygons_only)
        lost = simplified.geometry.isna()
        if lost.any():
            simplified.loc[lost, "geometry"] = gdf.loc[lost, "geometry"].values
        write_region(simplified, OUT_DIR / f"region_admin1_{region}.geojson",
                     f"region_admin1_{region}")


if __name__ == "__main__":
    main()
