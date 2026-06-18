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

// ----- A room is data: a LevelDefinition that a LevelProvider hands back. The game never builds
// the room directly — loadLevel() (below) turns a definition into meshes. -----
type Surface = { color: string } | { image: string } // a flat color or an image url
interface Obstacle { size: [number, number, number]; pos: [number, number, number]; surface: Surface }
interface LevelDefinition {
  name: string
  size: { width: number; depth: number; height: number }
  surfaces: { floor: Surface; ceiling: Surface; back: Surface; front: Surface; left: Surface; right: Surface }
  palette: string[]            // paint-toolbar swatches
  obstacles: Obstacle[]
  seekerStart: [number, number, number]
}
interface LevelProvider { getLevel(id: string): Promise<LevelDefinition> }

// current room size — updated by loadLevel; the collision + camera clamps read these every frame
const ROOM = { width: 50, depth: 50, height: 30 }
let halfW = ROOM.width / 2
let halfD = ROOM.depth / 2
const t = 0.2 // wall thickness
const environment: THREE.Mesh[] = [] // current room's surfaces (walls/floor/ceiling/obstacles)
const levelMeshes: THREE.Mesh[] = [] // everything loadLevel made, kept so we can dispose on a swap
// obstacle boxes (center + half-extents) the chameleon collides against, so it can't pass through
const obstacleBoxes: { x: number; y: number; z: number; hx: number; hy: number; hz: number }[] = []
let seekerStart: [number, number, number] = [10, 6, -8] // where the seeker spawns (set per level)

// Build an image-backed material. A FIXED 512x512 canvas (a power-of-two size, and never resized
// after the texture is made — resizing it later can leave the GPU texture stuck blank/black). It
// starts grey, then the image is drawn in once it loads. The canvas backs the texture so the
// eyedropper + seeker can read its pixels. The image stretches to fill the surface.
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

// build one box (wall/floor/ceiling/obstacle), flat-color or image, and register it as part of
// the room: into the scene, into `environment` (so the eyedropper + seeker see it), and into
// `levelMeshes` (so a map swap can dispose it).
function buildBox(w: number, h: number, d: number, x: number, y: number, z: number, s: Surface) {
  let material: THREE.Material
  let userData: Record<string, unknown> = {}
  if ('image' in s) {
    const img = makeImageWall(s.image)
    material = img.material
    userData = img.userData
  } else {
    material = new THREE.MeshStandardMaterial({ color: s.color })
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  mesh.position.set(x, y, z)
  mesh.userData = userData
  scene.add(mesh)
  environment.push(mesh)
  levelMeshes.push(mesh)
}

// ----- The chameleon: a simple blocky humanoid -----
// We treat +z as "forward" (the face side). The group's origin is at the feet (y = 0).
const chameleon = new THREE.Group()
const SKIN = '#6abf69'          // the chameleon's starting green
const PAINT_CANVAS = 256        // per-part drawing canvas size in pixels (blocky model: plenty)
const PAINT_COLS = 3, PAINT_ROWS = 2 // the canvas is split into this grid: one cell per box face
const paintableParts: THREE.Mesh[] = [] // every mesh you can paint on (filled by addPart)

// Rewrite a box's texture coordinates so each of its 6 faces gets its own patch of the canvas,
// instead of all six faces sharing the whole square (which would make paint bleed across faces).
function unwrapBoxFaces(geometry: THREE.BoxGeometry) {
  const uv = geometry.attributes.uv
  const cols = PAINT_COLS, rows = PAINT_ROWS // 6 cells, one per face
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

chameleon.position.set(0, 0, 0)
scene.add(chameleon)

// ----- The seeker: a big red Among Us crewmate (M4 preview: model + idle behavior only) -----
// Built from primitives. +z is its front (the visor side). Origin is at its feet (y = 0).
function makeSeeker() {
  const g = new THREE.Group()
  const red = new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.6 })
  const darkRed = new THREE.MeshStandardMaterial({ color: 0x8c1414, roughness: 0.6 })
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0xbfe9f2, roughness: 0.1, metalness: 0.1, emissive: 0x16323a, emissiveIntensity: 0.5,
  })

  const bodyR = 0.6, bodyLen = 1.0 // rounded "bean" body: ~2.2 tall, bottom sits on the floor
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(bodyR, bodyLen, 6, 16), red)
  body.position.y = bodyR + bodyLen / 2
  g.add(body)

  const pack = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 12), darkRed) // backpack (-z)
  pack.position.set(0, 1.05, -bodyR - 0.12)
  g.add(pack)

  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), visorMat) // visor (+z)
  visor.scale.set(1.25, 0.8, 0.6)
  visor.position.set(0, 1.45, bodyR - 0.02)
  g.add(visor)

  const glare = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 10), // classic visor highlight
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 }))
  glare.position.set(0.18, 1.55, bodyR + 0.16)
  g.add(glare)

  for (const sx of [-0.28, 0.28]) { // two stubby legs
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.18, 4, 10), red)
    leg.position.set(sx, 0.26, 0.08)
    g.add(leg)
  }

  // shift every part down so the group's origin sits at the body's centre (the capsule middle, at
  // local y = bodyR + bodyLen/2). Then the seeker tumbles about its middle, not its feet.
  for (const part of g.children) part.position.y -= bodyR + bodyLen / 2
  g.scale.setScalar(3) // ~3x the player model
  return g
}
const seeker = makeSeeker() // added to the scene only when seeking starts (see spawnSeeker)

