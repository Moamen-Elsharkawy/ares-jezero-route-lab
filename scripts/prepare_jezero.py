#!/usr/bin/env python3
"""Create a small OFFLINE Mars heightfield and georeferenced texture from a real USGS HiRISE COG.

Never synthesize elevations. Reject missing coverage, projection mismatch, unrealistic values.
Re-run: python scripts/prepare_jezero.py
Requires: rasterio, numpy, Pillow, requests.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)

STAC_ITEM = "DTEEC_045994_1985_046060_1985_U01"
STAC_API = "https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms/items/" + STAC_ITEM
BASE = "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_045994_1985_ESP_046060_1985/"
DEM = BASE + STAC_ITEM + ".tif"
ORTHO = BASE + "ESP_045994_1985_RED_C_01_ORTHO.tif"
MARS_RADIUS_M = 3396190
LAT = 18.43  # inside west delta region of Jezero; not an asserted rover sampling location
LON = 77.445
EXTENT_PROJECTED_M = 1600.0
N = 257


def sample(url: str, bounds: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray, dict]:
    with rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
        GDAL_HTTP_MAX_RETRY="3",
        GDAL_HTTP_RETRY_DELAY="1",
    ):
        with rasterio.open(url) as raster:
            if raster.crs is None or "Mars" not in raster.crs.to_wkt():
                raise ValueError("Input must carry a Mars planetary CRS, not Earth CRS")
            a = raster.read(
                1,
                window=from_bounds(*bounds, transform=raster.transform),
                out_shape=(N, N),
                resampling=Resampling.bilinear,
                masked=True,
                boundless=True,
            )
            data = a.astype("float64").filled(np.nan)
            data = data * raster.scales[0] + raster.offsets[0]
            valid = np.isfinite(data) & (np.abs(data) < 100000)
            info = {
                "source_crs": raster.crs.to_string(),
                "source_gsd_m": float(abs(raster.transform.a)),
                "scale": float(raster.scales[0]),
                "offset": float(raster.offsets[0]),
                "source_dimensions": [raster.width, raster.height],
            }
            return data, valid, info


def make_texture(height: np.ndarray, valid: np.ndarray, texture: np.ndarray | None):
    # Raster-derived hillshade, with optional orthoimage microtexture. No fictitious elevations.
    fill = np.where(valid, height, np.nanmedian(height[valid]))
    dx = (EXTENT_PROJECTED_M / (N - 1)) * math.cos(math.radians(LAT))
    dy = EXTENT_PROJECTED_M / (N - 1)
    gy, gx = np.gradient(fill, dy, dx)
    nx, ny, nz = -gx, -gy, np.ones_like(gx)
    unit = np.sqrt(nx * nx + ny * ny + nz * nz)
    light = np.array([-0.38, -0.43, 0.82])
    light /= np.linalg.norm(light)
    bright = np.clip((nx * light[0] + ny * light[1] + nz * light[2]) / unit, 0.15, 1)
    lo, hi = np.percentile(height[valid], [5, 95])
    t = np.clip((fill - lo) / max(1, hi - lo), 0, 1)
    low = np.array([86, 58, 47], dtype=float)
    high = np.array([225, 166, 104], dtype=float)
    palette = low[None, None, :] * (1 - t[:, :, None]) + high[None, None, :] * t[:, :, None]
    if texture is not None:
        tx = np.nan_to_num(texture, nan=float(np.nanmedian(texture[np.isfinite(texture)])))
        tlo, thi = np.percentile(tx[np.isfinite(tx)], [5, 95])
        detail = np.clip((tx - tlo) / max(1.0, thi - tlo), 0, 1)
        factor = 0.72 + detail * 0.52
    else:
        factor = np.ones_like(bright)
    rgb = np.clip(palette * (0.4 + 0.68 * bright[:, :, None]) * factor[:, :, None], 0, 255).astype("uint8")
    rgb[~valid] = [16, 22, 32]
    Image.fromarray(rgb, "RGB").save(OUT / "jezero-surface.png", optimize=True)


def main():
    center_x = math.radians(LON) * MARS_RADIUS_M
    center_y = math.radians(LAT) * MARS_RADIUS_M
    bounds = (
        center_x - EXTENT_PROJECTED_M / 2,
        center_y - EXTENT_PROJECTED_M / 2,
        center_x + EXTENT_PROJECTED_M / 2,
        center_y + EXTENT_PROJECTED_M / 2,
    )
    print("Downloading sampled window of real USGS HiRISE DEM (not a full 150MB GeoTIFF)...", flush=True)
    elevations, valid, dem_info = sample(DEM, bounds)
    percent = valid.mean() * 100
    if percent < 85:
        raise RuntimeError(f"DEM covers only {percent:.1f}% of selected region; do not interpolate unknown terrain")
    median = float(np.nanmedian(elevations[valid]))
    if not (-5000 < median < -1000):
        raise RuntimeError(f"Unexpected Jezero datum/elevation ({median}); abort to avoid fabricating data")
    print("DEM valid:", f"{percent:.1f}%", "min/max", elevations[valid].min(), elevations[valid].max(), flush=True)
    texture = None
    try:
        print("Loading matching USGS orthorectified HiRISE image...", flush=True)
        o, m, ortho_info = sample(ORTHO, bounds)
        if m.mean() > 0.85:
            texture = np.where(m, o, np.nan)
        else:
            print("Ortho coverage is insufficient; visualisation will be DEM-derived hillshade", flush=True)
    except Exception as exc:
        print("Ortho unavailable; visualisation will be DEM-derived hillshade:", str(exc)[:200], flush=True)
    make_texture(elevations, valid, texture)
    meters_y = EXTENT_PROJECTED_M / (N - 1)
    meters_x = meters_y * math.cos(math.radians(LAT))
    # Geographic metadata from actual Mars projection: x=R*lon_rad, y=R*lat_rad.
    result = {
        "dataset": "USGS HiRISE SOCET stereo DTM (not synthetic)",
        "stacItem": STAC_ITEM,
        "stacUrl": STAC_API,
        "demUrl": DEM,
        "orthoUrl": ORTHO if texture is not None else None,
        "source": "NASA MRO HiRISE / USGS Astrogeology; CC0 1.0",
        "crs": dem_info["source_crs"],
        "planetRadiusM": MARS_RADIUS_M,
        "centerLat": LAT,
        "centerLon": LON,
        "geographicBounds": {
            "west": math.degrees(bounds[0] / MARS_RADIUS_M),
            "east": math.degrees(bounds[2] / MARS_RADIUS_M),
            "south": math.degrees(bounds[1] / MARS_RADIUS_M),
            "north": math.degrees(bounds[3] / MARS_RADIUS_M),
        },
        "gridSize": N,
        "widthM": meters_x * (N - 1),
        "heightM": meters_y * (N - 1),
        "cellSizeXM": meters_x,
        "cellSizeYM": meters_y,
        "projectedWindowM": EXTENT_PROJECTED_M,
        "sourceGsdM": dem_info["source_gsd_m"],
        "verticalDatum": "Mars areoid (USGS HiRISE DTM controlled to MOLA)",
        "validPercent": round(percent, 3),
        "minElevationM": round(float(elevations[valid].min()), 2),
        "maxElevationM": round(float(elevations[valid].max()), 2),
        "textureKind": "HiRISE orthoimage-enhanced DEM hillshade" if texture is not None else "DEM-derived hillshade",
        "texture": "/data/jezero-surface.png",
        "elevations": [round(float(x), 2) if ok else None
                       for x, ok in zip(elevations.ravel(), valid.ravel())],
    }
    target = OUT / "jezero-grid.json"
    target.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    sig = hashlib.sha256(target.read_bytes()).hexdigest()
    print(f"CREATED {target.name}: {target.stat().st_size} bytes; SHA256={sig}", flush=True)
    print(f"CREATED texture: {(OUT / 'jezero-surface.png').stat().st_size} bytes", flush=True)


if __name__ == "__main__":
    main()
