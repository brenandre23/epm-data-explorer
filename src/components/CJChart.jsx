import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';

// Bundled rather than loaded from a CDN, so nothing is fetched from outside the site.

/** First ancestor that actually paints a background, so an exported PNG is not transparent. */
function resolveBg(el) {
  for (let n = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    const m = bg && bg.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(',').map(x => parseFloat(x));
      if (p.length < 4 || p[3] > 0.9) return bg;
    }
  }
  return '#ffffff';
}

/**
 * A title for the chart: what the caller said, else the heading it sits under.
 *
 * A section heading is a flex row whose first child is the label and whose second holds
 * whatever controls that section carries, so the first element child is the part worth
 * reading. Falling back to the whole row would drag every button caption in with it.
 */
function guessName(wrap) {
  const box = wrap?.parentElement;
  const read = el => ((el?.firstElementChild?.textContent ?? el?.textContent) || '')
    .replace(/\s+/g, ' ').trim().slice(0, 90);
  for (let n = box?.previousElementSibling; n; n = n.previousElementSibling) {
    const txt = read(n);
    if (txt) return txt;
  }
  return read(box?.parentElement?.previousElementSibling);
}

/**
 * A cheap fingerprint of the numbers on the chart.
 *
 * The signature below watches the shape of the data, not its values, and the component has
 * no update path: a page that swaps a scenario variant, a year or a zone under an unchanged
 * set of labels would keep the previous numbers on screen for good. Folding the values in
 * costs one multiply per point, a few thousand per chart, and makes every such swap redraw
 * without the page having to name it in a cacheKey.
 */
function fingerprint(datasets) {
  let h = 0x811c9dc5;
  for (const d of datasets || []) {
    for (const v of d.data || []) {
      const n = typeof v === 'number' ? v
        : (v && typeof v === 'object') ? (v.y ?? v.x ?? 0)
        : (v == null ? 0 : Number(v) || 0);
      h = Math.imul((h ^ (Math.round(n * 1000) | 0)) >>> 0, 0x01000193) >>> 0;
    }
  }
  return h;
}

const slug = s => (s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/\s+/g, '-').slice(0, 60).toLowerCase() || 'epm-chart';

/**
 * Chart.js, wrapped so a page can render one from
 * plain data. Every results and input page drew its own copy of this before; they had
 * drifted into four variants, so this is their union — `plugins` and `cacheKey` from the
 * results pages, `onClickYear` from the input pages, and a signature that watches every
 * field any of them watched.
 *
 * The chart is rebuilt, not updated, whenever that signature changes: cheap at this size,
 * and it keeps the pages free of Chart.js update semantics.
 */
export default function CJChart({ type, data, options, height, plugins: extraPlugins, cacheKey, onClickYear, name }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);
  const wrapRef   = useRef(null);
  const [hover, setHover] = useState(false);

  const sig = JSON.stringify({ type, labels: data.labels, ck: cacheKey,
    fp: fingerprint(data.datasets),
    ds: data.datasets?.map(d => ({ l: d.label, n: d.data?.length, t: d.type, f: d.fill, h: d.hidden })) });

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    const mergedOptions = onClickYear ? { ...options,
      onClick: (e, _els, chart) => { const pts = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, true); if (pts.length) onClickYear(String(data.labels[pts[0].index])); },
      onHover: (_e, els) => { if (canvasRef.current) canvasRef.current.style.cursor = els.length ? 'pointer' : 'default'; },
    } : options;
    chartRef.current = new Chart(canvasRef.current, { type, data, options: mergedOptions, plugins: extraPlugins || [] });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The canvas is transparent and its backing store is already device-pixel sized, so the
  // export is that store painted over the panel's own background, under its own title:
  // out of the app a chart has to say what it is.
  const download = () => {
    const src = canvasRef.current;
    if (!src || !src.width) return;
    const title = (name || guessName(wrapRef.current) || '').trim();
    const ratio = src.width / (src.clientWidth || src.width);   // device pixels per CSS pixel
    const pad = Math.round(10 * ratio);
    const band = title ? Math.round(30 * ratio) : 0;

    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height + band;
    const ctx = out.getContext('2d');
    ctx.fillStyle = resolveBg(src);
    ctx.fillRect(0, 0, out.width, out.height);

    if (title) {
      ctx.fillStyle = getComputedStyle(src).color || '#333';
      ctx.font = `600 ${Math.round(13 * ratio)}px 'Segoe UI', system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      let txt = title;
      const room = out.width - 2 * pad;
      if (ctx.measureText(txt).width > room) {
        while (txt.length > 1 && ctx.measureText(`${txt}…`).width > room) txt = txt.slice(0, -1);
        txt += '…';
      }
      ctx.fillText(txt, pad, band / 2);
    }

    ctx.drawImage(src, 0, band);
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `${slug(title)}-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  };

  return (
    <div ref={wrapRef} style={{ height, width: '100%', position: 'relative' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <canvas ref={canvasRef} />
      <button type="button" onClick={download} title="Download this chart as PNG"
        onFocus={() => setHover(true)} onBlur={() => setHover(false)}
        style={{ position: 'absolute', top: 0, right: 0, zIndex: 2, cursor: 'pointer',
          font: 'inherit', fontSize: '0.5rem', lineHeight: 1, padding: '2px 5px', borderRadius: 3,
          border: '1px solid rgba(128,160,192,0.35)', backgroundColor: 'rgba(128,160,192,0.12)',
          color: 'rgba(128,160,192,0.95)', opacity: hover ? 1 : 0,
          transition: 'opacity 120ms', pointerEvents: hover ? 'auto' : 'none' }}>⤓</button>
    </div>
  );
}
