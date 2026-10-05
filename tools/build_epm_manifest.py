"""
Writes public/data/epm_manifest.json: the folder listings the explorer reads from
the EPM repo, so a page view no longer asks GitHub's API for them. Anonymous API
calls are limited to 60 per hour per IP address, and each page view used about 5.

One entry per EPM branch named in public/data/regions.json, holding the branch's
commit and, for each folder the app lists, its entries as [name, "dir"|"file"]:

    epm/input                                   data folders
    epm/input/data_*                            zcmap files
    epm/output_view, epm/output                 runs
    epm/output*/<run>                           scenarios
    epm/output*/<run>/<scenario>/output_csv     result files

`listed` carries those patterns, so the app answers only those paths from the
manifest and asks GitHub for anything else (src/utils/epmManifest.js).

Each run first asks each branch for its latest commit (one call per branch) and
reads the tree of a branch only when that has moved, one call more. When no
branch moved and none was added or dropped, the file is left untouched, so a
scheduled run with nothing new commits nothing.

Usage:
    python tools/build_epm_manifest.py           # refresh the branches that moved
    python tools/build_epm_manifest.py --full    # re-read every branch

Set GITHUB_TOKEN to use the authenticated limit (5,000 calls per hour); the
workflow does. Standard library only.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_ROOT    = Path(__file__).resolve().parents[1]
REGIONS  = _ROOT / "public" / "data" / "regions.json"
OUT      = _ROOT / "public" / "data" / "epm_manifest.json"
REPO     = "ESMAP-World-Bank-Group/EPM"
API      = f"https://api.github.com/repos/{REPO}"

# The folders the app lists (src/utils/epmFetch.js). Anchored, matched against the
# whole path. Kept in the file so the app and this script cannot disagree.
LISTED = [
    r"^epm/input$",
    r"^epm/input/data_[^/]+$",
    r"^epm/output(_view)?$",
    r"^epm/output(_view)?/[^/]+$",
    r"^epm/output(_view)?/[^/]+/[^/]+/output_csv$",
]


def get(path):
    req = urllib.request.Request(f"{API}/{path}", headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "epm-data-explorer-manifest",
    })
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def branches_from_regions():
    regions = json.loads(REGIONS.read_text(encoding="utf-8"))["regions"]
    return sorted({r["epm"]["branch"] for r in regions if r.get("epm", {}).get("branch")})


def listings(tree):
    """Folder listings from a recursive git tree, for the LISTED folders only."""
    patterns = [re.compile(p) for p in LISTED]
    dirs = {}
    for entry in tree:
        parent, _, name = entry["path"].rpartition("/")
        if not any(p.match(parent) for p in patterns):
            continue
        kind = "dir" if entry["type"] == "tree" else "file"
        dirs.setdefault(parent, []).append([name, kind])
    return {path: sorted(items) for path, items in sorted(dirs.items())}


def read_branch(branch, commit):
    tree = get(f"git/trees/{commit}?recursive=1")
    if tree.get("truncated"):
        # Over GitHub's 100,000 entries / 7 MB: the listing would be incomplete, and
        # an incomplete listing hides runs. Leave the branch to the live API.
        print(f"  {branch}: tree truncated, left out", file=sys.stderr)
        return None
    return {"commit": commit, "dirs": listings(tree["tree"])}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--full", action="store_true", help="re-read every branch")
    args = ap.parse_args()

    old = {}
    if OUT.exists() and not args.full:
        saved = json.loads(OUT.read_text(encoding="utf-8"))
        if saved.get("listed") == LISTED:  # patterns changed: everything is stale
            old = saved.get("branches", {})

    branches, changed = {}, False
    for branch in branches_from_regions():
        try:
            commit = get(f"commits/{branch}")["sha"]
        except urllib.error.HTTPError as err:
            # A branch named in regions.json but gone from the repo: the app falls
            # back to the live API for it, which fails the same way it does today.
            print(f"  {branch}: {err.code}, left out", file=sys.stderr)
            changed |= branch in old
            continue
        if old.get(branch, {}).get("commit") == commit:
            branches[branch] = old[branch]
            print(f"  {branch}: unchanged ({commit[:7]})")
            continue
        entry = read_branch(branch, commit)
        changed |= entry is not None or branch in old
        if entry:
            branches[branch] = entry
            print(f"  {branch}: read {commit[:7]}, {len(entry['dirs'])} folders")
    changed |= set(old) - set(branches) != set()

    if not changed and OUT.exists():
        print("No branch moved; manifest left as it is.")
        return
    manifest = {
        "repo": REPO,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "listed": LISTED,
        "branches": branches,
    }
    OUT.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(_ROOT)} ({OUT.stat().st_size // 1024} KB, {len(branches)} branches)")


if __name__ == "__main__":
    main()
