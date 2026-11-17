#!/usr/bin/env python3
"""Changqu local server: static app, real-data refresh, live route proxy.

Standard library only. Binds to 127.0.0.1 by default. No API keys are stored.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parent
ROOT = APP.parent
DATA = APP / "data"
EVID = ROOT / "competition" / "evidence"
TZ = timezone(timedelta(hours=8))
PORT = int(os.environ.get("CHANGQU_PORT", "8765"))
HOST = os.environ.get("CHANGQU_HOST", "127.0.0.1")
REFRESH_LOCK = threading.Lock()
UA = "ChangquContest/1.0 (academic hackathon; local server)"
VALHALLA = "https://valhalla1.openstreetmap.de/route"
MODE_MAP = {"walk": "pedestrian", "pedestrian": "pedestrian", "bike": "bicycle", "bicycle": "bicycle", "drive": "auto", "auto": "auto"}


def now():
    return datetime.now(TZ).isoformat(timespec="seconds")


def load_json(path: Path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def decode_polyline6(encoded: str):
    coords = []
    index = lat = lon = 0
    length = len(encoded)
    while index < length:
        for target in ("lat", "lon"):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else (result >> 1)
            if target == "lat":
                lat += delta
            else:
                lon += delta
        coords.append([round(lon / 1e6, 6), round(lat / 1e6, 6)])
    return coords


def normalize_route(payload, frm, to, mode):
    trip = payload.get("trip") or {}
    summary = trip.get("summary") or {}
    geometry = []
    for leg in trip.get("legs", []):
        shape = leg.get("shape") or ""
        if not shape:
            continue
        part = decode_polyline6(shape)
        if geometry and part and geometry[-1] == part[0]:
            part = part[1:]
        geometry.extend(part)
    if not geometry and trip.get("shape"):
        geometry = decode_polyline6(trip.get("shape", ""))
    maneuvers = []
    for leg in trip.get("legs", []):
        for m in leg.get("maneuvers", []):
            maneuvers.append({
                "instruction": m.get("instruction") or "",
                "street": "、".join(m.get("street_names") or []) or "未命名道路",
                "length_km": round(float(m.get("length", 0)), 3),
                "time_s": round(float(m.get("time", 0)), 1),
                "type": m.get("type"),
                "begin": m.get("begin_shape_index"),
                "end": m.get("end_shape_index"),
            })
    return {
        "from": frm,
        "to": to,
        "mode": mode,
        "distance_km": round(float(summary.get("length", 0)), 3),
        "duration_min": round(float(summary.get("time", 0)) / 60, 1),
        "geometry": geometry,
        "maneuvers": maneuvers,
        "fetched_at": now(),
        "source": "Valhalla public instance (OSM data)",
        "cached": False,
    }


def place_coord(place_id):
    places = load_json(DATA / "places.json", {}).get("places", [])
    for place in places:
        if place["id"] == place_id:
            return place
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "ChangquLocal/1.0"

    def log_message(self, format, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:%d" % PORT)
        self.end_headers()
        self.wfile.write(body)

    def _safe_path(self, path: str):
        parsed = urllib.parse.urlparse(path)
        clean = urllib.parse.unquote(parsed.path)
        if clean in ("", "/"):
            clean = "/index.html"
        if ".." in clean or clean.startswith("/."):
            return None
        target = (APP / clean.lstrip("/")).resolve()
        try:
            target.relative_to(APP.resolve())
        except ValueError:
            return None
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return None
        return target

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            weather = load_json(DATA / "weather.json", {})
            meta = load_json(DATA / "meta.json", {})
            return self._json(200, {
                "ok": True,
                "app": "昌衢 Changqu",
                "version": meta.get("version"),
                "weather_status": weather.get("status"),
                "weather_last_update": weather.get("lastUpdate"),
                "server_time": now(),
                "offline_capable": True,
            })
        if parsed.path == "/api/route":
            return self.handle_route(parsed)
        if parsed.path == "/favicon.ico":
            target = APP / "favicon.svg"
        else:
            target = self._safe_path(self.path)
        if not target and parsed.path.startswith("/tiles/sat/"):
            target = APP / "tiles" / "sat_blank.jpg"
        elif not target and parsed.path.startswith("/tiles/"):
            # Graceful offline fallback: missing edge tiles become neutral land,
            # not broken images or black holes.
            target = APP / "tiles" / "blank.png"
        if not target or not target.is_file():
            return self._json(404, {"error": "not found"})
        body = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".json":
            content_type = "application/json; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        tile_rel = str(target).replace("\\", "/").split("/tiles/")[-1]
        if "/tiles/" in str(target).replace("\\", "/") and tile_rel.count("/") >= 2:
            self.send_header("Cache-Control", "public, max-age=3600")
        elif target.name in ("hub-data.js", "rail-official.js"):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/refresh":
            return self.handle_refresh()
        return self._json(404, {"error": "not found"})

    def handle_route(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        frm = (params.get("from") or [""])[0]
        to = (params.get("to") or [""])[0]
        mode = (params.get("mode") or ["auto"])[0]
        if not frm or not to or frm == to:
            return self._json(400, {"error": "起点/终点无效"})
        place_a = place_coord(frm)
        place_b = place_coord(to)
        if not place_a or not place_b:
            return self._json(400, {"error": "仅支持已登记的真实地点"})
        costing = MODE_MAP.get(mode)
        if not costing:
            return self._json(400, {"error": "不支持的出行方式"})
        payload = {
            "locations": [
                {"lat": place_a["lat"], "lon": place_a["lon"]},
                {"lat": place_b["lat"], "lon": place_b["lon"]},
            ],
            "costing": costing,
            "units": "kilometers",
            "language": "zh-CN",
            "directions_options": {"language": "zh-CN", "units": "kilometers"},
        }
        try:
            request = urllib.request.Request(VALHALLA, data=json.dumps(payload).encode("utf-8"),
                                             headers={"Content-Type": "application/json", "User-Agent": UA})
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
            parsed_payload = json.loads(raw)
            if not parsed_payload.get("trip"):
                return self._json(502, {"error": "路由服务未返回可用路径"})
            route = normalize_route(parsed_payload, frm, to, mode)
            EVID.mkdir(parents=True, exist_ok=True)
            with (EVID / "route-live.log").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"at": now(), "from": frm, "to": to, "mode": mode,
                                      "distance_km": route["distance_km"], "duration_min": route["duration_min"]},
                                     ensure_ascii=False) + "\n")
            return self._json(200, route)
        except Exception as error:
            return self._json(502, {"error": "在线路径请求失败：" + str(error)[:160]})

    def handle_refresh(self):
        if not REFRESH_LOCK.acquire(blocking=False):
            return self._json(429, {"error": "已有刷新任务在运行，请稍后再试"})
        try:
            script = APP / "scripts" / "fetch_data.py"
            result = subprocess.run([sys.executable, str(script), "--refresh"], cwd=str(ROOT),
                                    capture_output=True, text=True, timeout=150)
            if result.returncode != 0:
                return self._json(502, {"error": "刷新失败：" + (result.stderr or result.stdout or "未知错误")[-300:]})
            weather = load_json(DATA / "weather.json", {})
            return self._json(200, {
                "ok": True,
                "weather_last_update": weather.get("lastUpdate"),
                "weather_fetched_at": weather.get("fetched_at"),
                "refreshed_at": now(),
                "stdout": (result.stdout or "")[-300:],
            })
        except subprocess.TimeoutExpired:
            return self._json(504, {"error": "刷新超时；旧数据保留"})
        except Exception as error:
            return self._json(500, {"error": "刷新失败：" + str(error)[:200]})
        finally:
            REFRESH_LOCK.release()


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"昌衢 Changqu running at http://{HOST}:{PORT}/")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
