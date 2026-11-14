# Team integration and reproducibility guide

ARES is an independent working prototype, **not a fork of the official Red Compass repository**. The local viewer renders a measured Mars terrain subset in 2D/3D and computes indicative A* routes.

## Handoff walkthrough

1. `npm ci` and `npm test` (six tests). Then `npm run dev`.
2. In the browser compare 3D RELIEF with 2D MAP; both share the same height samples.
3. Use **Traverse comparison** and switch between **Slope-aware estimate** and **Shortest traversable estimate**.
4. Change A and B by clicking their buttons and then the 2D or 3D surface.
5. Adjust the vertical exaggeration. The visible 3D relief changes but route lengths don't.
6. Follow the [USGS dataset record](https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms/items/DTEEC_045994_1985_046060_1985_U01).

## Modules and data

- `scripts/prepare_jezero.py`: reads a real USGS HiRISE Cloud-Optimized GeoTIFF window (Mars CRS) and creates two offline assets, without generating fake heights.
- `public/data/jezero-grid.json`: 257×257 heights in meters (or `null` for missing data), Mars planetocentric coordinate bounds, cell sizes in meters, source identifier, valid coverage, datum, and exact source URLs.
- `public/data/jezero-surface.png`: matching projected HiRISE orthoimage + DEM hillshade.
- `src/navigation.js`: pure functions `at`, `nearestValid`, `gridToGeo`, `geoToGrid`, `findRoute`. Can be integrated separately from the UI.
- `src/main.js`: 2D Canvas and Three.js scene/controls/routes.

### Example routing API

```js
import { nearestValid, findRoute } from './src/navigation.js';

const start = nearestValid(data, 35, 120);
const end = nearestValid(data, 190, 130);
const route = findRoute(data, start, end, 'gentle'); // or 'shortest'
```

When connected, route includes grid nodes (with heights), `horizontalM`, `surfaceM`, `ascentM`, `descentM`, `maxSlopeDeg`, `mode`, and model cost. It returns `null` if a path cannot be found under the demo constraints. `null` does **not** mean "safe."

## Integrating with the final team application

- Agree on a shared **Mars** planetocentric CRS and vertical datum; do not use terrestrial WGS84/Web Mercator measurements.
- Use the same elevation source for the 2D map, routing cost grid and 3D mesh.
- Align all derived overlays and preserve `nodata`; evaluate the DTM Figure-of-Merit and uncertainty before scientific use.
- Specify real movement constraints for the intended traveler (person vs rover). The demo 28-degree threshold and route penalties are **assumptions**, not NASA safety specs.
- Add real provenance for further layers such as minerals or hazards; never label an unverified simulation as NASA observations.
- To cover larger areas, stream tiled rasters and use multiple resolutions rather than a single huge JSON.
- For more reliable terrain safety use the original higher-resolution DTM and verify obstacles, stereo artifacts, illumination and material conditions.

## Build / deployment

`npm run build` is for root hosting. `npm run build:pages` uses the GitHub repository subpath; the source uses `import.meta.env.BASE_URL` for public assets. The Pages workflow runs test/build/deploy on pushes to main, after Pages is enabled with GitHub Actions as its deployment source.

See [README](../README.md) and [recorded QA](../QA-2026-11-14.md) for exact local evidence. This is an educational prototype, not a route safety certification.
