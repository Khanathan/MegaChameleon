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

// ----- DOM -----
const screens = {
  menu: document.getElementById('menu') as HTMLDivElement,
  pause: document.getElementById('pause') as HTMLDivElement,
  settings: document.getElementById('settings') as HTMLDivElement,
  result: document.getElementById('result') as HTMLDivElement,
}
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
document.getElementById('btn-play')!.addEventListener('click', () => startRound())
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
function applyLevel(def: LevelDefinition) {
  loadLevel(def)
  buildSwatches(def.palette) // palette swatches are a painting concern, applied here after load
}
function setActiveMap(key: string) { // highlight the active button (a built-in id or 'upload')
  for (const b of mapListEl.querySelectorAll<HTMLButtonElement>('.map-btn')) {
    b.classList.toggle('selected', b.dataset.map === key)
  }
}
export function selectMap(id: string) {
  setActiveMap(id)
  BuiltInMaps.getLevel(id).then(applyLevel)
}
for (const id of Object.keys(MAPS)) {
  const b = document.createElement('button')
  b.className = 'map-btn'
  b.dataset.map = id
  b.textContent = MAPS[id].name
  b.addEventListener('click', () => selectMap(id))
  mapListEl.appendChild(b)
}

// upload-an-image option: a button that opens a hidden file picker; the image becomes a room via
// imageToLevel, then loadLevel — the same path the built-ins use
const uploadInput = document.createElement('input')
uploadInput.type = 'file'
uploadInput.accept = 'image/*'
uploadInput.style.display = 'none'
document.body.appendChild(uploadInput)
const uploadBtn = document.createElement('button')
uploadBtn.className = 'map-btn'
uploadBtn.dataset.map = 'upload'
uploadBtn.textContent = '+ Upload'
uploadBtn.addEventListener('click', () => uploadInput.click())
mapListEl.appendChild(uploadBtn)
uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files?.[0]
  uploadInput.value = '' // let the same file be picked again
  if (!file || !file.type.startsWith('image/')) return
  setActiveMap('upload')
  applyLevel(await imageToLevel(file))
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
