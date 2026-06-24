// Screens + round-flow state machine, the Settings panel, the map picker (built-ins + image
// upload), and the HUD text. This is the orchestrator: it owns setState and wires the menu buttons.
import { scene, canvas } from './engine'
import { chameleon } from './chameleon'
import { game, settings, DEFAULT_MOVE_SPEED } from './state'
import type { GameState } from './state'
import { loadLevel, BuiltInMaps, MAPS } from './levels'
import type { LevelDefinition } from './levels'
import { spawnSeeker, seeker, suspicionBar } from './seeker'
import { buildSwatches } from './painting'
import { imageToLevel } from './imageLevel'
import { imageToSplatLevel, plyToSplatLevel } from './splatLevel'
import { canExportSplat, exportSplatPly, canExportPano, fetchPanoBlob } from './splatRoom'
import { errText } from './errors'

// ----- DOM -----
const screens = {
  menu: document.getElementById('menu') as HTMLDivElement,
  pause: document.getElementById('pause') as HTMLDivElement,
  settings: document.getElementById('settings') as HTMLDivElement,
  result: document.getElementById('result') as HTMLDivElement,
}
const loadingEl = document.getElementById('loading') as HTMLDivElement
const loadingText = document.getElementById('loading-text') as HTMLParagraphElement
let busy = false // true while a splat room is generating; blocks Play + map swaps
const confirmEl = document.getElementById('confirm') as HTMLDivElement
const howtoEl = document.getElementById('howto') as HTMLDivElement // top-right how-to-play card
const resultTitle = document.getElementById('result-title') as HTMLHeadingElement
const sensInput = document.getElementById('sens-input') as HTMLInputElement
const speedInput = document.getElementById('speed-input') as HTMLInputElement
const speedNote = document.getElementById('speed-note') as HTMLParagraphElement
const hud = document.getElementById('hud') as HTMLDivElement
const mapListEl = document.getElementById('map-list') as HTMLDivElement
speedNote.textContent = `Default: ${DEFAULT_MOVE_SPEED}` // small note of the default speed
let settingsReturn: 'menu' | 'pause' = 'menu' // which menu Settings returns to

export const SEEK_TIME = 20
export const SEEK_GRACE = 3 // head start: the seeker animates but can't actually detect for this long

// ----- Screens / state machine -----
function hideAllScreens() {
  for (const el of Object.values(screens)) el.classList.add('hidden')
  confirmEl.classList.add('hidden')
}

export function setState(next: GameState) {
  game.state = next
  game.paused = false
  game.confirmingHide = false
  game.paintMode = false // leaving any state cancels painting (toolbar is hidden by the flow)
  hideAllScreens()
  // menus need the cursor, so release the mouse if it was captured
  if ((next === 'menu' || next === 'result') && document.pointerLockElement) {
    document.exitPointerLock()
  }
  if (next === 'menu') screens.menu.classList.remove('hidden')
  if (next === 'result') screens.result.classList.remove('hidden')
  if (next !== 'seeking') scene.remove(seeker) // the seeker only exists during the seek phase
  suspicionBar.classList.toggle('hidden', next !== 'seeking') // meter only shows during the seek
  howtoEl.classList.toggle('hidden', next !== 'hiding')       // how-to card only during hiding
}

function startRound() {
  chameleon.position.set(0, 0, 0)
  chameleon.rotation.set(0, 0, 0)
  setState('hiding')
}

export function startSeek() {
  game.seekTimeLeft = SEEK_TIME
  spawnSeeker()
  setState('seeking')
  canvas.requestPointerLock() // capture the mouse so you can look around right away
}

export function finishSeek(result: 'win' | 'lose') {
  resultTitle.textContent = result === 'win' ? 'You survived!' : 'SUS'
  setState('result')
}

function openSettings(returnTo: 'menu' | 'pause') {
  settingsReturn = returnTo
  sensInput.value = String(settings.sensitivity)
  speedInput.value = String(settings.moveSpeed)
  hideAllScreens()
  screens.settings.classList.remove('hidden')
}

