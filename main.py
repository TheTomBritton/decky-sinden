"""Decky backend for the Sinden light gun: runs the sindenrs driver's user service and edits
its configuration, so the gun can be switched on for a game and off again from Game Mode.

The plugin has no root flag, so this runs as the deck user. The driver itself is the
systemd user unit sindenrs.service (sindenrs-macos repo, tools/steamos/), and
`systemctl --user` needs the user's runtime directory and session bus, which a Decky
backend does not inherit; _env() supplies them.
"""

import asyncio
import json
import os
import pwd
import re

import decky

UNIT = "sindenrs.service"
SETTINGS_KEYS = {"auto": True, "arcade_url": "https://tombritton.co.uk/arcade", "shortcuts": {}}


def _user():
    return pwd.getpwnam(decky.DECKY_USER)


def _home():
    return decky.DECKY_USER_HOME


def _env():
    uid = _user().pw_uid
    env = dict(os.environ)
    env["XDG_RUNTIME_DIR"] = f"/run/user/{uid}"
    env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{uid}/bus"
    env["HOME"] = _home()
    return env


def _binary():
    return os.path.join(_home(), ".local/bin/sindenrs")


def _config_path():
    return os.path.join(_home(), ".config/sindenrs/config.toml")


async def _run(*args, timeout=10):
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=_env()
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, ""
    return proc.returncode, out.decode(errors="replace")


async def _systemctl(*args):
    return await _run("systemctl", "--user", *args)


GUN_IDS = {("16c0", p) for p in ("0f01", "0f02", "0f38", "0f39")}
CAMERA_VIDS = {"05a3", "32e4", "16d0"}


def _usb_devices():
    """The gun and its camera from sysfs. `sindenrs list` cannot see a gun the running
    driver holds open, so the panel reads the USB tree instead."""
    gun = camera = None
    root = "/sys/bus/usb/devices"
    for dev in os.listdir(root):
        def attr(name, dev=dev):
            try:
                with open(os.path.join(root, dev, name)) as f:
                    return f.read().strip()
            except OSError:
                return ""
        vid, pid = attr("idVendor"), attr("idProduct")
        if (vid, pid) in GUN_IDS:
            gun = attr("product") or "Sinden"
        elif vid in CAMERA_VIDS and attr("product").startswith("Sinden"):
            camera = attr("product")
    return gun, camera


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _display_value(text, key):
    """The value of `key` in the config's [display] table, or None."""
    section = None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s.strip("[] ")
        elif section == "display" and re.match(rf"{key}\s*=", s):
            return s.split("=", 1)[1].split("#", 1)[0].strip().strip('"')
    return None


def _set_display_value(text, key, value):
    """Set `key = value` in [display], keeping every other line (and its comments)."""
    lines = text.splitlines()
    section, start, end, found = None, None, len(lines), None
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("["):
            if section == "display" and end == len(lines):
                end = i
            section = s.strip("[] ")
            if section == "display":
                start = i
        elif section == "display" and re.match(rf"{key}\s*=", s):
            found = i
    if found is not None:
        lines[found] = f"{key} = {value}"
    elif start is not None:
        while end > start + 1 and not lines[end - 1].strip():
            end -= 1
        lines.insert(end, f"{key} = {value}")
    else:
        lines += ["", "[display]", f"{key} = {value}"]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------- settings file

_SETTINGS = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")


def _settings():
    try:
        with open(_SETTINGS) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    return {**SETTINGS_KEYS, **data}


def decky_settings_get(key):
    return _settings()[key]


def decky_settings_set(key, value):
    data = _settings()
    data[key] = value
    os.makedirs(os.path.dirname(_SETTINGS), exist_ok=True)
    with open(_SETTINGS, "w") as f:
        json.dump(data, f, indent=2)


class Plugin:
    # ------------------------------------------------------------------ status

    async def status(self):
        """Everything the panel shows, in one call."""
        installed = os.access(_binary(), os.X_OK)
        _, active = await _systemctl("is-active", UNIT)
        _, enabled = await _systemctl("is-enabled", UNIT)
        gun, camera = _usb_devices()
        tracking = None
        if active.strip() == "active":
            _, log = await _run("journalctl", "--user", "-u", UNIT, "-n", "4", "-o", "cat", "--no-pager")
            for line in reversed(ANSI.sub("", log).replace("\r", "\n").splitlines()):
                m = re.search(r"(\d+)fps found (\d+)%", line)
                if m:
                    tracking = {"fps": int(m.group(1)), "found": int(m.group(2))}
                    break
        cfg = ""
        try:
            with open(_config_path()) as f:
                cfg = f.read()
        except OSError:
            pass
        border = _display_value(cfg, "border_thickness")
        smoothing = _display_value(cfg, "hover_smoothing")
        return {
            "installed": installed,
            "running": active.strip() == "active",
            "autostart": enabled.strip() == "enabled",
            "gun": gun,
            "camera": camera,
            "tracking": tracking,
            "border": float(border) if border else 3.0,
            "smoothing": float(smoothing) if smoothing else 0.5,
            "auto": decky_settings_get("auto"),
            "arcade_url": decky_settings_get("arcade_url"),
            "shortcuts": decky_settings_get("shortcuts"),
        }

    # ------------------------------------------------------------------ driver

    async def set_running(self, on: bool):
        code, out = await _systemctl("start" if on else "stop", UNIT)
        if code:
            decky.logger.error(f"systemctl {'start' if on else 'stop'}: {out}")
        return code == 0

    async def set_autostart(self, on: bool):
        code, out = await _systemctl("enable" if on else "disable", UNIT)
        if code:
            decky.logger.error(f"systemctl enable/disable: {out}")
        return code == 0

    async def _set_config(self, key, value):
        try:
            with open(_config_path()) as f:
                text = f.read()
        except OSError:
            text = ""
        os.makedirs(os.path.dirname(_config_path()), exist_ok=True)
        with open(_config_path(), "w") as f:
            f.write(_set_display_value(text, key, value))
        _, active = await _systemctl("is-active", UNIT)
        if active.strip() == "active":
            await _systemctl("restart", UNIT)  # the driver reads its config at start
        return True

    async def set_border(self, pct: float):
        """The border the driver expects; the arcade's games draw it (same %)."""
        return await self._set_config("border_thickness", f"{max(1.0, min(6.0, float(pct))):.1f}")

    async def set_smoothing(self, factor: float):
        """The driver's hover smoothing: 1 = none, lower = steadier."""
        return await self._set_config("hover_smoothing", f"{max(0.1, min(1.0, float(factor))):.2f}")

    # ------------------------------------------------------------------ settings

    async def set_auto(self, on: bool):
        decky_settings_set("auto", bool(on))
        return True

    async def set_shortcuts(self, shortcuts: dict):
        decky_settings_set("shortcuts", shortcuts)
        return True

    async def _main(self):
        decky.logger.info("Sinden Lightgun plugin loaded")

    async def _unload(self):
        pass
