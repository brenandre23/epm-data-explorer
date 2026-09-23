import { useState } from 'react';

/**
 * PNG export for a MapLibre map.
 *
 * The map paints into a WebGL canvas, so the picture is one drawImage away, but everything
 * the app adds as a DOM marker (donuts, price bubbles, labels) lives outside that canvas.
 * Those are cloned into a foreignObject and drawn on top, which keeps the export honest for
 * the layers the reader actually sees. Markers that carry an external image are the one
 * thing this cannot capture: the SVG would fail to load and the overlay is dropped.
 */

const slug = s => (s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/\s+/g, '-').slice(0, 60).toLowerCase() || 'epm-map';

/** The map's own background, so the title band matches the picture under it. */
function bgOf(el) {
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(c)) return c;
  }
  return '#ffffff';
}

async function overlayImage(container, w, h) {
  const nodes = [...container.querySelectorAll('.maplibregl-marker')];
  if (!nodes.length) return null;
  const holder = document.createElement('div');
  holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  holder.setAttribute('style',
    `width:${w}px;height:${h}px;position:relative;overflow:hidden;font-family:"Open Sans", system-ui, sans-serif`);
  for (const n of nodes) {
    const c = n.cloneNode(true);
    c.style.position = 'absolute';
    c.style.top = '0px';
    c.style.left = '0px';
    holder.appendChild(c);
  }
  let body;
  try { body = new XMLSerializer().serializeToString(holder); } catch { return null; }
  // rem resolves against the root of the document it renders in, and here that root is the
  // svg element, not the app's html. Restating the app's 20px base keeps marker text sized.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="font-size:20px">`
    + `<foreignObject x="0" y="0" width="${w}" height="${h}">${body}</foreignObject></svg>`;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export async function exportMapPng(map, name) {
  if (!map) return;
  const src = map.getCanvas();
  if (!src || !src.width) return;
  const title = (name || '').trim();
  const ratio = src.width / (src.clientWidth || src.width);
  const pad = Math.round(10 * ratio);
  const band = title ? Math.round(30 * ratio) : 0;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height + band;
  const ctx = out.getContext('2d');
  ctx.fillStyle = bgOf(map.getContainer());
  ctx.fillRect(0, 0, out.width, out.height);
  if (title) {
    ctx.fillStyle = getComputedStyle(map.getContainer()).color || '#333';
    ctx.font = `600 ${Math.round(13 * ratio)}px "Open Sans", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    let txt = title;
    const room = out.width - 2 * pad;
    if (ctx.measureText(txt).width > room) {
      while (txt.length > 1 && ctx.measureText(`${txt}…`).width > room) txt = txt.slice(0, -1);
      txt += '…';
    }
    ctx.fillText(txt, pad, band / 2);
  }
  // The drawing buffer is only guaranteed to hold pixels for the frame that drew them,
  // so the capture is taken from inside one. redraw() renders synchronously and emits
  // 'render' at the end of that frame; the call after it is the safety net for a build
  // where it does not, and is a no-op once the handler has drawn.
  let drawn = false;
  const paint = () => { if (!drawn) { drawn = true; ctx.drawImage(src, 0, band); } };
  map.once?.('render', paint);
  map.redraw?.();
  map.off?.('render', paint);
  paint();
  const overlay = await overlayImage(map.getContainer(), src.clientWidth, src.clientHeight);
  if (overlay) ctx.drawImage(overlay, 0, band, src.width, src.height);
  const a = document.createElement('a');
  a.href = out.toDataURL('image/png');
  a.download = `${slug(title)}-${new Date().toISOString().slice(0, 10)}.png`;
  a.click();
}

export default function MapDownload({ mapRef, name, t, style }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try { await exportMapPng(mapRef?.current, typeof name === 'function' ? name() : name); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={go} title="Download this map as PNG"
      style={{
        position: 'absolute', bottom: 14, right: 10, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 4,
        fontSize: '0.5rem', fontFamily: 'inherit', padding: '3px 7px', borderRadius: 4,
        cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1,
        border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted,
        ...style,
      }}>
      ⤓ PNG
    </button>
  );
}