// Seeker behavior: roam the room while spinning wildly, then occasionally stop and lean in to
// "peer at" a random spot, then roam again. No collision — it passes through everything; roam
// targets stay inside the room so it stays in view.
type SeekerState = 'roaming' | 'inspecting'
let seekerState: SeekerState = 'roaming'
let seekerTimer = 1
let suspicion = 0           // 0..1; fills while the seeker sees a poorly-blended chameleon = caught
let detectTimer = 0         // accumulates time so detection runs ~10x/sec, not every frame
const DETECT_DT = 1 / 10
let caught = false          // true once the meter fills: plays the slow float-in stare cutscene
let caughtTimer = 0         // seconds left in that cutscene before the result screen
const CAUGHT_TIME = 4       // how long the stare-down lasts
const STARE_DIST = 4        // how close (world units) the seeker floats in to stare — right in its face
const seekerTarget = new THREE.Vector3()  // where it's roaming to
const seekerLookAt = new THREE.Vector3()  // the "thing" it stops to inspect
const SEEKER_SPEED = 20                     // roam move speed (world units/sec)
const SEEKER_SPIN = 150                      // wild spin (rad/sec) — ~11 turns/sec
const SEEKER_EYE = 1.05                     // visor height above the group origin/centre (scaled)

// roam targets float anywhere in the room volume; y stays in bounds so it can't leave the room
function pickRoamTarget() {
  seekerTarget.set((Math.random() * 2 - 1) * 18, 2 + Math.random() * 18, (Math.random() * 2 - 1) * 18)
}
function pickInspectTarget() { // pick a spot to stop and peer at
  if (Math.random() < 0.5) {
    // sometimes lock a direct stare onto the chameleon's real spot — a menacing "it's onto me"
    seekerLookAt.set(chameleon.position.x, chameleon.position.y + 1.35, chameleon.position.z)
  } else {
    // otherwise a random spot anywhere in the room volume
    seekerLookAt.set((Math.random() * 2 - 1) * 22, 1 + Math.random() * 22, (Math.random() * 2 - 1) * 22)
  }
}
pickRoamTarget()

// turn an angle toward a target by the shortest way
function approachAngle(current: number, target: number, t: number) {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  return current + diff * Math.min(1, t)
}

function updateSeeker(delta: number) {
  seekerTimer -= delta
  if (seekerState === 'roaming') {
    // tumble wildly in 3D — different rates per axis so it spins chaotically, not around one line
    seeker.rotation.x += SEEKER_SPIN * 0.7 * delta
    seeker.rotation.y += SEEKER_SPIN * delta
    seeker.rotation.z += SEEKER_SPIN * 0.45 * delta
    // drift toward the roam target in 3D (floats up and sinks down too)
    const dx = seekerTarget.x - seeker.position.x
    const dy = seekerTarget.y - seeker.position.y
    const dz = seekerTarget.z - seeker.position.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > 0.001) {
      const step = Math.min(dist, SEEKER_SPEED * delta)
      seeker.position.x += (dx / dist) * step
      seeker.position.y += (dy / dist) * step
      seeker.position.z += (dz / dist) * step
    }
    if (dist < 1.5 || seekerTimer <= 0) {                              // arrived or bored -> inspect
      seekerState = 'inspecting'
      seekerTimer = 0.5 + Math.random() * 1.0                          // peer for 0.5-1.5s
      pickInspectTarget()
    }
  } else {
    const dx = seekerLookAt.x - seeker.position.x
    const dz = seekerLookAt.z - seeker.position.z
    // stop tumbling and settle to face the target: shortest-angle ease handles the big spin we
    // accumulated, and z un-rolls so it peers upright
    seeker.rotation.y = approachAngle(seeker.rotation.y, Math.atan2(dx, dz), delta * 10) // face it
    let pitch = -Math.atan2(seekerLookAt.y - (seeker.position.y + SEEKER_EYE), Math.hypot(dx, dz)) // lean to peer
    pitch = Math.max(-0.5, Math.min(0.5, pitch))
    seeker.rotation.x = approachAngle(seeker.rotation.x, pitch, delta * 8)
    seeker.rotation.z = approachAngle(seeker.rotation.z, 0, delta * 8)
    if (seekerTimer <= 0) {                                            // done peering -> roam again
      seekerState = 'roaming'
      seekerTimer = 1 + Math.random() * 1.5
      pickRoamTarget()
    }
  }
}

