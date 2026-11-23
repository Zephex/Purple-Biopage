#!/usr/bin/env python3
"""Send Steam and Spotify presence from Bazzite to the Personal Bio page."""

import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".config/personal-bio/steam-bridge.json"
INTERVAL = 15


def read_config():
    config = json.loads(CONFIG.read_text())
    base_url = config.get("site", "").rstrip("/")
    token = config.get("token", "")
    if not base_url.startswith("https://") or not token:
        raise RuntimeError("Config must contain an HTTPS site URL and connection token.")
    return base_url, token


def steam_roots():
    home = Path.home()
    candidates = [
        home / ".steam/steam",
        home / ".local/share/Steam",
        home / ".var/app/com.valvesoftware.Steam/.local/share/Steam",
    ]
    found = []
    for path in candidates:
        try:
            resolved = path.resolve(strict=True)
            if resolved not in found and (resolved / "steamapps").is_dir():
                found.append(resolved)
        except OSError:
            pass
    return found


def library_paths():
    libraries = []
    for root in steam_roots():
        for path in [root, root / "steamapps"]:
            if path.name == "steamapps":
                libraries.append(path)
        vdf = root / "steamapps/libraryfolders.vdf"
        try:
            contents = vdf.read_text(errors="replace")
            for raw in re.findall(r'"path"\s+"((?:\\.|[^"])*)"', contents):
                decoded = raw.replace('\\\\', '\\').replace('\\"', '"')
                libraries.append(Path(decoded) / "steamapps")
        except OSError:
            pass
    return list(dict.fromkeys(path for path in libraries if path.is_dir()))


def installed_games():
    games = {}
    for library in library_paths():
        for manifest in library.glob("appmanifest_*.acf"):
            app_id = manifest.stem.removeprefix("appmanifest_")
            try:
                contents = manifest.read_text(errors="replace")
            except OSError:
                continue
            name = re.search(r'"name"\s+"((?:\\.|[^"])*)"', contents)
            if name:
                games[app_id] = name.group(1).replace('\\"', '"').replace('\\\\', '\\')
    return games


def running_game(games):
    candidates = []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            values = {}
            for entry in (proc / "environ").read_bytes().split(b"\0"):
                if b"=" in entry:
                    key, value = entry.split(b"=", 1)
                    if key in (b"SteamAppId", b"SteamGameId", b"STEAM_COMPAT_APP_ID"):
                        values[key.decode()] = value.decode(errors="ignore")
            app_id = values.get("SteamGameId") or values.get("SteamAppId") or values.get("STEAM_COMPAT_APP_ID") or ""
            if not app_id.isdigit() or int(app_id) <= 0:
                command_line = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="ignore")
                match = re.search(r"(?:^|\s)(?:AppId=|--appid[= ])(\d+)", command_line, re.IGNORECASE)
                app_id = match.group(1) if match else ""
            if not app_id.isdigit() or int(app_id) <= 0:
                continue
            stat = (proc / "stat").read_text()
            start_ticks = int(stat[stat.rfind(")") + 2:].split()[19])
            candidates.append((start_ticks, app_id))
        except (OSError, ValueError, IndexError, PermissionError):
            continue
    if not candidates:
        return None
    _, app_id = max(candidates)
    return {"gameId": app_id, "game": games.get(app_id, f"Steam game {app_id}")}


def detect_steam_id():
    vdf = Path.home() / ".steam/steam/config/loginusers.vdf"
    try:
        text = vdf.read_text(errors="replace")
    except OSError:
        return ""
    # Collect all Steam IDs with their timestamps; pick the most recently used.
    candidates = []
    current = ""
    timestamp = "0"
    for line in text.splitlines():
        stripped = line.strip()
        match = re.match(r'^"(\d{17})"\s*$', stripped)
        if match:
            if current:
                candidates.append((timestamp, current))
            current = match.group(1)
            timestamp = "0"
            continue
        if current:
            ts_match = re.search(r'"timestamp"\s+"(\d+)"', stripped)
            if ts_match:
                timestamp = ts_match.group(1)
    if current:
        candidates.append((timestamp, current))
    if not candidates:
        return ""
    candidates.sort()
    return candidates[-1][1]


