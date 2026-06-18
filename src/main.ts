import './style.css'
import * as THREE from 'three'
import amogusUrl from '../assets/amogus.jpeg' // Vite turns this into a bundled image URL

// ----- Game state: drives which menu shows and whether the simulation runs -----
type GameState = 'menu' | 'hiding' | 'seeking' | 'result'
let gameState: GameState = 'menu' // the game opens on the main menu
let paused = false                // Esc pause, only meaningful during hiding/seeking
let outcome: 'win' | 'lose' = 'win'
let seekTimeLeft = 0              // seconds left in the seek phase
let confirmingHide = false        // showing the "done hiding?" confirm
let paintMode = false             // painting sub-mode (Q during hiding); not a separate state

// ----- Renderer: draws the 3D picture onto the screen -----
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // cap pixels drawn (speed)
renderer.toneMapping = THREE.ACESFilmicToneMapping          // filmic look, gentle highlight rolloff
renderer.toneMappingExposure = 1.0
document.body.appendChild(renderer.domElement)

// ----- Scene: the list of everything in the world -----
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x202028)

// ----- Camera (its position is set every frame by the orbit code below) -----
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  200 // room is small; a near far-plane keeps the depth buffer precise for shadows + AO
)

// ----- Lights -----
// Simple, soft middleground: a hemisphere fill gives a gentle top-to-bottom gradient, a little
// ambient lifts the dark side, and one low directional light (no shadows) gives the model some
// form so it doesn't look flat. Surfaces still vary slightly by which way they face, so a painted
// color matches a wall closely but not exactly — a little positioning skill, which suits the game.
// (Milestone 4's seeker can compare the *lit* color — computed from known base color, light, and
// surface normal — not the raw base color, so its judgment matches what the player sees.)
scene.add(new THREE.HemisphereLight(0xfff3f6, 0x6a5054, 0.7)) // soft sky-pink / warm-ground fill
scene.add(new THREE.AmbientLight(0xffffff, 0.2))              // base fill
const sun = new THREE.DirectionalLight(0xffffff, 0.45)        // gentle form, no shadows
sun.position.set(12, 30, 18)
scene.add(sun)

// ----- The room: a floor and four walls -----
const ROOM = { width: 50, depth: 50, height: 30 }
const halfW = ROOM.width / 2
const halfD = ROOM.depth / 2
const t = 0.2 // wall thickness
const environment: THREE.Mesh[] = [] // room surfaces the eyedropper can sample colors from

const floor = new THREE.Mesh(
  new THREE.BoxGeometry(ROOM.width, 0.2, ROOM.depth),
  new THREE.MeshStandardMaterial({ color: 0xE8B0BE }) // floor: darker pink than the walls
)
floor.position.y = -0.1
scene.add(floor)
environment.push(floor)

const ceiling = new THREE.Mesh(
  new THREE.BoxGeometry(ROOM.width, 0.2, ROOM.depth),
  new THREE.MeshStandardMaterial({ color: 0xFFE9EF }) // ceiling: lighter pink than the walls
)
ceiling.position.y = ROOM.height + 0.1 // bottom face sits at the top of the walls
scene.add(ceiling)
environment.push(ceiling)

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xFFD9E1 })

// Build a wall material from an image. We use a FIXED 512x512 canvas (a power-of-two size, and
// never resized after the texture is made — resizing it later can leave the GPU texture stuck
// blank/black). It starts as a grey placeholder, then the image is drawn in once it loads. The
// canvas backs the texture so the eyedropper can read its pixels. The image stretches to fill the
// wall; matching its shape isn't needed.
function makeImageWall(imageUrl: string) {
  const SIZE = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#888888'           // placeholder shown until the image loads
  ctx.fillRect(0, 0, SIZE, SIZE)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace // treat as color, like the flat walls
  const material = new THREE.MeshStandardMaterial({ map: texture })
  const img = new Image()
  img.onload = () => {
    ctx.drawImage(img, 0, 0, SIZE, SIZE)
    texture.needsUpdate = true
  }
  img.src = imageUrl
  return { material, userData: { canvas, ctx, texture } }
}

