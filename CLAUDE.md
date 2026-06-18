# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# RULES TO ALWAYS FOLLOW:
- When explaining things, writing comments, always use concise plain english and use no jargon.

## What this game is

MegaChameleon is a single-player, in-browser hide-and-seek game inspired by *Meccha
Chameleon*. You hide a chameleon in a simple room, paint it to match the surface behind it,
and survive an AI seeker for up to 30 seconds. The twist: the game ships with a few built-in
rooms, and the player can optionally **upload an image to generate a new room**.

The seeker "finds" you when two things are true at once: it has a clear line of sight to the
chameleon, and the chameleon's color stands out from the surface behind it. These feed a
suspicion meter; if it fills before 30 seconds, you lose.

## Tech stack

Everything runs client-side in the browser. No backend for now.

- **TypeScript** + **Vite** (build/dev server) + **Three.js** (3D rendering).
- Plain HTML/CSS for menus/HUD, layered over the Three.js canvas (no React).
- **Node 22 required** (Vite needs `^20.19 || >=22.12`).

## Commands

```bash
npm install        # one-time, after cloning
npm run dev        # start the dev server (http://localhost:5173), auto-reloads on save
npm run build      # type-check (tsc) + production build into dist/
npm run preview    # serve the built dist/ locally to sanity-check a production build
```

There is no test suite yet. `npm run build` is the current correctness gate — it fails on
any TypeScript error.

## Current state

Phase 0–2 of the build plan are done: a working skeleton. `src/main.ts` sets up the
renderer, a fixed-size room (floor + 4 walls), a third-person camera, lights, a placeholder
spinning box, an on-screen HUD (game state + FPS), and the game loop. No real gameplay yet —
the chameleon, controls, painting, seeker AI, and the level system are still to come.

## Intended architecture (build toward this)

The one design rule that matters: **the game never cares how a room was made — it only asks
for a finished room.** Everything talks to a `LevelProvider` that returns a `LevelDefinition`
(room size, wall/floor textures, color palette, obstacle list, seeker start). Map-makers are
interchangeable implementations behind that interface:

- `BuiltInMaps` — 2–3 hand-made rooms (build first).
- `ImagePaletteProvider` — version 1 of the upload feature: read the image's main colors,
  texture the walls, place simple box obstacles. All in-browser, no AI.
- A future depth- or Gaussian-splat-based provider can replace the image one as a drop-in,
  touching nothing else. (Note: despite the README, splatting is a *possible later* map-maker,
  not the current rendering primitive — the room is normal Three.js meshes.)

The game loop, seeker AI, and painting UI only ever see a `LevelDefinition`.

## Performance gotchas (the ones that bite this design)

- **Color check:** decide "does the chameleon stand out?" from known surface colors via a
  backward ray — never by reading rendered pixels back from the GPU (that stalls the loop).
- **Switching maps:** Three.js does not auto-free a discarded room — explicitly dispose old
  geometry, materials, and textures on every map swap, or memory leaks until the tab crashes.
- **Uploaded images:** shrink to ~512px before using or reading colors, or the page freezes.
- **Pixel ratio** is capped at 2 in `main.ts` so high-resolution screens don't tank FPS.

## Conventions and environment

- Work as a single user. This project is owned by and developed as the **`vscode`** user
  (the account Claude Code runs as). Do not mix in another account — it causes file-ownership
  and git "dubious ownership" problems.
- A global gitignore (`~/.gitignore_global`) ignores any `claudehelp/` folder. Treat
  `claudehelp/` as local scratch that is never committed. The detailed design notes
  (`plan.md`, `p1plan.md`) live there, so they are **not** in a fresh clone — keep the
  essentials in this file.