// add the seeker to the scene and reset it; called when the seek phase begins
function spawnSeeker() {
  seeker.position.set(seekerStart[0], seekerStart[1], seekerStart[2])
  seeker.rotation.set(0, 0, 0)
  seekerState = 'roaming'
  seekerTimer = 1
  suspicion = 0
  detectTimer = 0
  caught = false
  caughtTimer = 0
  updateSuspicionBar()
  pickRoamTarget()
  scene.add(seeker)
}

// ----- Detection: does the seeker notice the chameleon? (line of sight + color stand-out) -----
const suspicionBar = document.getElementById('suspicion') as HTMLDivElement
const suspicionFill = document.getElementById('suspicion-fill') as HTMLDivElement
function updateSuspicionBar() {
  suspicionFill.style.width = `${Math.round(suspicion * 100)}%`
  suspicionFill.style.background = `hsl(${(1 - suspicion) * 130}, 70%, 55%)` // 130 green -> 0 red
}

// read the known color of whatever a ray hit: a painted/image canvas pixel, or a flat surface's
// material color. Same source the eyedropper uses — never a GPU pixel read-back.
function readHitColor(hit: THREE.Intersection): string {
  const obj = hit.object as THREE.Mesh
  const ctx = (obj.userData as { ctx?: CanvasRenderingContext2D }).ctx
  if (ctx && hit.uv) {
    const p = ctx.getImageData(hit.uv.x * ctx.canvas.width, (1 - hit.uv.y) * ctx.canvas.height, 1, 1).data
    return '#' + [p[0], p[1], p[2]].map((n) => n.toString(16).padStart(2, '0')).join('')
  }
  return '#' + (obj.material as THREE.MeshStandardMaterial).color.getHexString()
}

// world-space normal of a hit face (for the lit-color estimate)
function hitNormal(hit: THREE.Intersection, out: THREE.Vector3) {
  if (hit.face) out.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize()
  else out.set(0, 1, 0)
}

// the scene's light values as plain numbers, so we can predict how a surface looks once lit.
// KEEP IN SYNC with the lights added to the scene above.
const L_AMBIENT = 0.2
const L_SUN_DIR = new THREE.Vector3(12, 30, 18).normalize()
const L_SUN = 0.45
const L_SKY = new THREE.Color(0xfff3f6)
const L_GROUND = new THREE.Color(0x6a5054)
const L_HEMI = 0.7
const _base = new THREE.Color()
// estimate how a base color looks on a surface with the given world normal (hemisphere + ambient
// + one directional light) so the "stands out" check matches what the player sees.
function litColor(hex: string, normal: THREE.Vector3, out: THREE.Color) {
  _base.set(hex) // three converts the hex from sRGB to linear
  const ndl = Math.max(0, normal.dot(L_SUN_DIR))
  const t = normal.y * 0.5 + 0.5 // 1 = faces up (sky), 0 = faces down (ground)
  out.r = _base.r * (L_AMBIENT + L_SUN * ndl + L_HEMI * (L_GROUND.r + (L_SKY.r - L_GROUND.r) * t))
  out.g = _base.g * (L_AMBIENT + L_SUN * ndl + L_HEMI * (L_GROUND.g + (L_SKY.g - L_GROUND.g) * t))
  out.b = _base.b * (L_AMBIENT + L_SUN * ndl + L_HEMI * (L_GROUND.b + (L_SKY.b - L_GROUND.b) * t))
  return out
}
function colorDist(a: THREE.Color, b: THREE.Color) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

let detectTargets: THREE.Mesh[] = [] // everything the seeker's ray can hit (rebuilt per level)
const VIEW_COS = Math.cos((70 * Math.PI) / 180) // very wide view cone — the wild spin sweeps it
                                                 // fast, so it's effectively "scanning" almost everywhere
const MAX_SEE = 80                               // too far past this to notice
const STAND_OUT_MAX = 0.3                       // lit-color distance that counts as fully standing out
const RISE = 2.5, DECAY = 0.3                    // suspicion change per second
const _eye = new THREE.Vector3(), _fwd = new THREE.Vector3()
const _cham = new THREE.Vector3(), _toCham = new THREE.Vector3()
const _seekRay = new THREE.Raycaster()
const _litA = new THREE.Color(), _litB = new THREE.Color()
const _n = new THREE.Vector3()

