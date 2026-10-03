/**
 * Data files, downloaded once per visit and shared.
 *
 * A map is rebuilt from scratch on every theme, basemap or run change, and
 * several panels read the same files (regions.json, the model's CSVs, the
 * GitHub folder listings), so without this every rebuild downloaded them
 * again -- some 30 MB of plants and lines for Europe, and a GitHub API call
 * against an hourly limit for each listing.
 *
 * What is kept is the downloaded TEXT; each caller parses its own copy. The
 * pages are free to change what they get back, as they always were, without
 * one page's change showing up in another's data. Text is kept up to a
 * budget, the least recently used dropped beyond it, and a file too big to
 * be worth holding (an unsplit dispatch table runs past 100 MB) is never kept.
 */

const BUDGET = 80e6;           // characters of text held, roughly bytes
const MAX_ENTRY = BUDGET / 2;  // bigger files are downloaded but not kept
const entries = new Map();     // url -> { promise, size }, oldest use first
let held = 0;

/**
 * The text at `url`. Rejects on an HTTP error, and a failed download is not
 * kept, so the next call tries again. `init` is passed to fetch on the first
 * download only; the cache is keyed on the URL alone.
 */
export function fetchText(url, init) {
  const hit = entries.get(url);
  if (hit) {
    entries.delete(url);       // re-insert: Map order is the recency order
    entries.set(url, hit);
    return hit.promise;
  }
  const entry = { size: 0 };
  entry.promise = fetch(url, init)
    .then(async r => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const text = await r.text();
      if (text.length > MAX_ENTRY) {
        forget(url, entry);
      } else {
        entry.size = text.length;
        held += text.length;
        trim(url);
      }
      return text;
    })
    .catch(err => { forget(url, entry); throw err; });
  entries.set(url, entry);
  return entry.promise;
}

/** The text at `url`, or null when it cannot be had (missing, offline). */
export function fetchTextOrNull(url, init) {
  return fetchText(url, init).catch(() => null);
}

/** The parsed JSON at `url`, a fresh copy for each call. */
export function fetchData(url, init) {
  return fetchText(url, init).then(JSON.parse);
}

function forget(url, entry) {
  if (entries.get(url) !== entry) return;
  entries.delete(url);
  held -= entry.size;
}

// Drop the least recently used files until the budget holds. Downloads still
// in flight (size 0) and the file just added are never dropped.
function trim(keep) {
  for (const [url, e] of entries) {
    if (held <= BUDGET) break;
    if (url === keep || !e.size) continue;
    entries.delete(url);
    held -= e.size;
  }
}