function makeWall(
  w: number, h: number, d: number, x: number, y: number, z: number,
  material: THREE.Material = wallMaterial, userData: Record<string, unknown> = {}
) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  wall.position.set(x, y, z)
  wall.userData = userData
  scene.add(wall)
  environment.push(wall)
}
const amogusWall = makeImageWall(amogusUrl)
makeWall(ROOM.width, ROOM.height, t, 0, ROOM.height / 2, -halfD, amogusWall.material, amogusWall.userData) // back: image
makeWall(ROOM.width, ROOM.height, t, 0, ROOM.height / 2, halfD)  // front
makeWall(t, ROOM.height, ROOM.depth, -halfW, ROOM.height / 2, 0) // left
makeWall(t, ROOM.height, ROOM.depth, halfW, ROOM.height / 2, 0)  // right

// ----- The chameleon: a simple blocky humanoid -----
// We treat +z as "forward" (the face side). The group's origin is at the feet (y = 0).
const chameleon = new THREE.Group()
const SKIN = '#6abf69'          // the chameleon's starting green
const PAINT_CANVAS = 256        // per-part drawing canvas size in pixels (blocky model: plenty)
const paintableParts: THREE.Mesh[] = [] // every mesh you can paint on (filled by addPart)

// Rewrite a box's texture coordinates so each of its 6 faces gets its own patch of the canvas,
// instead of all six faces sharing the whole square (which would make paint bleed across faces).
function unwrapBoxFaces(geometry: THREE.BoxGeometry) {
  const uv = geometry.attributes.uv
  const cols = 3, rows = 2 // 6 cells, one per face
  for (let face = 0; face < 6; face++) {
    const col = face % cols
    const row = Math.floor(face / cols)
    for (let i = 0; i < 4; i++) {        // each face has 4 corners
      const k = face * 4 + i
      const u = uv.getX(k), v = uv.getY(k)
      uv.setXY(k, (col + u) / cols, (row + v) / rows) // squeeze the 0..1 face into this cell
    }
  }
  uv.needsUpdate = true
}

// helper: add one box part to the figure, with its own canvas + texture so it can be painted on.
// The canvas and its 2D context live on userData so the paint tools (and the future seeker's
// color check) can read and draw on the part directly.
function addPart(w: number, h: number, d: number, x: number, y: number, z: number) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = PAINT_CANVAS
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = SKIN
  ctx.fillRect(0, 0, PAINT_CANVAS, PAINT_CANVAS) // start fully green

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace // read the canvas as sRGB, like the walls' colors,
                                            // so the same hex renders the same on model and wall
  const geometry = new THREE.BoxGeometry(w, h, d)
  unwrapBoxFaces(geometry)

  const part = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture }))
  part.position.set(x, y, z)
  part.userData = { canvas, ctx, texture } // tools reach the drawing surface through here
  chameleon.add(part)
  paintableParts.push(part)
}

addPart(0.35, 0.9, 0.35, -0.22, 0.45, 0) // left leg
addPart(0.35, 0.9, 0.35,  0.22, 0.45, 0) // right leg
addPart(0.9,  0.9, 0.5,   0,    1.35, 0) // torso
addPart(0.5,  0.5, 0.5,   0,    2.05, 0) // head
addPart(0.2,  0.8, 0.2,  -0.62, 1.35, 0) // left arm
addPart(0.2,  0.8, 0.2,   0.62, 1.35, 0) // right arm

// a small dark "face" on the front of the head (+z) so you can tell which way it looks
const face = new THREE.Mesh(
  new THREE.BoxGeometry(0.3, 0.15, 0.1),
  new THREE.MeshStandardMaterial({ color: 0x223322 })
)
face.position.set(0, 2.05, 0.28)
chameleon.add(face)