function updateSuspicion(dt: number) {
  seeker.updateMatrixWorld()
  _eye.set(0, 0.35, 0.55).applyMatrix4(seeker.matrixWorld)         // visor (eye) world position (local)
  _fwd.set(0, 0, 1).applyQuaternion(seeker.quaternion).normalize() // where it's looking
  _cham.copy(chameleon.position); _cham.y += 1.35                  // aim at the torso
  _toCham.copy(_cham).sub(_eye)
  const dist = _toCham.length()
  _toCham.divideScalar(dist)                                       // normalize

  let standOut = 0
  if (_fwd.dot(_toCham) > VIEW_COS && dist < MAX_SEE) {            // in the view cone & near enough
    _seekRay.set(_eye, _toCham)
    const hits = _seekRay.intersectObjects(detectTargets, false)
    const first = hits[0]
    if (first && paintableParts.includes(first.object as THREE.Mesh)) { // clear line of sight to body
      hitNormal(first, _n); litColor(readHitColor(first), _n, _litA)    // the body's lit color
      const behind = hits.find((h) => environment.includes(h.object as THREE.Mesh))
      if (behind) {
        hitNormal(behind, _n); litColor(readHitColor(behind), _n, _litB) // the wall behind it
        standOut = Math.min(1, colorDist(_litA, _litB) / STAND_OUT_MAX)
      }
    }
  }

  if (standOut > 0) {
    const proximity = 1 - dist / MAX_SEE
    suspicion += RISE * standOut * (0.4 + 0.6 * proximity) * dt
  } else {
    suspicion -= DECAY * dt
  }
  suspicion = Math.max(0, Math.min(1, suspicion))
  updateSuspicionBar()
  if (suspicion >= 1 && !caught) { caught = true; caughtTimer = CAUGHT_TIME } // begin the stare-down
}

// the catch cutscene: stop spinning, slowly float in toward the chameleon and stare it down for a
// few seconds, then show the result screen.
const _stare = new THREE.Vector3()
function updateCaught(delta: number) {
  caughtTimer -= delta
  _cham.copy(chameleon.position); _cham.y += 1.35 // the torso it's staring at
  // ease in to a fixed staring distance (slows as it arrives, so it floats to a stop)
  _stare.copy(seeker.position).sub(_cham)
  _stare.divideScalar(_stare.length() || 1).multiplyScalar(STARE_DIST).add(_cham)
  seeker.position.lerp(_stare, Math.min(1, delta * 0.7))
  // turn to face it (no more spinning) and tilt to look right at the torso
  const dx = _cham.x - seeker.position.x, dz = _cham.z - seeker.position.z
  seeker.rotation.y = approachAngle(seeker.rotation.y, Math.atan2(dx, dz), delta * 6)
  let pitch = -Math.atan2(_cham.y - (seeker.position.y + SEEKER_EYE), Math.hypot(dx, dz))
  pitch = Math.max(-0.8, Math.min(0.8, pitch))
  seeker.rotation.x = approachAngle(seeker.rotation.x, pitch, delta * 6) // un-tumble to a dead stare
  seeker.rotation.z = approachAngle(seeker.rotation.z, 0, delta * 6)
  if (caughtTimer <= 0) finishSeek('lose')
}

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
const DEFAULT_MOVE_SPEED = 8    // chameleon walk speed (units/sec); changeable in Settings
let moveSpeed = DEFAULT_MOVE_SPEED
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
  if (rotatingModel && gameState === 'hiding') {
    chameleon.rotation.y -= e.movementX * s // turn the model left/right (hide phase only)
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
const howtoEl = document.getElementById('howto') as HTMLDivElement // top-right how-to-play card
const resultTitle = document.getElementById('result-title') as HTMLHeadingElement
const sensInput = document.getElementById('sens-input') as HTMLInputElement
const speedInput = document.getElementById('speed-input') as HTMLInputElement
const speedNote = document.getElementById('speed-note') as HTMLParagraphElement
speedNote.textContent = `Default: ${DEFAULT_MOVE_SPEED}` // small note of the default speed
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
  if (next !== 'seeking') scene.remove(seeker) // the seeker only exists during the seek phase
  suspicionBar.classList.toggle('hidden', next !== 'seeking') // meter only shows during the seek
  howtoEl.classList.toggle('hidden', next !== 'hiding')       // how-to card only during hiding
  // 'hiding' and 'seeking' show no overlay — you're in the game
}

function startRound() {
  chameleon.position.set(0, 0, 0)
  chameleon.rotation.set(0, 0, 0)
  setState('hiding')
}

const SEEK_TIME = 20
const SEEK_GRACE = 3 // head start: the seeker animates but can't actually detect for this long
function startSeek() {
  seekTimeLeft = SEEK_TIME
  spawnSeeker()
  freeCamPos.copy(camera.position) // start the free-fly camera where we were watching from
  setState('seeking')
  canvas.requestPointerLock() // capture the mouse so you can look around right away
}
function finishSeek(result: 'win' | 'lose') {
  outcome = result
  resultTitle.textContent = outcome === 'win' ? 'You survived!' : 'SUS'
  setState('result')
}

