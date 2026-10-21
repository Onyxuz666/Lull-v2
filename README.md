# Lull

A personal, offline sleep and mantra instrument for iPhone: your recorded voice looping and phasing, a just-intonation drone that swells in polyrhythm, tuned pulse rings, optional beats and noise, a sleep timer with wind-down, and lucid-dream cues. A 3D bubble on screen moves with the sound: tones bounce inside it tracing star shapes, the drone forms a knot of light at its center, and the skin shimmers with real soap-film colors (amber-only at night).

It is a plain web app (no build step) meant to be added to the iPhone home screen. Everything runs on the phone; recordings never leave it.

## Install on iPhone
1. Host this folder anywhere static (Netlify Drop, GitHub Pages). `index.html` must be at the root.
2. Open the URL in Safari → Share → Add to Home Screen.
3. Open it once while online; after that it works offline.

## Updating
Edit the files, bump `VERSION` in `sw.js`, redeploy. On the phone, open the app twice to pick up the new version.

## Versions
- This repository: v2, with the bubble visual and Visual tab.
- The original app (v1, flat orbit visualizer) is in [Onyxuz666/Lull](https://github.com/Onyxuz666/Lull), branch `v1-original`.

## Files
- `engine.js`: Web Audio engine (all rhythm runs on the audio clock).
- `app.js`: interface, settings, recorder, presets.
- `bubble.js`: the bubble visual (v2).
- `store.js`: recordings in IndexedDB.
- `sw.js`: offline cache.
- `fonts/`: Spectral (from `@fontsource/spectral`, SIL Open Font License).
- `icons/`: home-screen icons.
- `docs/build-notes.md`: how it was built and tested, and the iOS constraints.

The icons in this repository were redrawn in the original orbit motif; the first build's icon files were not kept.
