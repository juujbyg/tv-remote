# Infrared through the headphone jack (experimental)

Not used by the app. Kept for a possible future version.

Phones without an IR emitter can send IR with two IR LEDs wired **anti-parallel between the Left and
Right contacts** of a 3.5 mm plug (ground unused). `ir.js` renders each code as audio at half the
carrier frequency on L and inverted on R, so the LEDs flash at the full 36–40 kHz. Media volume must
be at maximum.

- `ir.js`: code sets (Samsung, LG/Vizio, Sony, Panasonic, Toshiba, Philips RC5/RC6), Pronto import,
  audio rendering and playback.
- `ir.test.mjs`: renders every code, demodulates it like a TV receiver and decodes it back.
  Run `node experimental/infrared/ir.test.mjs`.

The version of the app with this wired into the UI (IR TVs, code search, custom Pronto codes) is
tagged `v1.0.4-infrared`.