function openSettings(returnTo: 'menu' | 'pause') {
  settingsReturn = returnTo
  sensInput.value = String(sensitivity)
  speedInput.value = String(moveSpeed)
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

// the Y / confirm / Y flow to finish hiding
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
  const sp = parseFloat(speedInput.value)
  if (!Number.isNaN(sp)) moveSpeed = Math.max(1, Math.min(20, sp))
  speedInput.value = String(moveSpeed) // reflect the clamped value
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

// (re)build the swatch buttons from a level's palette; called by loadLevel
function buildSwatches(palette: string[]) {
  swatchesEl.innerHTML = ''
  for (const hex of palette) {
    const s = document.createElement('span')
    s.className = 'swatch'
    s.style.background = hex
    s.addEventListener('click', () => setColor(hex))
    swatchesEl.appendChild(s)
  }
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
let lastUV: { part: THREE.Mesh; cell: number; x: number; y: number } | null = null // for smooth lines

// find what the cursor is over; returns the part + pixel spot on its canvas, or null
function pickOnModel(e: MouseEvent) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(paintableParts, false)[0]
  if (!hit || !hit.uv) return null
  const part = hit.object as THREE.Mesh
  // which grid cell (face) the hit is in, so paint stays on this one face
  const col = Math.min(PAINT_COLS - 1, Math.floor(hit.uv.x * PAINT_COLS))
  const row = Math.min(PAINT_ROWS - 1, Math.floor(hit.uv.y * PAINT_ROWS))
  const cell = row * PAINT_COLS + col
  // texture v counts up, canvas y counts down — flip it
  return { part, cell, x: hit.uv.x * PAINT_CANVAS, y: (1 - hit.uv.y) * PAINT_CANVAS }
}

// draw one round dot of the current color on a part's canvas, kept inside the hit face's cell
function stamp(part: THREE.Mesh, cell: number, x: number, y: number, radius: number) {
  const { ctx, texture } = part.userData as { ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
  const cellW = PAINT_CANVAS / PAINT_COLS, cellH = PAINT_CANVAS / PAINT_ROWS
  const col = cell % PAINT_COLS, row = Math.floor(cell / PAINT_COLS)
  ctx.save()
  ctx.beginPath()
  // texture rows count up, canvas rows count down — flip to get the cell's top edge
  ctx.rect(col * cellW, PAINT_CANVAS - (row + 1) * cellH, cellW, cellH)
  ctx.clip() // confine the dot to this one face so it can't bleed onto a neighbour
  ctx.fillStyle = currentColor
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  texture.needsUpdate = true // tell Three.js the texture changed
}

// a drag = many dots; connect the last spot to this one so fast moves don't leave gaps
function paintAt(e: MouseEvent) {
  const spot = pickOnModel(e)
  if (!spot) { lastUV = null; return }
  const radius = currentTool === 'brush' ? BRUSH_RADIUS : PENCIL_RADIUS
  // only join to the last dot if it was on the same face; otherwise the line would streak
  // across the flattened canvas between two faces
  if (lastUV && lastUV.part === spot.part && lastUV.cell === spot.cell) {
    const steps = Math.ceil(Math.hypot(spot.x - lastUV.x, spot.y - lastUV.y) / (radius / 2))
    for (let i = 1; i <= steps; i++) {
      stamp(spot.part, spot.cell, lastUV.x + (spot.x - lastUV.x) * i / steps,
                       lastUV.y + (spot.y - lastUV.y) * i / steps, radius)
    }
  } else {
    stamp(spot.part, spot.cell, spot.x, spot.y, radius)
  }
  lastUV = { part: spot.part, cell: spot.cell, x: spot.x, y: spot.y }
}

// fill = repaint every part's whole canvas the current color
function fillAll() {
  for (const part of paintableParts) {
    const { ctx, texture } = part.userData as { ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture }
    ctx.fillStyle = currentColor
    ctx.fillRect(0, 0, PAINT_CANVAS, PAINT_CANVAS)
    texture.needsUpdate = true
  }
}

// pick = sample the color under the cursor, from the model OR a room surface
let pickTargets: THREE.Mesh[] = [] // everything the eyedropper can hit (rebuilt per level)
function pickColor(e: MouseEvent) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(pickTargets, false)[0]
  if (!hit) return
  setColor(readHitColor(hit)) // a canvas pixel (model/image wall) or a flat surface's color
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
const FLOAT_SPEED = 4                 // vertical units per second (Space up / Shift down)
const FLY_SPEED = 16                  // free-fly camera speed during the seek phase
const freeCamPos = new THREE.Vector3() // the free-fly camera's position (seek phase)
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

  // count the seek timer down; surviving to 0 = win. Frozen once caught — the catch cutscene
  // ends the round with a loss instead.
  if (gameState === 'seeking' && !caught) {
    seekTimeLeft -= delta
    if (seekTimeLeft <= 0) finishSeek('win')
  }

  if (gameState === 'seeking') {
    // --- SEEK PHASE: the chameleon is fixed; fly the camera around freely to watch the seeker ---
    if (caught) {
      updateCaught(delta) // locked on: float in, stare for CAUGHT_TIME seconds, then the result screen
    } else {
      updateSeeker(delta) // seeker roams + peers around (it "pretends to seek" during the grace)
      // 5s head start: the seeker only *pretends* to seek; real detection starts after the grace.
      // After that, run detection ~10x/sec (not every frame); fills/drains the meter, may catch you.
      if (SEEK_TIME - seekTimeLeft >= SEEK_GRACE) {
        detectTimer += delta
        if (detectTimer >= DETECT_DT) { updateSuspicion(detectTimer); detectTimer = 0 }
      }
    }

    const cosP = Math.cos(camPitch)
    // forward = where you're looking (includes up/down); right = horizontal
    const fwdX = -Math.sin(camYaw) * cosP, fwdY = Math.sin(camPitch), fwdZ = -Math.cos(camYaw) * cosP
    const rightX = Math.cos(camYaw), rightZ = -Math.sin(camYaw)

    let drive = 0, strafe = 0, lift = 0
    if (keys['w'] || keys['arrowup']) drive += 1
    if (keys['s'] || keys['arrowdown']) drive -= 1
    if (keys['d'] || keys['arrowright']) strafe += 1
    if (keys['a'] || keys['arrowleft']) strafe -= 1
    if (keys[' ']) lift += 1
    if (keys['shift']) lift -= 1

    freeCamPos.x += (fwdX * drive + rightX * strafe) * FLY_SPEED * delta
    freeCamPos.y += (fwdY * drive + lift) * FLY_SPEED * delta
    freeCamPos.z += (fwdZ * drive + rightZ * strafe) * FLY_SPEED * delta
    // keep the camera inside the room
    freeCamPos.x = Math.max(-(halfW - CAM_MARGIN), Math.min(halfW - CAM_MARGIN, freeCamPos.x))
    freeCamPos.z = Math.max(-(halfD - CAM_MARGIN), Math.min(halfD - CAM_MARGIN, freeCamPos.z))
    freeCamPos.y = Math.max(0.5, Math.min(ROOM.height - 0.5, freeCamPos.y))
    camera.position.copy(freeCamPos)
    camera.lookAt(freeCamPos.x + fwdX, freeCamPos.y + fwdY, freeCamPos.z + fwdZ)
  } else {
    // --- HIDE PHASE: move/paint the chameleon, collide it, orbit the camera around it ---
    if (paintMode) {
      // painting: the body stays put; A/D only spin it in place so you can reach every side
      const TURN_SPEED = 1.6 // radians per second
      if (keys['a'] || keys['arrowleft'])  chameleon.rotation.y += TURN_SPEED * delta
      if (keys['d'] || keys['arrowright']) chameleon.rotation.y -= TURN_SPEED * delta
    } else {
      // move relative to where the camera is looking; the model's facing is NOT touched here
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
        chameleon.position.x += moveX * moveSpeed * delta
        chameleon.position.z += moveZ * moveSpeed * delta
      }

      // float up (Space) or sink down (Shift); it hovers when neither is held. The move-speed
      // setting scales float too (proportionally), so it modifies all chameleon movement.
      let lift = 0
      if (keys[' ']) lift += 1
      if (keys['shift']) lift -= 1
      chameleon.position.y += lift * FLOAT_SPEED * (moveSpeed / DEFAULT_MOVE_SPEED) * delta
    }

    // collision: keep the model's box inside the room on all three axes. We read the model's
    // rotation to find how far its box reaches along each world axis (its "shadow" on that axis).
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

    // push the body out of any obstacle it overlaps, along the shallowest axis (so it can't pass
    // through and can rest against a face — or stand on top of a box). Treat the body as the same
    // axis-aligned box (centre = position + bodyCenter, half-extents ex/ey/ez) used for the walls.
    for (const o of obstacleBoxes) {
      const dx = chameleon.position.x + bodyCenter.x - o.x
      const dy = chameleon.position.y + bodyCenter.y - o.y
      const dz = chameleon.position.z + bodyCenter.z - o.z
      const px = ex + o.hx - Math.abs(dx)
      const py = ey + o.hy - Math.abs(dy)
      const pz = ez + o.hz - Math.abs(dz)
      if (px > 0 && py > 0 && pz > 0) {            // overlapping on all three axes
        if (px <= py && px <= pz) chameleon.position.x += dx < 0 ? -px : px
        else if (py <= pz) chameleon.position.y += dy < 0 ? -py : py
        else chameleon.position.z += dz < 0 ? -pz : pz
      }
    }

    // orbit the camera around the chameleon, staying inside the room
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
  }

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
    controls = 'WASD: fly · Space/Shift: up/down · mouse: look · scroll: — · Tab: pause · F: fullscreen'
  }
  hud.textContent = `${status}\nfps ${fps} · ${controls}`

  // --- DRAW ---
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