chameleon.position.set(0, 0, 0)
scene.add(chameleon)

// ----- Keyboard input: remember which keys are held down -----
const keys: Record<string, boolean> = {}
window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true
  if (e.key === ' ') e.preventDefault() // stop the spacebar from scrolling the page
})
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false })

// ----- F toggles fullscreen -----
// Toggling fullscreen briefly drops pointer lock; we note the time so the pause logic
// (further down) knows that unlock came from fullscreen, not from the player pausing.
let lastFullscreenToggle = 0
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'f') return
  lastFullscreenToggle = performance.now()
  if (!document.fullscreenElement) document.documentElement.requestFullscreen()
  else document.exitFullscreen()
})

// ----- Mouse look (pointer lock) -----
// Click the game to capture the mouse. Then:
//   - moving the mouse orbits the camera (your facing does NOT change)
//   - holding the RIGHT mouse button turns the chameleon left/right instead
// Press Esc to release the mouse.
const canvas = renderer.domElement
const BASE_SENSITIVITY = 0.0025 // look speed at sensitivity = 1
let sensitivity = 1             // mouse-sensitivity multiplier (0-10), set from the pause menu
let camYaw = 0         // camera angle around the player (left/right)
let camPitch = 0.5     // camera angle up/down (radians)
const PITCH_MIN = -1.55 // look up from almost directly below the chameleon
const PITCH_MAX = 1.55  // look down from almost directly above (~99% of straight up/down; a hair short so the view can't flip)
let rotatingModel = false // is the right mouse button held?

canvas.addEventListener('click', () => {
  if (paintMode) return // in paint mode we keep the cursor free for the toolbar + aiming
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock()
})
canvas.addEventListener('contextmenu', (e) => e.preventDefault()) // free up the right button
window.addEventListener('mousedown', (e) => { if (e.button === 2) rotatingModel = true })
window.addEventListener('mouseup', (e) => { if (e.button === 2) rotatingModel = false })
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return // only when the mouse is captured
  const s = BASE_SENSITIVITY * sensitivity // current look speed (sensitivity 0-10 from the menu)
  if (rotatingModel) {
    chameleon.rotation.y -= e.movementX * s // turn the model left/right
  } else {
    camYaw -= e.movementX * s               // orbit the camera
    camPitch -= e.movementY * s
    camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, camPitch))
  }
})

// ----- Mouse wheel zooms (how far the camera orbits out) -----
let zoom = 1
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2.5
const ZOOM_SPEED = 0.0015
window.addEventListener('wheel', (e) => {
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + e.deltaY * ZOOM_SPEED))
}, { passive: true })

// ----- The on-screen text box -----
const hud = document.getElementById('hud') as HTMLDivElement

// ----- Screens & round flow -----
const screens = {
  menu: document.getElementById('menu') as HTMLDivElement,
  pause: document.getElementById('pause') as HTMLDivElement,
  settings: document.getElementById('settings') as HTMLDivElement,
  result: document.getElementById('result') as HTMLDivElement,
}
const confirmEl = document.getElementById('confirm') as HTMLDivElement
const resultTitle = document.getElementById('result-title') as HTMLHeadingElement
const sensInput = document.getElementById('sens-input') as HTMLInputElement
let settingsReturn: 'menu' | 'pause' = 'menu' // which menu Settings returns to

function hideAllScreens() {
  for (const el of Object.values(screens)) el.classList.add('hidden')
  confirmEl.classList.add('hidden')
}

function setState(next: GameState) {
  gameState = next
  paused = false
  confirmingHide = false
  paintMode = false // leaving any state cancels painting (toolbar is hidden by the flow)
  hideAllScreens()
  // menus need the cursor, so release the mouse if it was captured
  if ((next === 'menu' || next === 'result') && document.pointerLockElement) {
    document.exitPointerLock()
  }
  if (next === 'menu') screens.menu.classList.remove('hidden')
  if (next === 'result') screens.result.classList.remove('hidden')
  // 'hiding' and 'seeking' show no overlay — you're in the game
}

