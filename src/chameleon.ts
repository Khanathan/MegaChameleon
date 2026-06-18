// The player's chameleon: a blocky humanoid built from grouped boxes, each box carrying its own
// canvas-backed texture so it can be painted on. +z is "forward"; the group origin is at the feet.
import * as THREE from 'three'
import { scene } from './engine'

export const chameleon = new THREE.Group()
export const SKIN = '#6abf69'          // the chameleon's starting green
export const PAINT_CANVAS = 256        // per-part drawing canvas size in pixels (blocky model: plenty)
export const PAINT_COLS = 3, PAINT_ROWS = 2 // the canvas is split into this grid: one cell per box face
export const paintableParts: THREE.Mesh[] = [] // every mesh you can paint on (filled by addPart)
// model half-extents, used by the collision "box shadow"
export const BODY_HX = 0.72, BODY_HY = 1.15, BODY_HZ = 0.33

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

// add one box part with its own canvas + texture; the canvas/context live on userData so the paint
// tools and the seeker's color check can read and draw on the part directly.
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
