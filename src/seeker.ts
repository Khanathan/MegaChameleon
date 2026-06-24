// The seeker: a big red Among Us crewmate that roams + tumbles, peers at things, and runs the
// detection that fills the suspicion meter. It never calls into the round flow directly — the loop
// reads `caught` / the return of updateCaught() and decides when the round ends.
import * as THREE from 'three'
import { scene } from './engine'
import { chameleon, paintableParts } from './chameleon'
import { environment, detectTargets, seekerStart, readHitColor } from './levels'
import { isSplatRoom, readSplatColor } from './splatRoom'

// ----- The model (built from primitives; +z is its front/visor side) -----
function makeSeeker() {
  const g = new THREE.Group()
  const red = new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.6 })
  const darkRed = new THREE.MeshStandardMaterial({ color: 0x8c1414, roughness: 0.6 })
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0xbfe9f2, roughness: 0.1, metalness: 0.1, emissive: 0x16323a, emissiveIntensity: 0.5,
  })

  const bodyR = 0.6, bodyLen = 1.0 // rounded "bean" body
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

  // shift every part down so the group origin sits at the body's centre — then it tumbles about
  // its middle, not its feet.
  for (const part of g.children) part.position.y -= bodyR + bodyLen / 2
  g.scale.setScalar(3) // ~3x the player model
  return g
}
export const seeker = makeSeeker() // added to the scene only when seeking starts (see spawnSeeker)

// ----- Behavior state -----
type SeekerState = 'roaming' | 'inspecting'
let seekerState: SeekerState = 'roaming'
let seekerTimer = 1
let suspicion = 0           // 0..1; fills while the seeker sees a poorly-blended chameleon = caught
let detectTimer = 0         // accumulates so detection runs ~10x/sec, not every frame
const DETECT_DT = 1 / 10
export let caught = false   // true once the meter fills: plays the slow float-in stare cutscene
let caughtTimer = 0         // seconds left in that cutscene before the result screen
const CAUGHT_TIME = 4       // how long the stare-down lasts
const STARE_DIST = 4        // how close (world units) the seeker floats in to stare — right in its face
const seekerTarget = new THREE.Vector3()  // where it's roaming to
const seekerLookAt = new THREE.Vector3()  // the "thing" it stops to inspect
const SEEKER_SPEED = 20                     // roam move speed (world units/sec)
const SEEKER_SPIN = 150                     // wild spin (rad/sec)
const SEEKER_EYE = 1.05                     // visor height above the group origin/centre (scaled)

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

export function updateSeeker(delta: number) {
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
export function spawnSeeker() {
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

// ----- Detection: line of sight + color stand-out feed the suspicion meter -----
export const suspicionBar = document.getElementById('suspicion') as HTMLDivElement
const suspicionFill = document.getElementById('suspicion-fill') as HTMLDivElement
function updateSuspicionBar() {
  suspicionFill.style.width = `${Math.round(suspicion * 100)}%`
  suspicionFill.style.background = `hsl(${(1 - suspicion) * 130}, 70%, 55%)` // 130 green -> 0 red
}

// world-space normal of a hit face (for the lit-color estimate)
function hitNormal(hit: THREE.Intersection, out: THREE.Vector3) {
  if (hit.face) out.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize()
  else out.set(0, 1, 0)
}

// the scene's light values as plain numbers, so we can predict how a surface looks once lit.
// KEEP IN SYNC with the lights added in engine.ts.
const L_AMBIENT = 0.2
const L_SUN_DIR = new THREE.Vector3(12, 30, 18).normalize()
const L_SUN = 0.45
const L_SKY = new THREE.Color(0xfff3f6)
const L_GROUND = new THREE.Color(0x6a5054)
const L_HEMI = 0.7
const _base = new THREE.Color()
// estimate how a base color looks on a surface with the given world normal so the "stands out"
// check matches what the player sees.
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

const VIEW_COS = Math.cos((70 * Math.PI) / 180) // very wide view cone — the wild spin sweeps it fast
const MAX_SEE = 80                               // too far past this to notice
const STAND_OUT_MAX = 0.3                         // lit-color distance that counts as fully standing out
const RISE = 2.5, DECAY = 0.3                     // suspicion change per second
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
      if (isSplatRoom()) {
        // no wall to hit — sample the splat's baked color behind the body, along the view ray.
        // null means open space behind it (nothing to blend with) -> fully stands out.
        const back = readSplatColor(first.point, _toCham)
        if (back === null) {
          standOut = 1
        } else {
          _n.copy(_toCham).negate() // backdrop faces the seeker
          litColor(back, _n, _litB)
          standOut = Math.min(1, colorDist(_litA, _litB) / STAND_OUT_MAX)
        }
      } else {
        const behind = hits.find((h) => environment.includes(h.object as THREE.Mesh))
        if (behind) {
          hitNormal(behind, _n); litColor(readHitColor(behind), _n, _litB) // the wall behind it
          standOut = Math.min(1, colorDist(_litA, _litB) / STAND_OUT_MAX)
        }
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

// run detection ~10x/sec rather than every frame
export function tickDetection(delta: number) {
  detectTimer += delta
  if (detectTimer >= DETECT_DT) { updateSuspicion(detectTimer); detectTimer = 0 }
}

// the catch cutscene: stop spinning, slowly float in toward the chameleon and stare it down. Returns
// true on the frame it finishes (the loop then shows the result screen).
const _stare = new THREE.Vector3()
export function updateCaught(delta: number): boolean {
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
  return caughtTimer <= 0
}