function startRound() {
  chameleon.position.set(0, 0, 0)
  chameleon.rotation.set(0, 0, 0)
  setState('hiding')
}

const SEEK_SECONDS = 30
function startSeek() {
  seekTimeLeft = SEEK_SECONDS
  setState('seeking')
}
function finishSeek(result: 'win' | 'lose') {
  outcome = result
  resultTitle.textContent = outcome === 'win' ? 'You survived!' : 'Caught!'
  setState('result')
}

function openSettings(returnTo: 'menu' | 'pause') {
  settingsReturn = returnTo
  sensInput.value = String(sensitivity)
  hideAllScreens()
  screens.settings.classList.remove('hidden')
}

// pause (Esc) only while playing
function pause() {
  if (gameState !== 'hiding' && gameState !== 'seeking') return
  paused = true
  screens.pause.classList.remove('hidden')
}
function resume() {
  paused = false
  screens.pause.classList.add('hidden')
}

// Tab pauses/resumes WITHOUT leaving fullscreen: unlike Esc, the browser doesn't bind Tab to
// exiting fullscreen/pointer lock, and the key still arrives while the mouse is captured. We
// release the mouse ourselves so the menu is clickable but fullscreen stays on.
// (Esc still works as a fallback: the browser releases the mouse on Esc, which the
// pointerlockchange handler below turns into a pause.)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  if (gameState !== 'hiding' && gameState !== 'seeking') return // only during play
  if (paintMode) return                                        // painting is its own calm sub-mode
  if (!screens.settings.classList.contains('hidden')) return   // ignore while Settings is open
  e.preventDefault() // stop Tab from moving keyboard focus
  if (paused) { resume(); canvas.requestPointerLock() } // resume and re-capture the mouse
  else { pause(); document.exitPointerLock() }          // free the cursor but stay in fullscreen
})
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) { resume(); return } // captured -> playing
  if (paintMode) return                                           // entering paint mode frees the cursor on purpose
  // A fullscreen toggle also drops the lock — that should NOT pause the game.
  if (performance.now() - lastFullscreenToggle < 1000) return
  pause()                                                          // genuine release (Esc / tab away) -> pause
})

// After a fullscreen change the lock is gone; if we're still playing, grab it back so
// looking continues without needing another click.
document.addEventListener('fullscreenchange', () => {
  if ((gameState === 'hiding' || gameState === 'seeking') && !paused && !paintMode &&
      document.pointerLockElement !== canvas) {
    canvas.requestPointerLock()
  }
})

// the Y / confirm / Y flow to finish hiding, plus the temporary Shift+Y backdoor
window.addEventListener('keydown', (e) => {
  if (paused) return // ignore while the pause menu is open
  const k = e.key.toLowerCase()
  if (gameState === 'hiding') {
    // Q toggles paint mode; while painting, 1-4 pick tools and Y/N hide-confirm is off
    if (k === 'q' && !confirmingHide) {
      paintMode = !paintMode
      if (paintMode) enterPaintMode()
      else exitPaintMode()
      return
    }
    if (paintMode) {
      if (TOOL_KEYS[k]) selectTool(TOOL_KEYS[k])
      return
    }
    if (k === 'y') {
      if (!confirmingHide) {
        confirmingHide = true
        confirmEl.classList.remove('hidden')
      } else {
        confirmEl.classList.add('hidden')
        startSeek()
      }
    } else if (k === 'n' && confirmingHide) {
      confirmingHide = false
      confirmEl.classList.add('hidden')
    }
  } else if (gameState === 'seeking') {
    // TEMP: Shift+Y ends the seek early (counts as a win) for testing — remove in Milestone 4
    if (k === 'y' && e.shiftKey) finishSeek('win')
  }
})

// menu buttons
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
  if (!Number.isNaN(v)) sensitivity = Math.max(0, Math.min(10, v))
  sensInput.value = String(sensitivity) // reflect the clamped value
})