// ----- Levels: turn a LevelDefinition into meshes, with 2-3 built-in rooms you can pick -----

// free the current room's meshes before loading another, or Three.js leaks them every swap.
// (The chameleon and seeker are NOT part of the level, so they're left alone.)
function disposeLevel() {
  for (const m of levelMeshes) {
    scene.remove(m)
    m.geometry.dispose()
    const mat = m.material as THREE.MeshStandardMaterial
    mat.map?.dispose()
    mat.dispose()
  }
  levelMeshes.length = 0
  environment.length = 0
  obstacleBoxes.length = 0
}

// build a whole room from a definition: size, six surfaces, obstacles, palette, seeker start
function loadLevel(def: LevelDefinition) {
  disposeLevel()
  ROOM.width = def.size.width
  ROOM.depth = def.size.depth
  ROOM.height = def.size.height
  halfW = ROOM.width / 2
  halfD = ROOM.depth / 2
  const { width: W, depth: D, height: H } = def.size
  buildBox(W, 0.2, D, 0, -0.1, 0, def.surfaces.floor)         // floor
  buildBox(W, 0.2, D, 0, H + 0.1, 0, def.surfaces.ceiling)    // ceiling
  buildBox(W, H, t, 0, H / 2, -halfD, def.surfaces.back)      // back wall (-z)
  buildBox(W, H, t, 0, H / 2, halfD, def.surfaces.front)      // front wall (+z)
  buildBox(t, H, D, -halfW, H / 2, 0, def.surfaces.left)      // left wall (-x)
  buildBox(t, H, D, halfW, H / 2, 0, def.surfaces.right)      // right wall (+x)
  for (const o of def.obstacles) {
    buildBox(o.size[0], o.size[1], o.size[2], o.pos[0], o.pos[1], o.pos[2], o.surface)
    obstacleBoxes.push({
      x: o.pos[0], y: o.pos[1], z: o.pos[2],
      hx: o.size[0] / 2, hy: o.size[1] / 2, hz: o.size[2] / 2,
    })
  }
  seekerStart = def.seekerStart
  buildSwatches(def.palette)
  // the eyedropper + seeker raycast against these; refresh them now that the room changed
  pickTargets = [...environment, ...paintableParts]
  detectTargets = [...paintableParts, ...environment]
}

