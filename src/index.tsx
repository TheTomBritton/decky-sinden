// Game Mode panel for the Sinden light gun. The driver (sindenrs) runs as a systemd user
// service; main.py starts and stops it and edits its config. This side shows the state,
// adds the browser arcade's games to the Steam library as Chrome kiosk shortcuts, and, in
// auto mode, switches the driver on while one of those shortcuts runs and off after, so
// the gun is not steering the cursor the rest of the time.

import { callable, definePlugin, toaster } from "@decky/api";
import {
  ButtonItem,
  Field,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { useEffect, useState } from "react";
import { GiCrosshair } from "react-icons/gi";

declare const SteamClient: any;

type Shortcuts = Record<string, number>; // game key -> Steam app id

interface Status {
  installed: boolean;
  running: boolean;
  autostart: boolean;
  gun: string | null;
  camera: string | null;
  tracking: { fps: number; found: number } | null;
  border: number;
  smoothing: number;
  auto: boolean;
  arcade_url: string;
  shortcuts: Shortcuts;
}

const getStatus = callable<[], Status>("status");
const setRunning = callable<[on: boolean], boolean>("set_running");
const setAutostart = callable<[on: boolean], boolean>("set_autostart");
const setBorder = callable<[pct: number], boolean>("set_border");
const setSmoothing = callable<[factor: number], boolean>("set_smoothing");
const setAuto = callable<[on: boolean], boolean>("set_auto");
const setShortcuts = callable<[shortcuts: Shortcuts], boolean>("set_shortcuts");

const GAMES: { key: string; name: string; path: string }[] = [
  { key: "timecrisis", name: "Time Crisis (Arcade)", path: "timecrisis/" },
  { key: "timecrisis2", name: "Time Crisis II (Arcade)", path: "timecrisis2/" },
  { key: "calibrate", name: "Light Gun Calibration", path: "calibrate/" },
];

// Chrome's flatpak in kiosk mode: no browser UI, the page fills the screen.
const FLATPAK = "/usr/bin/flatpak";
const chromeArgs = (url: string) =>
  `run --branch=stable --arch=x86_64 --command=/app/bin/chrome com.google.Chrome ` +
  `--kiosk --start-fullscreen --no-first-run --force-device-scale-factor=1 "${url}"`;

// Driver smoothing is a blend factor (1 = none, lower = steadier); the slider shows 0..10.
const toLevel = (factor: number) => Math.round((1 - factor) / 0.08);
const toFactor = (level: number) => 1 - level * 0.08;

async function addShortcuts(base: string, existing: Shortcuts): Promise<Shortcuts> {
  const out: Shortcuts = { ...existing };
  for (const g of GAMES) {
    const url = `${base.replace(/\/$/, "")}/${g.path}`;
    let id = out[g.key];
    if (!id) {
      id = await SteamClient.Apps.AddShortcut(g.name, FLATPAK, "/usr/bin", chromeArgs(url));
      out[g.key] = id;
    }
    SteamClient.Apps.SetShortcutName(id, g.name);
    SteamClient.Apps.SetShortcutExe(id, FLATPAK);
    SteamClient.Apps.SetShortcutLaunchOptions(id, chromeArgs(url));
  }
  return out;
}

function Content() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setSt(await getStatus());
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); await refresh(); }
  };

  if (!st) return <PanelSection><PanelSectionRow><Field label="Loading…" /></PanelSectionRow></PanelSection>;
  if (!st.installed)
    return (
      <PanelSection title="Driver">
        <PanelSectionRow>
          <Field label="sindenrs is not installed" description="Run tools/steamos/install.sh from the sindenrs repo in Desktop Mode." />
        </PanelSectionRow>
      </PanelSection>
    );

  const tracking = st.tracking
    ? `${st.tracking.fps} fps · border seen ${st.tracking.found}%`
    : st.running ? "starting…" : "off";

  return (
    <>
      <PanelSection title="Gun">
        <PanelSectionRow>
          <Field label={st.gun ? "Connected" : "Not connected"}
                 description={st.gun ? `${st.gun}${st.camera ? " · " + st.camera : ""}` : "Plug the gun into the Deck or its dock."} />
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Tracking" description={tracking} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Driver">
        <PanelSectionRow>
          <ToggleField label="Driver running" checked={st.running} disabled={busy}
            description="While on, the gun moves the mouse."
            onChange={(on: boolean) => act(() => setRunning(on))} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField label="On with arcade games" checked={st.auto} disabled={busy}
            description="Switch the driver on when an arcade shortcut starts and off when it ends."
            onChange={(on: boolean) => act(() => setAuto(on))} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField label="On all the time" checked={st.autostart} disabled={busy}
            description="Start the driver with every session."
            onChange={(on: boolean) => act(() => setAutostart(on))} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Tuning">
        <PanelSectionRow>
          <SliderField label="Border" value={st.border} min={1} max={6} step={1} showValue
            valueSuffix=" %" disabled={busy}
            description="Must match the border set in the arcade's calibration."
            onChange={(v: number) => act(() => setBorder(v))} />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField label="Driver smoothing" value={toLevel(st.smoothing)} min={0} max={10} step={1}
            showValue disabled={busy}
            description="Steadier aim for every game; the arcade has its own on top."
            onChange={(v: number) => act(() => setSmoothing(toFactor(v)))} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Arcade">
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy}
            description={Object.keys(st.shortcuts).length ? "In your library. Press again to refresh them." : "Time Crisis, Time Crisis II and the calibration, as Steam shortcuts."}
            onClick={() => act(async () => {
              const ids = await addShortcuts(st.arcade_url, st.shortcuts);
              await setShortcuts(ids);
              toaster.toast({ title: "Sinden Lightgun", body: "Arcade games added to your library" });
            })}>
            Add arcade to library
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  // auto mode: the driver follows the arcade shortcuts' lifetime
  let ours = new Set<number>();
  let startedByUs = false;
  const load = async () => {
    const st = await getStatus();
    ours = new Set(Object.values(st.shortcuts));
    return st;
  };
  load();
  const reg = SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
    async (n: { unAppID: number; bRunning: boolean }) => {
      const st = await load();
      if (!st.auto || !ours.has(n.unAppID)) return;
      if (n.bRunning && !st.running) {
        startedByUs = await setRunning(true);
      } else if (!n.bRunning && startedByUs && !st.autostart) {
        await setRunning(false);
        startedByUs = false;
      }
    });

  return {
    name: "Sinden Lightgun",
    titleView: <div className={staticClasses.Title}>Sinden Lightgun</div>,
    content: <Content />,
    icon: <GiCrosshair />,
    onDismount() { reg?.unregister?.(); },
  };
});