// pause/resume (used by input's Tab + pointer-lock handling)
export function pause() {
  if (game.state !== 'hiding' && game.state !== 'seeking') return
  game.paused = true
  screens.pause.classList.remove('hidden')
}
export function resume() {
  game.paused = false
  screens.pause.classList.add('hidden')
}
export function isSettingsOpen() {
  return !screens.settings.classList.contains('hidden')
}
export function showConfirm(visible: boolean) {
  confirmEl.classList.toggle('hidden', !visible)
}

// ----- Menu + settings buttons -----
document.getElementById('btn-play')!.addEventListener('click', () => { if (!busy) startRound() })
document.getElementById('btn-menu-settings')!.addEventListener('click', () => openSettings('menu'))
document.getElementById('btn-pause-settings')!.addEventListener('click', () => openSettings('pause'))
document.getElementById('btn-result-menu')!.addEventListener('click', () => setState('menu'))
document.getElementById('btn-settings-back')!.addEventListener('click', () => {
  hideAllScreens()
  if (settingsReturn === 'menu') screens.menu.classList.remove('hidden')
  else screens.pause.classList.remove('hidden')
})
document.getElementById('btn-settings-apply')!.addEventListener('click', () => {
  const v = parseFloat(sensInput.value)
  if (!Number.isNaN(v)) settings.sensitivity = Math.max(0, Math.min(10, v))
  sensInput.value = String(settings.sensitivity) // reflect the clamped value
  const sp = parseFloat(speedInput.value)
  if (!Number.isNaN(sp)) settings.moveSpeed = Math.max(1, Math.min(20, sp))
  speedInput.value = String(settings.moveSpeed) // reflect the clamped value
})

// ----- Map picker (built-ins + image upload) -----
async function applyLevel(def: LevelDefinition) {
  await loadLevel(def) // async: a splat room builds (network + lift) before this resolves
  buildSwatches(def.palette) // palette swatches are a painting concern, applied here after load
  refreshDownloadButton() // show "Download splat" only when the loaded room is a splat
}
function setActiveMap(key: string) { // highlight the active button (a built-in id or 'upload')
  for (const b of mapListEl.querySelectorAll<HTMLButtonElement>('.map-btn')) {
    b.classList.toggle('selected', b.dataset.map === key)
  }
}
export function selectMap(id: string) {
  setActiveMap(id)
  BuiltInMaps.getLevel(id).then(applyLevel).catch((err) => showLoadError(`Couldn't load "${id}"`, err))
}
for (const id of Object.keys(MAPS)) {
  const b = document.createElement('button')
  b.className = 'map-btn'
  b.dataset.map = id
  b.textContent = MAPS[id].name
  b.addEventListener('click', () => selectMap(id))
  mapListEl.appendChild(b)
}

// File-picker map options ("+ Upload", "+ 3D Splat", "+ Import Splat"): each is a menu button
// backed by a hidden file input. addPicker wires the button + input and runs `onFile` with the
// chosen file. Picking is blocked while a slow load is already running (busy).
function addPicker(key: string, label: string, accept: string, onFile: (file: File) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.style.display = 'none'
  document.body.appendChild(input)
  const btn = document.createElement('button')
  btn.className = 'map-btn'
  btn.dataset.map = key
  btn.textContent = label
  btn.addEventListener('click', () => { if (!busy) input.click() })
  mapListEl.appendChild(btn)
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    input.value = '' // let the same file be picked again
    if (file) onFile(file)
  })
}

// Show a failed load to the player (in the overlay, auto-dismissed) and log the full error — with
// its `cause` chain — to the console for debugging. `prefix` says which flow failed; the stage that
// actually broke is already baked into the error message by the `step`/labels upstream.
function showLoadError(prefix: string, err: unknown) {
  console.error(`${prefix}:`, err) // full object incl. cause/stack for the dev console
  loadingEl.classList.remove('hidden')
  loadingText.textContent = `${prefix}: ${errText(err)}`
  setTimeout(() => loadingEl.classList.add('hidden'), 6000)
}

// Run a slow level load behind the loading overlay: blocks Play + map swaps (busy), streams
// progress, and shows a message on failure. `produce` builds the LevelDefinition (it may report
// progress through the passed callback). Never rejects — failures are surfaced in the overlay.
async function runLevelLoad(
  key: string,
  produce: (onProgress: (msg: string) => void) => Promise<LevelDefinition>,
  failMsg: string,
) {
  setActiveMap(key)
  busy = true
  loadingEl.classList.remove('hidden')
  loadingText.textContent = 'Loading…'
  try {
    const def = await produce((msg) => { loadingText.textContent = msg })
    await applyLevel(def)
    loadingEl.classList.add('hidden')
  } catch (err) {
    showLoadError(failMsg, err)
  } finally {
    busy = false
  }
}