// the hand-made rooms
const MAPS: Record<string, LevelDefinition> = {
  pink: {
    name: 'Amogus Room',
    size: { width: 50, depth: 50, height: 30 },
    surfaces: {
      floor: { color: '#E8B0BE' }, ceiling: { color: '#FFE9EF' },
      back: { image: amogusUrl }, front: { color: '#FFD9E1' },
      left: { color: '#FFD9E1' }, right: { color: '#FFD9E1' },
    },
    palette: ['#FFD9E1', '#E8B0BE', '#FFE9EF', '#6abf69', '#ffffff', '#222222'],
    obstacles: [],
    seekerStart: [10, 6, -8],
  },
  crates: {
    name: 'Crates',
    size: { width: 50, depth: 50, height: 30 },
    surfaces: {
      floor: { color: '#6b6b76' }, ceiling: { color: '#4a4a55' },
      back: { color: '#7a8a99' }, front: { color: '#7a8a99' },
      left: { color: '#7a8a99' }, right: { color: '#7a8a99' },
    },
    palette: ['#7a8a99', '#6b6b76', '#8a6d4b', '#c2a36b', '#ffffff', '#222222'],
    obstacles: [
      { size: [8, 8, 8], pos: [-10, 4, -6], surface: { color: '#8a6d4b' } },
      { size: [6, 12, 6], pos: [12, 6, 8], surface: { color: '#8a6d4b' } },
      { size: [10, 5, 5], pos: [4, 2.5, -14], surface: { color: '#c2a36b' } },
    ],
    seekerStart: [0, 8, 14],
  },
  studio: {
    name: 'Studio',
    size: { width: 40, depth: 40, height: 24 },
    surfaces: {
      floor: { color: '#d9d2c5' }, ceiling: { color: '#f2efe9' },
      back: { color: '#3a7ca5' }, front: { color: '#e4dccd' },
      left: { color: '#e4dccd' }, right: { color: '#e4dccd' },
    },
    palette: ['#3a7ca5', '#e4dccd', '#d9d2c5', '#2f6b8f', '#ffffff', '#111111'],
    obstacles: [
      { size: [5, 14, 5], pos: [-8, 7, -8], surface: { color: '#e4dccd' } },
      { size: [12, 4, 4], pos: [6, 2, 6], surface: { color: '#3a7ca5' } },
    ],
    seekerStart: [8, 6, 8],
  },
}
const BuiltInMaps: LevelProvider = {
  getLevel(id: string) { return Promise.resolve(MAPS[id]) }, // instant, but async to match M6
}

