import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { at, findRoute, gridToGeo, nearestValid } from "./navigation.js";

const dom = (id) => document.getElementById(id);
const state = {
  data: null, route: null, start: null, end: null, target: "start",
  mode: "3d", exaggeration: 5, image: null,
  renderer: null, controls: null, camera: null, scene: null, terrain: null,
  routeObject: null, markerGroup: null,
};
const PRESETS = {
  delta: [[0.16, 0.74], [0.73, 0.34]],
  ridge: [[0.23, 0.30], [0.80, 0.77]],
  cross: [[0.12, 0.52], [0.88, 0.52]],
};

function format(number, decimals = 0) {
  return Number(number).toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}
function setError(error) {
  console.error("ARES terrain error", error);
  dom("loading").textContent = "DATA ERROR: " + (error.message || error);
  dom("route-status").textContent = "UNAVAILABLE";
  dom("route-status").classList.add("error");
  dom("route-note").textContent = "Check local terrain files and network console";
  window.__ares = { ...(window.__ares || {}), error: String(error) };
}
function pointFromPreset(fraction) {
  const n = state.data.gridSize - 1;
  return nearestValid(state.data, fraction[0] * n, fraction[1] * n);
}
function choosePreset() {
  const [a, b] = PRESETS[dom("presets").value];
  state.start = pointFromPreset(a);
  state.end = pointFromPreset(b);
  refreshCoordinates();
  updateRoute();
}
function refreshCoordinates() {
  for (const [key, el] of [["start", dom("start-coords")], ["end", dom("end-coords")]]) {
    const p = state[key];
    if (!p) { el.textContent = "Unassigned"; continue; }
    const g = gridToGeo(state.data, p.col, p.row);
    el.textContent = g.lat.toFixed(4) + "°N · " + g.lon.toFixed(4) + "°E";
  }
}
function chooseTarget(target) {
  state.target = target;
  for (const key of ["start", "end"]) {
    const button = dom("set-" + key);
    button.classList.toggle("chosen", key === target);
    button.setAttribute("aria-pressed", String(key === target));
  }
}
function setPoint(col, row) {
  const pt = nearestValid(state.data, col, row, 12);
  if (!pt) {
    dom("route-status").textContent = "NO DATA";
    dom("route-note").textContent = "Point has no verified elevation sample";
    return;
  }
  state[state.target] = pt;
  chooseTarget(state.target === "start" ? "end" : "start");
  refreshCoordinates();
  updateRoute();
}
function updateRoute() {
  if (!state.data || !state.start || !state.end) return;
  state.route = findRoute(state.data, state.start, state.end, dom("strategy").value);
  const route = state.route;
  const metrics = ["distance", "ascent", "slope"];
  if (!route) {
    for (const id of metrics) dom(id).textContent = "—";
    dom("route-status").textContent = "NO ROUTE";
    dom("route-status").classList.add("error");
    dom("route-note").textContent = "No connected passable cells with this 28° demo cutoff";
  } else {
    dom("distance").textContent = format(route.horizontalM);
    dom("ascent").textContent = format(route.ascentM, 1);
    dom("slope").textContent = format(route.maxSlopeDeg, 1);
    dom("route-status").textContent = "ROUTE FOUND";
    dom("route-status").classList.remove("error");
    dom("route-note").textContent = route.nodes.length + " sampled positions · " + route.mode + " model";
  }
  draw2D();
  renderRoute3D();
  if (window.__ares) {
    window.__ares.route = route;
    window.__ares.start = state.start;
    window.__ares.end = state.end;
  }
}
function setMode(mode) {
  if (mode === "3d" && !state.renderer) mode = "2d";
  state.mode = mode;
  dom("scene3d").classList.toggle("hidden", mode !== "3d");
  dom("map2d").classList.toggle("hidden", mode !== "2d");
  for (const btn of document.querySelectorAll("[data-mode]")) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  dom("viewport-label").textContent = mode === "3d" ? "3D TOPOGRAPHIC MODEL" : "2D HILLSHADE & ROUTE";
  dom("view-caption").textContent = mode === "3d" ? "DRAG TO ORBIT · SCROLL TO ZOOM" : "CLICK TERRAIN TO PLACE A OR B";
  if (mode === "2d") draw2D();
  else resize3D();
}
function routeElevation(node) {
  return (node.elevation - state.medianElevation) * state.exaggeration + 5;
}
function worldX(col) { return -state.data.widthM / 2 + col * state.data.cellSizeXM; }
function worldZ(row) { return -state.data.heightM / 2 + row * state.data.cellSizeYM; }

