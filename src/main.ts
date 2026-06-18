import './style.css'
import * as THREE from 'three'

// ----- Game state: drives which menu shows and whether the simulation runs -----
type GameState = 'menu' | 'hiding' | 'seeking' | 'result'
let gameState: GameState = 'menu' // the game opens on the main menu
let paused = false                // Esc pause, only meaningful during hiding/seeking
let outcome: 'win' | 'lose' = 'win'
let seekTimeLeft = 0              // seconds left in the seek phase
let confirmingHide = false        // showing the "done hiding?" confirm

// ----- Renderer: draws the 3D picture onto the screen -----
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // cap pixels drawn (speed)
document.body.appendChild(renderer.domElement)

// ----- Scene: the list of everything in the world -----
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x202028)

// ----- Camera (its position is set every frame by the orbit code below) -----
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
)

// ----- Lights -----
scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 0.8)
sun.position.set(5, 10, 7)
scene.add(sun)

// ----- The room: a floor and four walls -----
const ROOM = { width: 50, depth: 50, height: 30 }
const halfW = ROOM.width / 2
const halfD = ROOM.depth / 2
const t = 0.2 // wall thickness

const floor = new THREE.Mesh(
  new THREE.BoxGeometry(ROOM.width, 0.2, ROOM.depth),
  new THREE.MeshStandardMaterial({ color: 0xE8B0BE }) // floor: darker pink than the walls
)
floor.position.y = -0.1
scene.add(floor)

const ceiling = new THREE.Mesh(
  new THREE.BoxGeometry(ROOM.width, 0.2, ROOM.depth),
  new THREE.MeshStandardMaterial({ color: 0xFFE9EF }) // ceiling: lighter pink than the walls
)
ceiling.position.y = ROOM.height + 0.1 // bottom face sits at the top of the walls
scene.add(ceiling)

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xFFD9E1 })
function makeWall(w: number, h: number, d: number, x: number, y: number, z: number) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMaterial)
  wall.position.set(x, y, z)
  scene.add(wall)
}
makeWall(ROOM.width, ROOM.height, t, 0, ROOM.height / 2, -halfD) // back
makeWall(ROOM.width, ROOM.height, t, 0, ROOM.height / 2, halfD)  // front
makeWall(t, ROOM.height, ROOM.depth, -halfW, ROOM.height / 2, 0) // left
makeWall(t, ROOM.height, ROOM.depth, halfW, ROOM.height / 2, 0)  // right

// ----- The chameleon: a simple blocky humanoid -----
// We treat +z as "forward" (the face side). The group's origin is at the feet (y = 0).
const chameleon = new THREE.Group()
const skinMaterial = new THREE.MeshStandardMaterial({ color: 0x6abf69 }) // green for now

// helper: add one box part to the figure at the given size and position
function addPart(w: number, h: number, d: number, x: number, y: number, z: number) {
  const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), skinMaterial)
  part.position.set(x, y, z)
  chameleon.add(part)
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
  if (!screens.settings.classList.contains('hidden')) return   // ignore while Settings is open
  e.preventDefault() // stop Tab from moving keyboard focus
  if (paused) { resume(); canvas.requestPointerLock() } // resume and re-capture the mouse
  else { pause(); document.exitPointerLock() }          // free the cursor but stay in fullscreen
})
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) { resume(); return } // captured -> playing
  // A fullscreen toggle also drops the lock — that should NOT pause the game.
  if (performance.now() - lastFullscreenToggle < 1000) return
  pause()                                                          // genuine release (Esc / tab away) -> pause
})

// After a fullscreen change the lock is gone; if we're still playing, grab it back so
// looking continues without needing another click.
document.addEventListener('fullscreenchange', () => {
  if ((gameState === 'hiding' || gameState === 'seeking') && !paused &&
      document.pointerLockElement !== canvas) {
    canvas.requestPointerLock()
  }
})

// the Y / confirm / Y flow to finish hiding, plus the temporary Shift+Y backdoor
window.addEventListener('keydown', (e) => {
  if (paused) return // ignore while the pause menu is open
  const k = e.key.toLowerCase()
  if (gameState === 'hiding') {
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
  if (gameState === 'hiding') {
    status = confirmingHide ? 'HIDING — press Y to confirm, N to cancel'
                            : 'HIDING — press Y when you are done hiding'
  } else if (gameState === 'seeking') {
    status = `SEEKING — ${Math.ceil(seekTimeLeft)}s left`
  }
  hud.textContent =
    `${status}\nfps ${fps} · click: look · WASD: move · Space/Shift: up/down · RMB: hold to turn · scroll: zoom · Tab: pause · F: fullscreen`

  // --- DRAW ---
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

frame() // start the loop
