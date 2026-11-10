# Phone TV Remote

Turns your phone into a remote for smart TVs on your Wi-Fi. A small Node.js bridge runs on this PC
and speaks each TV's network protocol; your phone just opens a web page (installable as an app).

## Run

```
start.bat            (or: npm start)
```

Then on your phone (same Wi-Fi) open the URL printed in the console, or scan the QR code shown on
`http://localhost:8787/`. Install it with **Add to Home Screen**.

## Supported TVs

| TV | How it connects | First-time setup |
|---|---|---|
| Android TV / Google TV (Sony, TCL, Hisense, Philips, Xiaomi, Chromecast, Shield…) | Android TV Remote v2 | Type the code the TV shows |
| Samsung (2016+) | WebSocket 8002/8001 | Press **Allow** on the TV |
| LG webOS | SSAP WebSocket 3001/3000 | Accept the prompt on the TV |
| Roku | ECP (HTTP 8060) | none (Roku OS: *Control by mobile apps* = Default) |
| Sony Bravia (non-Google) | IRCC + JSON-RPC | Older models: 4-digit PIN on the TV. 2015+: Pre-Shared Key under IP control |
| Test TV | Opens `/tv.html` | none, for trying the app without a TV |

Power-on uses Wake-on-LAN (the TV's MAC is captured when you pair).

Saved TVs and pairing keys live in `data/tvs.json`. Change the port with `PORT=9000`.

## Infrared (experimental, not in the app)

An earlier version could also drive TVs without Wi-Fi through two IR LEDs wired into the headphone
jack. It is not part of the current app. The code is kept in [`experimental/infrared/`](experimental/infrared/),
and the last version with it wired in is tagged [`v1.0.4-infrared`](../../tree/v1.0.4-infrared).

## Ubuntu Touch app

`ubuntu-touch/` packages everything (bundled Node.js for arm64 + the bridge on 127.0.0.1:18787 +
`webapp-container`) as a confined click app (`ubuntu-webapp` AppArmor template). Build and install
on a phone connected over adb (developer mode on):

```
NODE_ARM64=/path/to/node-v24.x-linux-arm64 ADB=adb bash ubuntu-touch/build.sh
```

It builds with `click build` on the phone and installs through the system click service
(`com.lomiri.click`), so no sudo password is needed. Bump `version` in `ubuntu-touch/manifest.json`
for each reinstall. The built `.click` is copied to `dist/` (that file is what goes to the OpenStore). To launch from adb, export `XDG_RUNTIME_DIR=/run/user/32011` first
(otherwise the window can't reach the display server); tapping the icon needs nothing.

## License

MIT. The Ubuntu Touch package bundles the Node.js binary (MIT, its license ships as `bin/NODE-LICENSE`).