function clear3DRoute() {
  if (!state.scene) return;
  if (state.routeObject) {
    state.scene.remove(state.routeObject);
    state.routeObject.geometry.dispose(); state.routeObject.material.dispose();
    state.routeObject = null;
  }
  if (state.markerGroup) {
    state.scene.remove(state.markerGroup);
    for (const child of state.markerGroup.children) { child.geometry.dispose(); child.material.dispose(); }
    state.markerGroup = null;
  }
}
function renderRoute3D() {
  if (!state.scene || !state.data) return;
  clear3DRoute();
  if (state.route && state.route.nodes.length > 1) {
    // Sparse route geometry avoids rendering 500 overlapping tubes.
    const pts = state.route.nodes.map((p) => new THREE.Vector3(worldX(p.col), routeElevation(p), worldZ(p.row)));
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const tubularSegments = Math.min(900, Math.max(32, pts.length * 2));
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, 2.5, 5, false);
    const material = new THREE.MeshBasicMaterial({ color: 0xffad66, depthTest: true });
    state.routeObject = new THREE.Mesh(geometry, material);
    state.scene.add(state.routeObject);
  }
  state.markerGroup = new THREE.Group();
  for (const [label, pos, color] of [["A", state.start, 0x8bdbd0], ["B", state.end, 0xffb088]]) {
    if (!pos) continue;
    const z = at(state.data, pos.col, pos.row);
    const y = (z - state.medianElevation) * state.exaggeration;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(9, 16, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    marker.position.set(worldX(pos.col), y + 11, worldZ(pos.row));
    state.markerGroup.add(marker);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 32, 6),
      new THREE.MeshBasicMaterial({ color })
    );
    stem.position.set(worldX(pos.col), y + 18, worldZ(pos.row));
    state.markerGroup.add(stem);
  }
  state.scene.add(state.markerGroup);
}
function updateTerrainExaggeration() {
  if (!state.terrain) return;
  const positions = state.terrain.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const z = state.data.elevations[i];
    positions.setY(i, ((Number.isFinite(z) ? z : state.medianElevation) - state.medianElevation) * state.exaggeration);
  }
  positions.needsUpdate = true;
  state.terrain.geometry.computeVertexNormals();
  renderRoute3D();
}
function initialize3D() {
  const data = state.data;
  const canvas = dom("scene3d");
  try {
    state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (err) {
    console.warn("WebGL unavailable, using 2D instead", err);
    state.renderer = null;
    return;
  }
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.setClearColor(0x0a1825, 1);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.scene = new THREE.Scene();
  state.scene.fog = new THREE.FogExp2(0x0a1825, 0.00065);
  state.camera = new THREE.PerspectiveCamera(42, 1, 1, 15000);
  state.camera.position.set(data.widthM * 0.82, data.heightM * 0.65, data.heightM * 0.87);
  state.camera.lookAt(0, 0, 0);
  state.controls = new OrbitControls(state.camera, canvas);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.075;
  state.controls.minDistance = 80;
  state.controls.maxDistance = 4200;
  state.controls.maxPolarAngle = Math.PI / 2.0 - 0.025;
  state.controls.target.set(0, 0, 0);
  state.scene.add(new THREE.AmbientLight(0xe1ebff, 1.35));
  const sun = new THREE.DirectionalLight(0xffc89c, 2.2);
  sun.position.set(-1000, 1900, -850);
  state.scene.add(sun);
  const rim = new THREE.DirectionalLight(0x5c9aca, 0.65);
  rim.position.set(800, 700, 1050);
  state.scene.add(rim);
  const geometry = new THREE.PlaneGeometry(data.widthM, data.heightM, data.gridSize - 1, data.gridSize - 1);
  geometry.rotateX(-Math.PI / 2);
  const texture = new THREE.Texture(state.image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, state.renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide });
  state.terrain = new THREE.Mesh(geometry, material);
  state.scene.add(state.terrain);
  const baseGeo = new THREE.BoxGeometry(data.widthM + 4, 8, data.heightM + 4);
  const base = new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: 0x172432, roughness: 1 }));
  base.position.y = (data.minElevationM - state.medianElevation) * 12 - 8;
  state.scene.add(base);
  const grid = new THREE.GridHelper(Math.max(data.widthM, data.heightM) + 150, 16, 0x4c7187, 0x2d4d5d);
  grid.position.y = base.position.y - 4;
  state.scene.add(grid);
  updateTerrainExaggeration();
  canvas.addEventListener("click", (e) => {
    if (state.mode !== "3d" || !state.terrain) return;
    const rect = canvas.getBoundingClientRect();
    const uv = new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1,
      -(e.clientY - rect.top) / rect.height * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(uv, state.camera);
    const hits = ray.intersectObject(state.terrain, false);
    if (!hits.length || !hits[0].uv) return;
    setPoint(hits[0].uv.x * (data.gridSize - 1), (1 - hits[0].uv.y) * (data.gridSize - 1));
  });
  const onFrame = () => {
    state.controls.update();
    if (state.mode === "3d") state.renderer.render(state.scene, state.camera);
    requestAnimationFrame(onFrame);
  };
  onFrame();
  resize3D();
}
function resize3D() {
  if (!state.renderer) return;
  const container = dom("viewport");
  const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h, false);
}

