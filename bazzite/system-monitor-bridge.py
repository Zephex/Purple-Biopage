#!/usr/bin/env python3
"""Send live system stats from Bazzite to the Personal Bio page's system monitor panel."""

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".config/personal-bio/system-monitor-bridge.json"
INTERVAL = 15


def read_config():
    config = json.loads(CONFIG.read_text())
    base_url = config.get("site", "").rstrip("/")
    token = config.get("token", "")
    if not base_url.startswith("https://") or not token:
        raise RuntimeError("Config must contain an HTTPS site URL and connection token.")
    return base_url, token


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
    # Collect stats from every DRM card and prefer the one with the most VRAM
    # (typically the discrete GPU rather than the integrated one).
    best = None
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
        busy = _read_int(card / "device/gpu_busy_percent", -1)
        used = _read_int(card / "device/mem_info_vram_used")
        total = _read_int(card / "device/mem_info_vram_total")
        if busy < 0 and total <= 0:
            continue
        candidate = (total, busy if busy >= 0 else 0, card, used)
        if best is None or total > best[0]:
            best = candidate
    if best is not None:
        total, busy, card, used = best
        stats["gpuPercent"] = busy
        stats["gpuTemp"] = hwmon_temp("amdgpu", "radeon")
        if total:
            stats["gpuVramUsedBytes"] = used
            stats["gpuVramTotalBytes"] = total
        # Try to read a human-readable GPU name.
        name = ""
        for candidate_name in ("product_name", "label"):
            value = _read(card / "device" / candidate_name)
            if value:
                name = value
                break
        if not name and hwmon_temp("amdgpu", "radeon"):
            name = "AMD GPU"
        if name:
            stats["gpuName"] = name
    # Prefer NVIDIA (discrete) GPU when nvidia-smi is available.
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        for candidate in ("/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"):
            if Path(candidate).is_file():
                nvidia_smi = candidate
                break
    if nvidia_smi:
        try:
            output = subprocess.run(
                [nvidia_smi, "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=4, check=True,
            ).stdout.strip().splitlines()
            if output:
                parts = [p.strip() for p in output[0].split(",")]
                if len(parts) >= 5:
                    name, util, temp, used, total = parts[:5]
                    stats["gpuName"] = name
                    stats["gpuPercent"] = int(float(util))
                    stats["gpuTemp"] = round(float(temp), 1)
                    stats["gpuVramUsedBytes"] = int(float(used)) * 1024 * 1024
                    stats["gpuVramTotalBytes"] = int(float(total)) * 1024 * 1024
                    return stats
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


def main():
    site, token = read_config()
    print("System monitor bridge is running.", flush=True)
    last_error = ""
    while True:
        try:
            send_system_stats(site, token)
            last_error = ""
        except (OSError, ValueError, urllib.error.URLError, RuntimeError) as error:
            message = str(error)
            if message != last_error:
                print(f"Could not update system stats: {message}", flush=True)
                last_error = message
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
