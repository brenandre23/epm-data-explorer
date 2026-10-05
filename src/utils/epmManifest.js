/**
 * Folder listings from public/data/epm_manifest.json, written by
 * tools/build_epm_manifest.py on a schedule, so a page view does not ask GitHub's
 * API for them (60 anonymous calls per hour per IP address).
 *
 * Returns the listing as the Contents API would ([{ name, type }]), null when the
 * manifest covers the path and the folder does not exist, or undefined when the
 * manifest does not cover it -- a branch it does not hold, or a kind of folder it
 * does not list (its `listed` patterns) -- and the caller should ask GitHub.
 *
 * @param {object|null} manifest
 * @param {string} branch
 * @param {string} path  relative to the repo root, no trailing slash
 */
export function listingFromManifest(manifest, branch, path) {
  const b = manifest?.branches?.[branch];
  if (!b || !(manifest.listed || []).some(re => new RegExp(re).test(path))) return undefined;
  const items = b.dirs[path];
  return items ? items.map(([name, type]) => ({ name, type })) : null;
}
