// Per-frame player + camera updates. updateHidePhase moves/collides the chameleon and orbits the
// camera around it; updateSeekPhase flies a free camera (the chameleon is fixed during the seek).
import * as THREE from 'three'
import { camera } from './engine'
import { chameleon, BODY_HX, BODY_HY, BODY_HZ } from './chameleon'
import { ROOM, halfW, halfD, t, obstacleBoxes } from './levels'
import { game, look, settings, keys, DEFAULT_MOVE_SPEED } from './state'

const FLOAT_SPEED = 4                 // vertical units per second (Space up / Shift down)
const FLY_SPEED = 16                  // free-fly camera speed during the seek phase
const CAM_MARGIN = 0.5                // keep the camera this far off the walls
const TORSO_HEIGHT = 1.35             // aim the camera at the torso, not the feet
const BASE_DISTANCE = 10              // camera distance at zoom = 1
const camPos = new THREE.Vector3()     // reused each frame (no garbage)
const lookTarget = new THREE.Vector3()
const bodyCenter = new THREE.Vector3()
const freeCamPos = new THREE.Vector3() // the free-fly camera's position (seek phase)
let seekCamReady = false               // becomes true once the seek camera has snapped into place

// HIDE PHASE: move/paint the chameleon, collide it against the room + obstacles, orbit the camera.
export function updateHidePhase(delta: number) {
  seekCamReady = false // so the next seek snaps the free camera to wherever we're looking from

  if (game.paintMode) {
    // painting: the body stays put; A/D only spin it in place so you can reach every side
    const TURN_SPEED = 1.6 // radians per second
    if (keys['a'] || keys['arrowleft'])  chameleon.rotation.y += TURN_SPEED * delta
    if (keys['d'] || keys['arrowright']) chameleon.rotation.y -= TURN_SPEED * delta
  } else {
    // move relative to where the camera is looking; the model's facing is NOT touched here
    const forwardX = -Math.sin(look.yaw)
    const forwardZ = -Math.cos(look.yaw)
    const rightX = Math.cos(look.yaw)
    const rightZ = -Math.sin(look.yaw)

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
      chameleon.position.x += moveX * settings.moveSpeed * delta
      chameleon.position.z += moveZ * settings.moveSpeed * delta
    }

    // float up (Space) or sink down (Shift). The move-speed setting scales float too
    // (proportionally), so it modifies all chameleon movement.
    let lift = 0
    if (keys[' ']) lift += 1
    if (keys['shift']) lift -= 1
    chameleon.position.y += lift * FLOAT_SPEED * (settings.moveSpeed / DEFAULT_MOVE_SPEED) * delta
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
  // through and can rest against a face — or stand on top of a box).
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
  const dist = BASE_DISTANCE * look.zoom
  const cosP = Math.cos(look.pitch)
  camPos.set(Math.sin(look.yaw) * cosP, Math.sin(look.pitch), Math.cos(look.yaw) * cosP)
  camPos.multiplyScalar(dist).add(lookTarget)
  camPos.x = Math.max(-(halfW - CAM_MARGIN), Math.min(halfW - CAM_MARGIN, camPos.x))
  camPos.z = Math.max(-(halfD - CAM_MARGIN), Math.min(halfD - CAM_MARGIN, camPos.z))
  camPos.y = Math.max(0.5, camPos.y) // never drop below the floor
  camera.position.copy(camPos)
  camera.lookAt(lookTarget)
}

// SEEK PHASE: the chameleon is fixed; fly the camera around freely (WASD + Space/Shift + look).
export function updateSeekPhase(delta: number) {
  if (!seekCamReady) { freeCamPos.copy(camera.position); seekCamReady = true } // start where we were

  const cosP = Math.cos(look.pitch)
  // forward = where you're looking (includes up/down); right = horizontal
  const fwdX = -Math.sin(look.yaw) * cosP, fwdY = Math.sin(look.pitch), fwdZ = -Math.cos(look.yaw) * cosP
  const rightX = Math.cos(look.yaw), rightZ = -Math.sin(look.yaw)

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
}
