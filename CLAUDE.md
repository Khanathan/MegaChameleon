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

Milestones 1 and 2 are done (see the build order in `claudehelp/plan.md`). The whole game is
in `src/main.ts` (one file for now); `index.html` holds the menu overlays and `src/style.css`
the styling.

- **Room:** an enclosed 50×50×30 box (floor, 4 walls, ceiling), pink-toned.
- **Chameleon:** a blocky humanoid built from grouped boxes — a placeholder for a real model.
- **Movement/camera:** camera-relative WASD, Space/Shift to float up/down, right-mouse to
  turn the model (yaw only), an orbit camera via pointer-lock mouse-look, scroll to zoom.
  Full 3D collision keeps the body flush against walls/floor/ceiling (no gap, no clipping),
  computed from the model's rotation matrix ("box shadow" on each axis).
- **Round flow:** a `gameState` machine (`menu → hiding → seeking → result`) decides which
  overlay shows and whether the sim runs. Main menu (Play, Settings), hide phase, a 30-second
  seek with countdown, and a result screen, plus a shared Settings panel (mouse sensitivity).

Still to come: painting (M3), seeker AI + suspicion meter (M4), `LevelProvider` + built-in
maps (M5), image→room upload (M6), polish/deploy (M7).

## Decisions & gotchas to respect (don't "fix" these backwards)

- **Pause is Tab, not Esc.** Esc is hard-bound by browsers to release pointer lock AND exit
  fullscreen, and can't be `preventDefault`-ed — so Esc-as-pause kept dropping fullscreen. Tab
  has no such binding and still fires while the mouse is captured, so we pause/resume on Tab
  and re-capture the mouse on resume. Esc still works as a fallback (its unlock is caught by
  `pointerlockchange`).
- **Fullscreen vs pause:** toggling fullscreen (F) briefly drops pointer lock; we record the
  toggle time and ignore that unlock in `pointerlockchange` (so F doesn't pause), then re-grab
  the lock on `fullscreenchange`. Preserve this if you touch the pause/lock code.
- **TEMP backdoor:** during `seeking`, `Shift+Y` ends the seek early (always a win). **Remove
  it in Milestone 4** once the real seeker can end the round.
- **`noUnusedLocals` is on:** a variable that's only assigned but never read fails
  `npm run build`. Read it somewhere or remove it.

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
  `claudehelp/` as local scratch that is never committed. The detailed design + step-by-step
  plans (`plan.md` for the high-level milestones, `m1plan.md`/`m2plan.md`/… per milestone)
  live there, so they are **not** in a fresh clone — keep the essentials in this file, and
  read the relevant `mNplan.md` before starting a milestone.
- **Milestone git flow:** do each milestone on a `milestone-N-...` branch, commit, merge
  fast-forward into `main`, push, then delete the branch. The user edits `README.md` directly
  on GitHub, so `pull --rebase` if a push is rejected (changes won't conflict with `src/`).