def fetch_steam_profile(steam_id):
    """Return (avatar_url, status) for the given Steam ID, or ('', '') on failure."""
    if not steam_id:
        return "", ""
    try:
        with urllib.request.urlopen(f"https://steamcommunity.com/profiles/{steam_id}/?xml=1", timeout=10) as response:
            xml = response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError):
        return "", ""
    avatar_match = re.search(r"<avatarFull>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</avatarFull>", xml, re.DOTALL)
    avatar_url = avatar_match.group(1).strip() if avatar_match else ""
    state_match = re.search(r"<onlineState>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</onlineState>", xml, re.DOTALL)
    state = state_match.group(1).strip().lower() if state_match else ""
    return avatar_url, state


def send_presence(site, token, game, avatar_url="", steam_status=""):
    payload = {
        "playing": bool(game),
        "game": game["game"] if game else "",
        "gameId": game["gameId"] if game else "",
        "avatarUrl": avatar_url,
        "steamStatus": steam_status,
    }
    request = urllib.request.Request(
        site + "/api/steam/presence",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


# --- System monitor -------------------------------------------------------

_last_cpu = None
_last_net = None


def _read(path, default=""):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return default


def _read_int(path, default=0):
    try:
        return int(Path(path).read_text().strip())
    except (OSError, ValueError):
        return default


def cpu_percent():
    global _last_cpu
    try:
        fields = [int(value) for value in _read("/proc/stat").splitlines()[0].split()[1:]]
    except (IndexError, ValueError):
        return 0.0
    if len(fields) < 4:
        return 0.0
    total = sum(fields)
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    if _last_cpu is None:
        _last_cpu = (total, idle)
        return 0.0
    total_delta = total - _last_cpu[0]
    idle_delta = idle - _last_cpu[1]
    _last_cpu = (total, idle)
    if total_delta <= 0:
        return 0.0
    return round(max(0.0, 100.0 * (1 - idle_delta / total_delta)), 1)


def memory_stats():
    info = {}
    for line in _read("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts:
            info[key] = int(parts[0]) * 1024
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", info.get("MemFree", 0))
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    return {
        "ramUsedBytes": max(0, total - available),
        "ramTotalBytes": total,
        "swapUsedBytes": max(0, swap_total - swap_free),
        "swapTotalBytes": swap_total,
    }


def hwmon_temp(*names):
    for hwmon in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
        name = _read(hwmon / "name").lower()
        if not any(candidate in name for candidate in names):
            continue
        for sensor in sorted(hwmon.glob("temp*_input")):
            value = _read_int(sensor)
            if value > 0:
                return round(value / 1000, 1)
    return 0


def gpu_stats():
    stats = {}
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
        busy = _read_int(card / "device/gpu_busy_percent", -1)
        if busy >= 0:
            stats["gpuPercent"] = busy
            stats["gpuTemp"] = hwmon_temp("amdgpu", "radeon")
            used = _read_int(card / "device/mem_info_vram_used")
            total = _read_int(card / "device/mem_info_vram_total")
            if total:
                stats["gpuVramUsedBytes"] = used
                stats["gpuVramTotalBytes"] = total
            return stats
    if shutil.which("nvidia-smi"):
        try:
            output = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=4, check=True,
            ).stdout.strip().splitlines()
            if output:
                name, util, temp, used, total = [part.strip() for part in output[0].split(",")]
                stats["gpuName"] = name
                stats["gpuPercent"] = int(float(util))
                stats["gpuTemp"] = round(float(temp), 1)
                stats["gpuVramUsedBytes"] = int(float(used)) * 1024 * 1024
                stats["gpuVramTotalBytes"] = int(float(total)) * 1024 * 1024
        except (subprocess.SubprocessError, ValueError, IndexError):
            pass
    return stats


def net_rates():
    global _last_net
    received = sent = 0
    for iface in Path("/sys/class/net").iterdir():
        if iface.name == "lo":
            continue
        received += _read_int(iface / "statistics/rx_bytes")
        sent += _read_int(iface / "statistics/tx_bytes")
    now = time.monotonic()
    if _last_net is None:
        _last_net = (now, received, sent)
        return 0.0, 0.0
    elapsed = max(0.001, now - _last_net[0])
    rates = (max(0.0, (received - _last_net[1]) / elapsed), max(0.0, (sent - _last_net[2]) / elapsed))
    _last_net = (now, received, sent)
    return rates


def cpu_model():
    for line in _read("/proc/cpuinfo").splitlines():
        if line.lower().startswith("model name"):
            return line.split(":", 1)[1].strip()
    return ""


def os_name():
    for line in _read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return "Linux"


def system_stats():
    stats = {
        "hostname": os.uname().nodename,
        "os": os_name(),
        "cpuModel": cpu_model(),
        "cpuPercent": cpu_percent(),
        "cpuTemp": hwmon_temp("k10temp", "coretemp", "zenpower", "cpu"),
        "load1": round(os.getloadavg()[0], 2),
    }
    try:
        uptime = float(_read("/proc/uptime", "0").split()[0])
        stats["uptimeSeconds"] = int(uptime)
    except (IndexError, ValueError):
        stats["uptimeSeconds"] = 0
    try:
        usage = shutil.disk_usage("/")
        stats["diskUsedBytes"] = usage.used
        stats["diskTotalBytes"] = usage.total
    except OSError:
        pass
    stats.update(memory_stats())
    stats.update(gpu_stats())
    received, sent = net_rates()
    stats["netRxBytesPerSec"] = round(received)
    stats["netTxBytesPerSec"] = round(sent)
    return stats


def send_system_stats(site, token):
    request = urllib.request.Request(
        site + "/api/system/stats",
        data=json.dumps(system_stats()).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def spotify_track():
    """Read the Spotify desktop player's current track through MPRIS/playerctl."""
    if not shutil.which("playerctl"):
        raise RuntimeError("playerctl is missing; install it on Bazzite to enable Spotify presence.")
    try:
        status = subprocess.run(
            ["playerctl", "--player=spotify", "status"],
            capture_output=True, text=True, timeout=4, check=True,
        ).stdout.strip().lower()
        if status != "playing":
            return None
        output = subprocess.run(
            ["playerctl", "--player=spotify", "--format",
             "{{title}}\t{{artist}}\t{{album}}\t{{mpris:artUrl}}\t{{xesam:url}}", "metadata"],
            capture_output=True, text=True, timeout=4, check=True,
        ).stdout.strip()
        fields = (output.split("\t", 4) + [""] * 5)[:5]
        title, artist, album, art_url, media_url = (value.strip() for value in fields)
        if not title:
            return None
        if not re.match(r"^https://i\.scdn\.co/", art_url, re.IGNORECASE):
            art_url = ""
        spotify_url = ""
        match = re.match(r"^(?:https://open\.spotify\.com/|spotify:)(track|episode)[/:]([A-Za-z0-9]+)", media_url, re.IGNORECASE)
        if match:
            spotify_url = f"https://open.spotify.com/{match.group(1).lower()}/{match.group(2)}"
        return {"playing": True, "song": title, "artist": artist, "album": album, "albumArtUrl": art_url, "spotifyUrl": spotify_url}
    except subprocess.CalledProcessError:
        return None
    except subprocess.TimeoutExpired:
        return None


def send_spotify_presence(site, token, track):
    payload = track or {"playing": False}
    request = urllib.request.Request(
        site + "/api/spotify/presence",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def main():
    site, token = read_config()
    print("Steam, Spotify, and system monitor bridge is running.", flush=True)
    last_error = ""
    steam_id = detect_steam_id()
    avatar_url = ""
    steam_status = ""
    avatar_refresh_at = 0
    while True:
        try:
            game = running_game(installed_games())
            now = time.time()
            if now >= avatar_refresh_at:
                new_avatar, new_status = fetch_steam_profile(steam_id)
                if new_avatar:
                    avatar_url = new_avatar
                if new_status:
                    steam_status = new_status
                avatar_refresh_at = now + 300
            send_presence(site, token, game, avatar_url, steam_status)
            send_spotify_presence(site, token, spotify_track())
            send_system_stats(site, token)
            last_error = ""
        except (OSError, ValueError, urllib.error.URLError, RuntimeError) as error:
            message = str(error)
            if message != last_error:
                print(f"Could not update presence: {message}", flush=True)
                last_error = message
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