function mapRect() {
  const canvas = dom("map2d");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const area = Math.min(w - 36, h - 26);
  const width = Math.min(area * (state.data.widthM / state.data.heightM), w - 30);
  return { x: (w - width) / 2, y: (h - area) / 2, w: width, h: area };
}
function draw2D() {
  if (!state.data || !state.image) return;
  const canvas = dom("map2d");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w < 1 || h < 1) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * pixelRatio);
  canvas.height = Math.round(h * pixelRatio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = "#101b28";ctx.fillRect(0, 0, w, h);
  const rect = mapRect();
  ctx.fillStyle = "#112231";
  ctx.fillRect(rect.x - 6, rect.y - 6, rect.w + 12, rect.h + 12);
  ctx.drawImage(state.image, rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = "#b7c8cc27";ctx.lineWidth = 1;
  for (let k = 1; k < 8; k++) {
    const x = rect.x + rect.w * k / 8, y = rect.y + rect.h * k / 8;
    ctx.beginPath();ctx.moveTo(x, rect.y);ctx.lineTo(x, rect.y + rect.h);ctx.stroke();
    ctx.beginPath();ctx.moveTo(rect.x, y);ctx.lineTo(rect.x + rect.w, y);ctx.stroke();
  }
  const toXY = (p) => [rect.x + rect.w * p.col / (state.data.gridSize - 1),
    rect.y + rect.h * p.row / (state.data.gridSize - 1)];
  if (state.route) {
    ctx.beginPath();
    state.route.nodes.forEach((p, i) => {
      const [x, y] = toXY(p);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#251508"; ctx.lineWidth = 7; ctx.lineJoin = "round"; ctx.stroke();
    ctx.strokeStyle = "#ffb379"; ctx.lineWidth = 3.5; ctx.stroke();
  }
  for (const [label, p, color] of [["A", state.start, "#78decf"], ["B", state.end, "#ffac77"]]) {
    if (!p) continue;
    const [x, y] = toXY(p);
    ctx.beginPath();ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = "#101b26";ctx.fill();ctx.lineWidth = 2;ctx.strokeStyle = color;ctx.stroke();
    ctx.fillStyle = color;ctx.font = "bold 13px IBM Plex Mono, monospace";ctx.textAlign = "center";ctx.textBaseline = "middle";ctx.fillText(label, x, y + 0.5);
  }
  ctx.strokeStyle = "#e9b18b";ctx.lineWidth = 1.5;ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  const scalePx = rect.w * (200 / state.data.widthM);
  const scX = rect.x + rect.w - scalePx - 16;
  const scY = rect.y + rect.h - 17;
  ctx.fillStyle = "#ecded1";ctx.textAlign = "left";ctx.font = "10px IBM Plex Mono";
  ctx.fillText("200 m", scX, scY - 6);
  ctx.strokeStyle = "#ecded1";ctx.lineWidth = 3;ctx.beginPath();ctx.moveTo(scX, scY);ctx.lineTo(scX + scalePx, scY);ctx.stroke();
}
function pickFrom2D(event) {
  if (!state.data) return;
  const rect = mapRect(), bounds = dom("map2d").getBoundingClientRect();
  const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
  if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return;
  setPoint((x - rect.x) / rect.w * (state.data.gridSize - 1),
    (y - rect.y) / rect.h * (state.data.gridSize - 1));
}

async function start() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/jezero-grid.json`, { cache: "no-store" });
    if (!res.ok) throw new Error("Real DTM missing (HTTP " + res.status + ")");
    const data = await res.json();
    if (data.gridSize * data.gridSize !== data.elevations.length ||
        data.sourceGsdM <= 0 || data.validPercent < 85 ||
        !String(data.dataset).includes("USGS HiRISE")) throw new Error("Invalid real Mars DTM metadata");
    state.data = data;
    const sorted = data.elevations.filter(Number.isFinite).sort((a,b)=>a-b);
    state.medianElevation = sorted[Math.floor(sorted.length / 2)];
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}${data.texture.replace(/^\/+/, "")}`;
    await img.decode();
    state.image = img;
    dom("grid-info").textContent = data.gridSize + " × " + data.gridSize;
    dom("extent-info").textContent = format(data.widthM) + " × " + format(data.heightM) + " m";
    dom("coverage-info").textContent = data.validPercent + "%";
    dom("source-description").textContent = data.stacItem + " / " + data.textureKind;
    dom("source-link").href = data.stacUrl;
    dom("readout").textContent = format(data.minElevationM, 0) + " to " + format(data.maxElevationM, 0) + " m areoid";
    choosePreset();
    initialize3D();
    if (!state.renderer) setMode("2d");
    dom("loading").classList.add("hidden");
    draw2D();
    window.__ares = {
      ready: true, data, route: state.route, start: state.start, end: state.end,
      get mode() { return state.mode; },
      get webgl() { return !!state.renderer; },
    };
    console.info("ARES loaded verified USGS HiRISE measurements", data.stacItem, data.validPercent);
  } catch (err) { setError(err); }
}

dom("presets").addEventListener("change", choosePreset);
dom("strategy").addEventListener("change", updateRoute);
dom("reset-route").addEventListener("click", updateRoute);
dom("set-start").addEventListener("click", () => chooseTarget("start"));
dom("set-end").addEventListener("click", () => chooseTarget("end"));
dom("exaggeration").addEventListener("input", (event) => {
  state.exaggeration = Number(event.target.value);
  dom("exaggeration-value").textContent = state.exaggeration + "×";
  updateTerrainExaggeration();
});
for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
dom("map2d").addEventListener("click", pickFrom2D);
window.addEventListener("resize", () => { resize3D(); draw2D(); });
start();
