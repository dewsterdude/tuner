# tuner

Instrument Tuning Application — a fully client-side, mobile-friendly web tuner.

## Capabilities

- Supports **Guitar** (acoustic/electric), **Bass Guitar**, **Ukulele**, **Banjo** (5-string, open G), and **Mandolin**, each with standard tuning
- **YIN pitch detection** running locally in the browser via the Web Audio API — no backend, no network calls after page load
- Automatic detection of the closest string for the current instrument
- Large note display with octave, target frequency, and live frequency / cents readout
- **Macro arrow meter** (`> > > O < < <`) lighting progressively at 5¢ / 15¢ / 30¢ off pitch, turning red past 30¢
- **Fine-tuning needle bar** showing exact cents-from-target on a ±50¢ scale with a green ±2¢ target zone
- **Sustained-lock detection**: must hold within ±2¢ across multiple frames before declaring "in tune", to avoid false locks during the attack of a note
- **Whole-app green background** flash when locked in tune
- Automatic state reset when the mic goes quiet, so switching strings doesn't drag the previous reading into the new one
- Frame-to-frame jump detection (>80¢) for instant re-lock when moving to a new note
- Mobile-first layout with large touch targets, safe-area insets, and screen-wake-lock to keep the display on while tuning
- Instrument-aware buffer sizing (larger buffer for bass to resolve low E1 ≈ 41 Hz)
- **Installable PWA with offline support** — add to home screen on iOS or Android and the tuner works without a network connection
