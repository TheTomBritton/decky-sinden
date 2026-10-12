# Sinden Lightgun for Decky

Game Mode controls for a Sinden light gun on the Steam Deck, driving the
[sindenrs](https://github.com/thetombritton/sindenrs-macos) driver (installed with its
`tools/steamos/install.sh`, which puts the binary in `~/.local/bin` and a
`sindenrs.service` systemd user unit in place).

- Gun and camera status, live tracking rate.
- Driver on/off, on with the arcade games only (default), or on all the time.
- Border size (must match the border the arcade's calibration sets) and driver smoothing.
- Adds the browser arcade (tombritton.co.uk/arcade: Time Crisis, Time Crisis II, the light
  gun calibration) to the Steam library as Chrome kiosk shortcuts.

## Build

    npm install && npm run build
    ./package.sh          # out/decky-sinden.zip

Install the zip from Decky's Settings → Developer → Install plugin from ZIP / URL.