setState('menu') // start on the main menu

// ----- Painting (Milestone 3): recolor the chameleon in a fixed-camera paint mode -----
const paintToolbar = document.getElementById('paint-toolbar') as HTMLDivElement
const currentColorEl = document.getElementById('current-color') as HTMLSpanElement
const colorInput = document.getElementById('color-input') as HTMLInputElement
const swatchesEl = document.getElementById('swatches') as HTMLSpanElement

type Tool = 'pencil' | 'brush' | 'fill' | 'pick'
let currentTool: Tool | null = 'pencil' // null = no tool, normal cursor
let currentColor = SKIN

// stand-in palette = the room's current colors; Milestone 5's LevelProvider replaces this
const ROOM_PALETTE = ['#FFD9E1', '#E8B0BE', '#FFE9EF', '#6abf69', '#ffffff', '#222222']

function setColor(hex: string) {
  currentColor = hex
  currentColorEl.style.background = hex
  colorInput.value = hex
}

// Each tool's cursor is a 32px PNG drawn from the *same* icon as its button, with a hotspot (the
// real click point). Emoji tools (pencil, brush) draw the glyph; SVG-icon tools (fill, pick)
// rasterize their <svg>. The hotspot is the icon's centre, except the eyedropper points from its
// tip. Rasterizing an SVG goes through Image().onload, so it fills in a moment after startup.
const TOOL_CURSORS: Partial<Record<Tool, string>> = {}
const TOOL_HOTSPOT: Record<Tool, [number, number]> = {
  pencil: [5, 27], brush: [6, 26], fill: [16, 16], pick: [6, 26], // pencil/brush/dropper tips at lower-left
}
function buildToolCursor(btn: HTMLButtonElement) {
  const tool = btn.dataset.tool as Tool
  const [hx, hy] = TOOL_HOTSPOT[tool]
  const finish = (dataUrl: string) => {
    TOOL_CURSORS[tool] = `url("${dataUrl}") ${hx} ${hy}, crosshair`
    updateCursor() // refresh in case this tool is already active (the SVG path is async)
  }
  const svg = btn.querySelector('svg')
  if (svg) {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = 32
      c.getContext('2d')!.drawImage(img, 0, 0, 32, 32)
      finish(c.toDataURL('image/png'))
    }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML)
  } else {
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const cx = c.getContext('2d')!
    cx.font = '24px serif'
    cx.textAlign = 'center'
    cx.textBaseline = 'middle'
    if (tool === 'pencil') { cx.translate(32, 0); cx.scale(-1, 1) } // flip tip to lower-left
    cx.fillText(btn.textContent?.trim() ?? '', 16, 17)
    finish(c.toDataURL('image/png'))
  }
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-toolbar .tool')) buildToolCursor(b)

// show the current tool's icon as the cursor while painting; normal cursor otherwise
// (falls back to a crosshair if an SVG cursor hasn't finished rasterizing yet)
function updateCursor() {
  if (!paintMode || !currentTool) { canvas.style.cursor = ''; return }
  canvas.style.cursor = TOOL_CURSORS[currentTool] ?? 'crosshair'
}

// switch tool + highlight its button (clicks AND number keys). Picking the active tool again
// turns it off (back to no tool / normal cursor).
function selectTool(tool: Tool) {
  currentTool = currentTool === tool ? null : tool
  for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-toolbar .tool')) {
    b.classList.toggle('selected', b.dataset.tool === currentTool)
  }
  updateCursor()
}

// number-key shortcuts: 1 pencil · 2 brush · 3 fill · 4 pick (handled in the keydown above)
const TOOL_KEYS: Record<string, Tool> = { '1': 'pencil', '2': 'brush', '3': 'fill', '4': 'pick' }

