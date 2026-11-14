// Pure Mars-local routing computations. Input elevations are measured HiRISE DTM samples in meters.
// Routes are educational cost estimates, not engineering-certified astronaut/rover safety plans.

export function at(data, col, row) {
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0
      || col >= data.gridSize || row >= data.gridSize) return null;
  const z = data.elevations[row * data.gridSize + col];
  return Number.isFinite(z) ? z : null;
}

export function nearestValid(data, col, row, radius = 24) {
  const n = data.gridSize;
  const x = Math.max(0, Math.min(n - 1, Math.round(col)));
  const y = Math.max(0, Math.min(n - 1, Math.round(row)));
  if (at(data, x, y) !== null) return { col: x, row: y };
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (at(data, x + dx, y + dy) !== null) return { col: x + dx, row: y + dy };
      }
    }
  }
  return null;
}

export function gridToGeo(data, col, row) {
  const { west, east, south, north } = data.geographicBounds;
  return {
    lat: north - (row / (data.gridSize - 1)) * (north - south),
    lon: west + (col / (data.gridSize - 1)) * (east - west),
  };
}

export function geoToGrid(data, lat, lon) {
  const { west, east, south, north } = data.geographicBounds;
  return nearestValid(
    data,
    ((lon - west) / (east - west)) * (data.gridSize - 1),
    ((north - lat) / (north - south)) * (data.gridSize - 1),
  );
}

class MinHeap {
  constructor() { this.entries = []; }
  push(item) {
    const a = this.entries; a.push(item);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (a[p].priority <= item.priority) break;
      a[k] = a[p]; k = p;
    }
    a[k] = item;
  }
  pop() {
    const a = this.entries;
    if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (!a.length) return top;
    let k = 0;
    while (k * 2 + 1 < a.length) {
      let c = k * 2 + 1;
      if (c + 1 < a.length && a[c + 1].priority < a[c].priority) c++;
      if (a[c].priority >= last.priority) break;
      a[k] = a[c]; k = c;
    }
    a[k] = last;
    return top;
  }
  get size() { return this.entries.length; }
}

const STEPS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

export function findRoute(data, start, target, mode = "gentle") {
  if (!start || !target || at(data, start.col, start.row) === null
      || at(data, target.col, target.row) === null) return null;
  if (!["gentle", "shortest"].includes(mode)) throw new Error("Unknown routing policy");
  const n = data.gridSize;
  const startIndex = start.row * n + start.col;
  const targetIndex = target.row * n + target.col;
  if (startIndex === targetIndex) return null;

  const size = n * n;
  const score = new Float64Array(size).fill(Infinity);
  const previous = new Int32Array(size).fill(-1);
  const visited = new Uint8Array(size);
  const heap = new MinHeap();
  score[startIndex] = 0;
  heap.push({ index: startIndex, priority: 0, score: 0 });
  const estimate = (col, row) => Math.hypot(
    (col - target.col) * data.cellSizeXM,
    (row - target.row) * data.cellSizeYM
  );

  while (heap.size) {
    const item = heap.pop();
    const index = item.index;
    if (visited[index] || item.score > score[index] + 1e-7) continue;
    if (index === targetIndex) break;
    visited[index] = 1;
    const col = index % n;
    const row = Math.floor(index / n);
    const z = data.elevations[index];
    for (const [dx, dy] of STEPS) {
      const nx = col + dx, ny = row + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const next = ny * n + nx;
      if (visited[next] || !Number.isFinite(data.elevations[next])) continue;
      // Do not cross a no-data corner diagonally.
      if (dx && dy && (at(data, col + dx, row) === null || at(data, col, row + dy) === null)) continue;
      const horizontal = Math.hypot(dx * data.cellSizeXM, dy * data.cellSizeYM);
      const vertical = data.elevations[next] - z;
      const degrees = Math.atan2(Math.abs(vertical), horizontal) * 180 / Math.PI;
      // 28° is an explicit DEM-scale DEMO exclusion, not a validated rover limit.
      if (degrees > 28) continue;
      const slopePenalty = mode === "gentle" ? 0.5 : 0.025;
      const weight = Math.hypot(horizontal, vertical) * (1 + slopePenalty * (degrees / 10) ** 2);
      const tentative = score[index] + weight;
      if (tentative >= score[next]) continue;
      score[next] = tentative;
      previous[next] = index;
      heap.push({
        index: next,
        priority: tentative + estimate(nx, ny),
        score: tentative,
      });
    }
  }

  if (!Number.isFinite(score[targetIndex])) return null;
  const nodes = [];
  let i = targetIndex;
  while (i !== -1) {
    nodes.push({ col: i % n, row: Math.floor(i / n), elevation: data.elevations[i] });
    if (i === startIndex) break;
    i = previous[i];
  }
  if (i !== startIndex) return null;
  nodes.reverse();
  let horizontalM = 0, surfaceM = 0, ascentM = 0, descentM = 0, maxSlopeDeg = 0;
  for (let k = 1; k < nodes.length; k++) {
    const a = nodes[k - 1], b = nodes[k];
    const h = Math.hypot((b.col - a.col) * data.cellSizeXM, (b.row - a.row) * data.cellSizeYM);
    const v = b.elevation - a.elevation;
    horizontalM += h;
    surfaceM += Math.hypot(h, v);
    ascentM += Math.max(v, 0);
    descentM += Math.max(-v, 0);
    maxSlopeDeg = Math.max(maxSlopeDeg, Math.atan2(Math.abs(v), h) * 180 / Math.PI);
  }
  return {
    nodes, horizontalM, surfaceM, ascentM, descentM, maxSlopeDeg,
    cost: score[targetIndex], mode,
  };
}
