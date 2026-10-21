# Lull: build notes

Personal, offline iPhone web app (installed to the home screen) for sleep, mantra and polyrhythm listening. Built 2026-10-08. Source files are saved alongside this note in `claude/lull-source/`.

## What it does
- **Voice**: record mantras (raw mic capture, trimmed and normalized), or import audio files; tick several to loop in order. Pause between repeats, speed (tape-style pitch), 1–4 copies that drift apart (Reich-style phasing), brightness (low-pass), ping-pong echo, shared convolution reverb (generated impulse).
- **Drone**: partials of the key in just intonation; each partial's volume swells at a rate taken from the rhythm (e.g. 3:4:5 → 1,3,4,5,1.5,2,2.5 swells per cycle), all peaking together at the top of each cycle. Depth, shape (smooth → pulsing), reverb.
- **Pulse**: one ring per rhythm number; tuned strikes per cycle on harmony notes. Soft/glass/bell, register, density, ring, variation (seeded drops over up to 4 cycles), reverb. Pre-rendered into a looping buffer aligned to the cycle clock.
- **Beats**: binaural (headphones), monaural, or pulsed (AM). Optional glide over the sleep timer. Framed honestly: texture, not brainwave claims.
- **Noise**: brown/pink, brightness, waves (one swell per cycle).
- **Global**: cycle length, rhythm (2:3 … 3:5:7:8), key, harmony (overtone, open fifths, minor, pentatonic).
- **Sleep**: timer with exponential fade, wind-down (darkens + voice recedes), overall brightness, lucid cues (TLR-style; chime or a mantra; start/interval/count/volume; practice button), dark screen (pure black, double-tap to return).
- **Presets**: Descent (default), Lucid night, Phase study, Clear mind, Deep drone; user presets saved locally.

## v2 (2026-10-19): the bubble
The flat orbit visualizer is replaced by a 3D bubble drawn from the live sound (`bubble.js`), with its own **Visual** tab.
- **Skin**: a sphere of 1,800–4,200 jittered points (Fibonacci layout, more on bigger screens). The root partial makes the whole bubble breathe; each higher drone partial drives one spherical-harmonic mode (l,m) = (2,2) (3,1) (4,0) (5,5) (6,3) (7,0), at that partial's swell rate. Colors are real thin-film interference (water film, n = 1.33) with the film draining thinner toward the top, plus Fresnel.
- **Color**: Night = the film under one amber wavelength (589 nm, a sodium lamp), so no blue light. Full wheel = RGB interference colors, hue from the key around the circle of fifths. Auto = Night whenever the sleep timer is on.
- **Bouncing tones**: one ball per pulse ring. A ball bouncing in a sphere stays in one plane, so n evenly spaced hits per lap trace a polygon or star {n/p}; all balls meet at the top on the first beat of each cycle. Each ball keeps an afterimage of its last lap, and the vertices it just struck glow. Variation drops make no ripple (the ball bounces on silently).
- **Ripples**: every strike sends a ring across the skin that refocuses at the opposite point about 2.3 s later.
- **Knot**: the drone's partials as a 3D harmonograph (partials assigned to x/y/z in turn), scaled up until it presses on the skin: contacts glow and bulge the film, strikes pluck it, voice shells light it.
- **Voice echoes**: each voice copy sends a shell out from the centre while it speaks. `engine.voiceInfo` (start time, loop length per copy, spoken segments) was added for this.
- **Haze**: noise waves, swelling once per cycle.
- Calm by design: nothing flashes faster than about once a second; the beats are never drawn. Wind-down dims the bubble with the sound.
- Visual tab: on/off, brightness, color (Night / Full wheel / Auto), each layer switchable, hue from key or fixed, and the faint bubble on the dark screen (moved here from Sleep).
- Performance: drawn by additive point splats into a half-resolution float buffer, tone-mapped, then scaled up; pixel ratio capped so the stage stays under ~12 ms a frame. Stage redraws every 32 ms, dark screen every 66 ms.
- Tested (headless Chromium, 390×844): no console errors, Visual tab and every switch, dark screen, presets (Phase study in Full wheel), voice shells timed to a recorded mantra. Not testable here: real iPhone frame rate and battery.

## Architecture
- `engine.js`: Web Audio engine. All rhythm runs on the audio clock (oscillators + looped buffers + scheduled automation), so no JS timers are needed for sound. LFOs use phase-rotated PeriodicWaves so rebuilds stay aligned to the shared cycle origin `t0`. Live changes crossfade. Inaudible keep-alive noise (~-74 dB). Layer balance via `LAYER_MAX`.
- `app.js`: UI (schema-driven panels), state in localStorage, recorder, wake lock, resume overlay, presets, and the frame loop that feeds the bubble.
- `bubble.js` (v2): the bubble visual; reads settings and the engine's cycle clock, rhythm pattern and voice timing.
- `store.js`: IndexedDB for recordings (Int16 PCM at 48 kHz), decode/trim/normalize, WAV encode.
- `sw.js`: offline cache (cache-first, background refresh). **Bump `VERSION` on every update.**
- Assets: Spectral 300/300-italic/400 woff2 from npm `@fontsource/spectral`; icons drawn with PIL (orbit motif).

## iOS constraints (checked Oct 2026)
- Home-screen web apps stop audio when the phone locks or the app leaves the screen. Workaround: Screen Wake Lock (works in home-screen apps since iOS 18.4) + black screen; session end releases the lock.
- `navigator.audioSession.type = 'playback'` so the silent switch doesn't mute Web Audio.
- iOS 26.0–26.1 had a home-screen-app Web Audio bug, reported fixed in 26.2.
- Resume after interruption restarts the engine at the same elapsed session time (more reliable than resume()).

## Hosting / updating
- Hosted via Netlify Drop (drag `lull.zip`, claim with a free account). Open the URL in Safari on iPhone → Share → Add to Home Screen. Open once online; then it works offline.
- To update: edit files, bump `VERSION` in `sw.js`, zip with `index.html` at the root, drag onto the site's Deploys page in Netlify. On the phone, open the app twice to pick up the new version.

## Tested (headless Chromium)
Offline renders of every layer (no NaN, no clipping, levels balanced: full mix ≈ -21 dB RMS); 13 live parameter changes mid-render with no clicks (max sample jump 0.019 without voice); binaural verified at 194/198 Hz; UI flows at 390×844: record (raw path), play, presets, dark screen, timer end, lucid cue then stop, offline reload with saved recordings. Not testable here: real iPhone audio, mic permission UI, wake lock.

## Ideas for later
- Export a seamless loop to a file for lock-screen playback in another player.
- Reverse-voice layer, octave-down shadow copy, per-mantra gaps.
- Sync voice loop length to whole cycles (fully periodic option).