// build the swatch buttons from the palette
for (const hex of ROOM_PALETTE) {
  const s = document.createElement('span')
  s.className = 'swatch'
  s.style.background = hex
  s.addEventListener('click', () => setColor(hex))
  swatchesEl.appendChild(s)
}
colorInput.addEventListener('input', () => setColor(colorInput.value))
for (const btn of document.querySelectorAll<HTMLButtonElement>('#paint-toolbar .tool')) {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool as Tool))
}
setColor(SKIN) // start showing the green

// --- aiming + drawing ---
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()  // cursor in -1..1 screen coords (reused, no garbage)
const PENCIL_RADIUS = 4              // dot size on the 256px canvas
const BRUSH_RADIUS = 14
let painting = false                 // left button held while painting
let orbiting = false                 // right button held to orbit the camera
let lastUV: { part: THREE.Mesh; x: number; y: number } | null = null // for smooth lines

// find what the cursor is over; returns the part + pixel spot on its canvas, or null
function pickOnModel(e: MouseEvent) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(paintableParts, false)[0]
  if (!hit || !hit.uv) return null
  const part = hit.object as THREE.Mesh
  // texture v counts up, canvas y counts down — flip it
  return { part, x: hit.uv.x * PAINT_CANVAS, y: (1 - hit.uv.y) * PAINT_CANVAS }
}

// draw one round dot of the current color on a part's canvas
function stamp(part: THREE.Mesh, x: number, y: number, radius: number) {
  const { ctx, texture } = part.userData as { ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
  ctx.fillStyle = currentColor
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  texture.needsUpdate = true // tell Three.js the texture changed
}

// a drag = many dots; connect the last spot to this one so fast moves don't leave gaps
function paintAt(e: MouseEvent) {
  const spot = pickOnModel(e)
  if (!spot) { lastUV = null; return }
  const radius = currentTool === 'brush' ? BRUSH_RADIUS : PENCIL_RADIUS
  if (lastUV && lastUV.part === spot.part) {
    const steps = Math.ceil(Math.hypot(spot.x - lastUV.x, spot.y - lastUV.y) / (radius / 2))
    for (let i = 1; i <= steps; i++) {
      stamp(spot.part, lastUV.x + (spot.x - lastUV.x) * i / steps,
                       lastUV.y + (spot.y - lastUV.y) * i / steps, radius)
    }
  } else {
    stamp(spot.part, spot.x, spot.y, radius)
  }
  lastUV = { part: spot.part, x: spot.x, y: spot.y }
}

// fill = repaint every part's whole canvas the current color (the dark face stays as it is)
function fillAll() {
  for (const part of paintableParts) {
    const { ctx, texture } = part.userData as { ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
    ctx.fillStyle = currentColor
    ctx.fillRect(0, 0, PAINT_CANVAS, PAINT_CANVAS)
    texture.needsUpdate = true
  }
}

// pick = sample the color under the cursor, from the model OR a room surface
const pickTargets = [...environment, ...paintableParts] // everything the eyedropper can hit
function pickColor(e: MouseEvent) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(pickTargets, false)[0]
  if (!hit) return
  const obj = hit.object as THREE.Mesh
  const ctx = (obj.userData as { ctx?: CanvasRenderingContext2D }).ctx
  if (ctx && hit.uv) {
    // a canvas-textured surface (the model, or an image wall): read the exact pixel under the
    // cursor. Use the canvas's real size so it works for any texture, not just the 256px model.
    const p = ctx.getImageData(hit.uv.x * ctx.canvas.width, (1 - hit.uv.y) * ctx.canvas.height, 1, 1).data
    setColor('#' + [p[0], p[1], p[2]].map((n) => n.toString(16).padStart(2, '0')).join(''))
  } else {
    // a plain room surface (wall/floor/ceiling): read its known material color
    setColor('#' + (obj.material as THREE.MeshStandardMaterial).color.getHexString())
  }
}

function enterPaintMode() {
  document.exitPointerLock()              // show the real cursor for the toolbar + aiming
  paintToolbar.classList.remove('hidden')
  updateCursor()                          // show the selected tool's icon as the cursor
}
function exitPaintMode() {
  paintToolbar.classList.add('hidden')
  painting = false
  orbiting = false
  canvas.style.cursor = ''                // back to the normal cursor
}

// paint-mode mouse: left paints (or fills/picks), right-drag orbits the camera
window.addEventListener('mousedown', (e) => {
  if (!paintMode) return
  if (e.button === 2) { orbiting = true; return }         // right button orbits the camera
  if (e.button !== 0) return
  if (!currentTool) return                                // no tool selected → clicking does nothing
  if (currentTool === 'fill') fillAll()
  else if (currentTool === 'pick') pickColor(e)
  else { painting = true; lastUV = null; paintAt(e) }     // pencil / brush
})
window.addEventListener('mousemove', (e) => {
  if (!paintMode) return
  if (orbiting) {                                          // drag right button to look around
    const s = BASE_SENSITIVITY * sensitivity
    camYaw -= e.movementX * s
    camPitch -= e.movementY * s
    camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, camPitch))
    return
  }
  if (painting) paintAt(e)
})
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { painting = false; lastUV = null }
  if (e.button === 2) orbiting = false
})

