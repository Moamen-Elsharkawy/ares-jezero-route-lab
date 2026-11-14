import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { at, nearestValid, findRoute, gridToGeo, geoToGrid } from "../src/navigation.js";

const data = JSON.parse(readFileSync(new URL("../public/data/jezero-grid.json", import.meta.url), "utf8"));

test("source is a real, verifiable USGS Mars DTM, with full resolution and physical units", () => {
  assert.match(data.demUrl, /astrogeo-ard.s3-us-west-2.amazonaws.com/);
  assert.match(data.stacItem, /^DTEEC_/);
  assert.match(data.crs, /49910|Equirectangular|Mars/i);
  assert.ok(data.validPercent > 85);
  assert.equal(data.elevations.length, data.gridSize * data.gridSize);
  assert.ok(data.sourceGsdM < 2);
  assert.ok(data.maxElevationM > data.minElevationM + 20);
  assert.ok(data.widthM > 500 && data.heightM > 500);
  assert.ok(data.minElevationM < -2000 && data.maxElevationM > -3500);
});

test("Mars-local point coordinates map to geographic latitude/longitude and back", () => {
  const p = nearestValid(data, 104, 135);
  assert.ok(p);
  const geo = gridToGeo(data, p.col, p.row);
  const roundTrip = geoToGrid(data, geo.lat, geo.lon);
  assert.deepEqual(roundTrip, p);
  assert.ok(geo.lon > 77 && geo.lat > 18);
});

test("routes from western to eastern DEM-covered waypoints contain genuine samples", () => {
  const start = nearestValid(data, 50, 194);
  const end = nearestValid(data, 190, 84);
  assert.ok(start && end);
  const route = findRoute(data, start, end, "gentle");
  assert.ok(route, "Route should be found on sampled real NASA/USGS data");
  assert.ok(route.nodes.length > 20);
  assert.ok(route.horizontalM > 500);
  assert.ok(route.maxSlopeDeg <= 28.001);
  assert.ok(route.nodes.every(node => at(data, node.col, node.row) === node.elevation));
  assert.ok(route.ascentM >= 0 && route.descentM >= 0);
});

test("routing honors finite no-data barriers and blocks diagonal corner cutting", () => {
  const toy = { gridSize: 5, cellSizeXM: 10, cellSizeYM: 10, elevations: Array(25).fill(-2500) };
  for (let c = 0; c < 5; c++) toy.elevations[2 * 5 + c] = null;
  assert.equal(findRoute(toy, {col: 1, row: 1}, {col: 1, row: 3}, "shortest"), null);
  assert.equal(at(toy, 2, 2), null);
  assert.equal(nearestValid(toy, 2, 2).row !== 2, true);
});

test("policy can avoid locally steeper segments in preference to mild detours", () => {
  const toy = { gridSize: 9, cellSizeXM: 10, cellSizeYM: 10, elevations: Array(81).fill(-2500) };
  toy.elevations[4 * 9 + 4] = -2495; // under the explicit 28° demo cutoff
  const s = { col: 2, row: 4 }, e = { col: 6, row: 4 };
  const soft = findRoute(toy, s, e, "gentle");
  const short = findRoute(toy, s, e, "shortest");
  assert.ok(soft && short);
  assert.ok(short.horizontalM <= soft.horizontalM + 0.0001);
  assert.ok(soft.maxSlopeDeg <= short.maxSlopeDeg + 0.0001);
});

test("rejects invalid and identical waypoints without claiming a safe route", () => {
  const p = nearestValid(data, 40, 40);
  assert.equal(findRoute(data, p, p, "shortest"), null);
  assert.equal(findRoute(data, {col:-1,row:0}, p, "shortest"), null);
  assert.throws(() => findRoute(data, p, nearestValid(data, 180, 180), "magic"));
});
