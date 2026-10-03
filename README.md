# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Context boundary preparation

`python3 tools/prepare_gad.py` fetches the World Bank GAD extract and publishes
`public/data/geo/world.topo.json`, `country/{ISO3}.topo.json`,
`region/{id}.topo.json`, and `bboxes.json`, using EPM's own region registry.
The browser's `src/utils/basemap.js` decodes these TopoJSON files to GeoJSON
for MapLibre. Its decoder supports the producer's delta-encoded, one-arc-per-ring
MultiPolygon format, rather than arbitrary TopoJSON.

Coordinates are quantized to 0.00005 degrees for country/region files and
0.0005 degrees for the world file. These grids are finer than the geometry
simplification; rings that collapse on the grid are omitted and reported.
Model-zone and run-specific geography continue to use their existing upstream
files. The initial migration converted the existing local boundary snapshot
without refreshing it from the provider.