// ----- Keep everything sized to the window -----
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

// ----- Settings reused every frame -----
const MOVE_SPEED = 6                  // horizontal units per second
const FLOAT_SPEED = 4                 // vertical units per second (Space up / Shift down)
const BODY_HX = 0.72                  // model half-width (arms reach widest)
const BODY_HY = 1.15                  // model half-height (feet to head)
const BODY_HZ = 0.33                  // model half-depth (front to back)
const CAM_MARGIN = 0.5                // keep the camera this far off the walls
const TORSO_HEIGHT = 1.35     // aim the camera at the torso, not the feet
const BASE_DISTANCE = 10      // camera distance at zoom = 1
const camPos = new THREE.Vector3()     // reused each frame (no garbage)
const lookTarget = new THREE.Vector3() // reused each frame (no garbage)
const bodyCenter = new THREE.Vector3() // reused each frame (no garbage)

// ----- The game loop -----
const clock = new THREE.Clock()
let fpsTimer = 0
let frames = 0
let fps = 0

function frame() {
  const delta = clock.getDelta() // seconds since the last frame

  // run the simulation only while playing and not paused; otherwise freeze and just draw
  const playing = gameState === 'hiding' || gameState === 'seeking'
  if (!playing || paused) {
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
    return
  }

  // count the seek timer down; running out = win (no seeker to catch you yet)
  if (gameState === 'seeking') {
    seekTimeLeft -= delta
    if (seekTimeLeft <= 0) finishSeek('win')
  }

  if (paintMode) {
    // painting: the body stays put; A/D only spin it in place so you can reach every side
    const TURN_SPEED = 1.6 // radians per second
    if (keys['a'] || keys['arrowleft'])  chameleon.rotation.y += TURN_SPEED * delta
    if (keys['d'] || keys['arrowright']) chameleon.rotation.y -= TURN_SPEED * delta
  } else {
    // --- UPDATE: move relative to where the camera is looking ---
    // The model's facing is NOT touched here; only the right mouse button turns it.
    const forwardX = -Math.sin(camYaw)
    const forwardZ = -Math.cos(camYaw)
    const rightX = Math.cos(camYaw)
    const rightZ = -Math.sin(camYaw)

    let drive = 0  // forward / back
    let strafe = 0 // right / left
    if (keys['w'] || keys['arrowup']) drive += 1
    if (keys['s'] || keys['arrowdown']) drive -= 1
    if (keys['d'] || keys['arrowright']) strafe += 1
    if (keys['a'] || keys['arrowleft']) strafe -= 1

    let moveX = forwardX * drive + rightX * strafe
    let moveZ = forwardZ * drive + rightZ * strafe
    if (moveX !== 0 || moveZ !== 0) {
      const len = Math.hypot(moveX, moveZ) // so diagonals aren't faster
      moveX /= len
      moveZ /= len
      chameleon.position.x += moveX * MOVE_SPEED * delta
      chameleon.position.z += moveZ * MOVE_SPEED * delta
    }

    // --- float up (Space) or sink down (Shift); it hovers when neither is held ---
    let lift = 0
    if (keys[' ']) lift += 1
    if (keys['shift']) lift -= 1
    chameleon.position.y += lift * FLOAT_SPEED * delta
  }

  // --- collision: keep the model's box inside the room on all three axes ---
  // We read the model's rotation to find how far its box reaches along each world axis
  // (its "shadow" on that axis). A flat side touches a wall/floor/ceiling with no gap; a
  // turn that would poke through tightens the limit and pushes the model back out.
  chameleon.updateMatrix()
  const m = chameleon.matrix.elements
  const ex = Math.abs(m[0]) * BODY_HX + Math.abs(m[4]) * BODY_HY + Math.abs(m[8]) * BODY_HZ
  const ey = Math.abs(m[1]) * BODY_HX + Math.abs(m[5]) * BODY_HY + Math.abs(m[9]) * BODY_HZ
  const ez = Math.abs(m[2]) * BODY_HX + Math.abs(m[6]) * BODY_HY + Math.abs(m[10]) * BODY_HZ
  bodyCenter.set(0, BODY_HY, 0).applyQuaternion(chameleon.quaternion) // box centre above the feet
  const innerX = halfW - t / 2
  const innerZ = halfD - t / 2
  chameleon.position.x = Math.max(-(innerX - ex) - bodyCenter.x, Math.min(innerX - ex - bodyCenter.x, chameleon.position.x))
  chameleon.position.z = Math.max(-(innerZ - ez) - bodyCenter.z, Math.min(innerZ - ez - bodyCenter.z, chameleon.position.z))
  chameleon.position.y = Math.max(ey - bodyCenter.y, Math.min(ROOM.height - ey - bodyCenter.y, chameleon.position.y))

  // --- orbit the camera around the chameleon, staying inside the room ---
  lookTarget.copy(chameleon.position)
  lookTarget.y += TORSO_HEIGHT // look at the torso, not the feet
  const dist = BASE_DISTANCE * zoom
  const cosP = Math.cos(camPitch)
  camPos.set(Math.sin(camYaw) * cosP, Math.sin(camPitch), Math.cos(camYaw) * cosP)
  camPos.multiplyScalar(dist).add(lookTarget)
  camPos.x = Math.max(-(halfW - CAM_MARGIN), Math.min(halfW - CAM_MARGIN, camPos.x))
  camPos.z = Math.max(-(halfD - CAM_MARGIN), Math.min(halfD - CAM_MARGIN, camPos.z))
  camPos.y = Math.max(0.5, camPos.y) // never drop below the floor
  camera.position.copy(camPos)
  camera.lookAt(lookTarget)

  // --- HUD: phase status + fps + controls (only updates while playing) ---
  frames++
  fpsTimer += delta
  if (fpsTimer >= 1) { fps = frames; frames = 0; fpsTimer = 0 }
  let status = ''
  let controls = 'click: look · WASD: move · Space/Shift: up/down · RMB: hold to turn · scroll: zoom · Tab: pause · F: fullscreen'
  if (paintMode) {
    status = 'PAINTING'
    controls = 'LMB: paint · 1-4: tools · RMB drag: orbit · A/D: turn model · scroll: zoom · Q: done'
  } else if (gameState === 'hiding') {
    status = confirmingHide ? 'HIDING — press Y to confirm, N to cancel'
                            : 'HIDING — press Y when done · Q: paint'
  } else if (gameState === 'seeking') {
    status = `SEEKING — ${Math.ceil(seekTimeLeft)}s left`
  }
  hud.textContent = `${status}\nfps ${fps} · ${controls}`

  // --- DRAW ---
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

frame() // start the loop