// ----- M6: ImagePaletteProvider — build a level from an uploaded image, all in-browser. It
// returns the same LevelDefinition the built-ins do, so loadLevel + everything downstream is
// untouched; only the input differs (a File instead of an id). -----

// draw the upload onto a small canvas (long side <= max). That one canvas is read for colors AND
// becomes the wall texture. An opaque backdrop keeps transparent PNGs from going black.
async function shrinkToCanvas(file: File, max = 512): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file)
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('could not load image'))
    i.src = url
  })
  URL.revokeObjectURL(url)
  const s = Math.min(1, max / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.width * s))
  c.height = Math.max(1, Math.round(img.height * s))
  const cx = c.getContext('2d')!
  cx.fillStyle = '#888888'
  cx.fillRect(0, 0, c.width, c.height)
  cx.drawImage(img, 0, 0, c.width, c.height)
  return c
}

// pull the main colors out: bucket each pixel's RGB to ~4 bits/channel, take the most common bins
function readPalette(c: HTMLCanvasElement, count = 6): string[] {
  const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
  const bins = new Map<number, number>()
  for (let i = 0; i < data.length; i += 16) { // stride for speed
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    bins.set(key, (bins.get(key) ?? 0) + 1)
  }
  return [...bins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([k]) => {
      const r = ((k >> 8) & 15) * 17, g = ((k >> 4) & 15) * 17, b = (k & 15) * 17
      return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
    })
}

// tiny seeded RNG (mulberry32) so the same image always lays out the same obstacles
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// File -> LevelDefinition: image on the walls, floor/ceiling + obstacles from its palette
async function imageToLevel(file: File): Promise<LevelDefinition> {
  const c = await shrinkToCanvas(file)
  const palette = readPalette(c)
  const wall: Surface = { image: c.toDataURL('image/png') } // the shrunk image, self-contained
  const seed = palette.join('').split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)
  const rng = mulberry32(seed)
  const obstacles: Obstacle[] = Array.from({ length: 3 + Math.floor(rng() * 3) }, (): Obstacle => {
    const w = 4 + rng() * 8, h = 4 + rng() * 12, d = 4 + rng() * 8
    return {
      size: [w, h, d],
      pos: [(rng() * 2 - 1) * 16, h / 2, (rng() * 2 - 1) * 16],
      surface: { color: palette[Math.floor(rng() * palette.length)] ?? '#888888' },
    }
  })
  return {
    name: 'Uploaded',
    size: { width: 50, depth: 50, height: 30 },
    surfaces: {
      floor: { color: palette[0] ?? '#888888' },
      ceiling: { color: palette[1] ?? palette[0] ?? '#cccccc' },
      back: wall, front: wall, left: wall, right: wall,
    },
    palette: [...palette, '#ffffff', '#000000'],
    obstacles,
    seekerStart: [10, 6, -8],
  }
}

// map-select buttons on the main menu; picking one loads it (also as the menu backdrop)
const mapListEl = document.getElementById('map-list') as HTMLDivElement
let currentMapId = 'pink'
function setActiveMap(key: string) { // highlight the active button (a built-in id or 'upload')
  for (const b of mapListEl.querySelectorAll<HTMLButtonElement>('.map-btn')) {
    b.classList.toggle('selected', b.dataset.map === key)
  }
}
function selectMap(id: string) {
  currentMapId = id
  setActiveMap(id)
  BuiltInMaps.getLevel(id).then(loadLevel)
}
for (const id of Object.keys(MAPS)) {
  const b = document.createElement('button')
  b.className = 'map-btn'
  b.dataset.map = id
  b.textContent = MAPS[id].name
  b.addEventListener('click', () => selectMap(id))
  mapListEl.appendChild(b)
}

// upload-an-image option (M6): a button that opens a hidden file picker; the chosen image becomes
// a room via imageToLevel, then loadLevel — the same path the built-ins use
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
  currentMapId = 'upload'
  setActiveMap('upload')
  loadLevel(await imageToLevel(file))
})

selectMap(currentMapId) // load the starting room (and show it behind the menu)

frame() // start the loop