// upload an image -> a flat textured room (M6). Fast (shrinks to <=512px), so no loading overlay —
// only the error overlay if it fails.
addPicker('upload', '+ Upload', 'image/*', async (file) => {
  if (!file.type.startsWith('image/')) return
  setActiveMap('upload')
  try {
    await applyLevel(await imageToLevel(file))
  } catch (err) {
    showLoadError('Building the room failed', err)
  }
})

// upload an image -> a Gaussian-splat room (M7): network (hallucinate a 360 room + estimate depth),
// then lift + bake during loadLevel. Slow, so it runs behind the overlay with Play disabled.
addPicker('splat', '+ 3D Splat', 'image/*', (file) => {
  if (!file.type.startsWith('image/')) return
  runLevelLoad('splat', (onProgress) => imageToSplatLevel(file, onProgress), 'Splat generation failed')
})

// import a ready-made .ply splat -> a room directly (no network). loadLevel fetches + parses the
// file's bytes (via splatUrl); we revoke the temporary blob URL once that load is done with it.
addPicker('import', '+ Import Splat', '.ply', (file) => {
  if (!file.name.toLowerCase().endsWith('.ply')) return
  const def = plyToSplatLevel(file)
  runLevelLoad('import', async (onProgress) => { onProgress('Reading splat file…'); return def }, 'Splat import failed')
    .finally(() => URL.revokeObjectURL(def.splatUrl!))
})

// ----- Download the generated splat (.ply) -----
// The button lives in the menu and only shows when the loaded room is a splat (canExportSplat).
// Clicking serializes the in-memory points to a .ply blob and saves it via a throwaway link.
const downloadSplatBtn = document.getElementById('btn-download-splat') as HTMLButtonElement
const downloadPanoBtn = document.getElementById('btn-download-pano') as HTMLButtonElement
function refreshDownloadButton() {
  downloadSplatBtn.classList.toggle('hidden', !canExportSplat())
  // the panorama download only applies to AI-generated rooms (the lift path), not imported .ply files
  downloadPanoBtn.classList.toggle('hidden', !canExportPano())
}
// save a blob to disk via a throwaway link (shared by both download buttons)
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
downloadSplatBtn.addEventListener('click', () => {
  const blob = exportSplatPly()
  if (blob) saveBlob(blob, 'megachameleon-room.ply')
})
downloadPanoBtn.addEventListener('click', async () => {
  // fetching the remote image can fail (network/CORS), so guard it and surface any error like a load.
  try {
    const pano = await fetchPanoBlob()
    if (pano) saveBlob(pano.blob, `megachameleon-panorama.${pano.ext}`)
  } catch (err) {
    showLoadError('Downloading the panorama failed', err)
  }
})

// ----- HUD text (called every frame by the loop) -----
let fpsTimer = 0, frames = 0, fps = 0
export function updateHud(delta: number) {
  frames++
  fpsTimer += delta
  if (fpsTimer >= 1) { fps = frames; frames = 0; fpsTimer = 0 }
  let status = ''
  let controls = 'click: look · WASD: move · Space/Shift: up/down · RMB: hold to turn · scroll: zoom · Tab: pause · F: fullscreen'
  if (game.paintMode) {
    status = 'PAINTING'
    controls = 'LMB: paint · 1-4: tools · RMB drag: orbit · A/D: turn model · scroll: zoom · Q: done'
  } else if (game.state === 'hiding') {
    status = game.confirmingHide ? 'HIDING — press Y to confirm, N to cancel'
                                 : 'HIDING — press Y when done · Q: paint'
  } else if (game.state === 'seeking') {
    status = `SEEKING — ${Math.ceil(game.seekTimeLeft)}s left`
    controls = 'WASD: fly · Space/Shift: up/down · mouse: look · scroll: — · Tab: pause · F: fullscreen'
  }
  hud.textContent = `${status}\nfps ${fps} · ${controls}`
}
