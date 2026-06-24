// A room is data: a LevelDefinition that a LevelProvider hands back. The game never builds the
// room directly — loadLevel() turns a definition into meshes. Swapping the level-maker (built-in
// vs. uploaded image) touches nothing else.
import * as THREE from 'three'
import amogusUrl from '../assets/amogus.jpeg' // Vite turns this into a bundled image URL
import { scene } from './engine'
import { paintableParts } from './chameleon'
import { buildSplatRoom, buildSplatRoomFromPly, disposeSplatRoom } from './splatRoom'

export type Surface = { color: string } | { image: string } // a flat color or an image url
export interface Obstacle { size: [number, number, number]; pos: [number, number, number]; surface: Surface }
export interface LevelDefinition {
  name: string
  size: { width: number; depth: number; height: number }
  surfaces: { floor: Surface; ceiling: Surface; back: Surface; front: Surface; left: Surface; right: Surface }
  palette: string[]            // paint-toolbar swatches
  obstacles: Obstacle[]
  seekerStart: [number, number, number]
  splatUrl?: string            // M7: a ready-made splat file (hosted/endpoint backends)
  splatLift?: { panoUrl: string; depthUrl: string } // M7 DIY backend: build the splat in-browser
  splatTransform?: {           // manual orientation/placement fix for the lifted splat (M7)
    rotation?: [number, number, number]
    offset?: [number, number, number]
  }
}
export interface LevelProvider { getLevel(id: string): Promise<LevelDefinition> }

// current room size — updated by loadLevel; the collision + camera clamps read these every frame
export const ROOM = { width: 50, depth: 50, height: 30 }
export let halfW = ROOM.width / 2
export let halfD = ROOM.depth / 2
export const t = 0.2 // wall thickness
export const environment: THREE.Mesh[] = [] // current room's surfaces (walls/floor/ceiling/obstacles)
const levelMeshes: THREE.Mesh[] = []        // everything loadLevel made, kept so we can dispose on a swap
// obstacle boxes (center + half-extents) the chameleon collides against, so it can't pass through
export const obstacleBoxes: { x: number; y: number; z: number; hx: number; hy: number; hz: number }[] = []
export let seekerStart: [number, number, number] = [10, 6, -8] // where the seeker spawns (set per level)
export let pickTargets: THREE.Mesh[] = []   // everything the eyedropper can hit (rebuilt per level)
export let detectTargets: THREE.Mesh[] = [] // everything the seeker's ray can hit (rebuilt per level)

// Build an image-backed material on a FIXED 512x512 canvas (a power-of-two size, never resized
// after the texture is made — resizing later can leave the GPU texture stuck blank/black). It
// starts grey, then the image is drawn once it loads. The canvas backs the texture so the
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

// build one box (wall/floor/ceiling/obstacle), flat-color or image, and register it as part of the
// room: into the scene, into `environment` (so the eyedropper + seeker see it), and into
// `levelMeshes` (so a map swap can dispose it).
function buildBox(w: number, h: number, d: number, x: number, y: number, z: number, s: Surface, visible = true) {
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
  mesh.visible = visible // splat rooms hide the box walls; they stay only as the collision boundary
  mesh.userData = userData
  scene.add(mesh)
  environment.push(mesh)
  levelMeshes.push(mesh)
}

// read the known color of whatever a ray hit: a painted/image canvas pixel, or a flat surface's
// material color. The eyedropper and the seeker both use this — never a GPU pixel read-back.
export function readHitColor(hit: THREE.Intersection): string {
  const obj = hit.object as THREE.Mesh
  const ctx = (obj.userData as { ctx?: CanvasRenderingContext2D }).ctx
  if (ctx && hit.uv) {
    const p = ctx.getImageData(hit.uv.x * ctx.canvas.width, (1 - hit.uv.y) * ctx.canvas.height, 1, 1).data
    return '#' + [p[0], p[1], p[2]].map((n) => n.toString(16).padStart(2, '0')).join('')
  }
  return '#' + (obj.material as THREE.MeshStandardMaterial).color.getHexString()
}

// free the current room's meshes before loading another, or Three.js leaks them every swap.
// (The chameleon and seeker are NOT part of the level, so they're left alone.)
export function disposeLevel() {
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
  disposeSplatRoom() // free the previous splat's renderer + baked fields, if any
}

// build a whole room from a definition: size, six surfaces, obstacles, seeker start. (The palette
// swatches are built by the caller, in ui, to keep this module free of any painting dependency.)
let loadGen = 0 // bumped each load so a slow splat build that finishes after a newer swap is dropped
export async function loadLevel(def: LevelDefinition) {
  const gen = ++loadGen
  disposeLevel()
  ROOM.width = def.size.width
  ROOM.depth = def.size.depth
  ROOM.height = def.size.height
  halfW = ROOM.width / 2
  halfD = ROOM.depth / 2
  const { width: W, depth: D, height: H } = def.size
  const vis = !(def.splatLift || def.splatUrl) // splat rooms keep the box walls only as a boundary
  buildBox(W, 0.2, D, 0, -0.1, 0, def.surfaces.floor, vis)         // floor
  buildBox(W, 0.2, D, 0, H + 0.1, 0, def.surfaces.ceiling, vis)    // ceiling
  buildBox(W, H, t, 0, H / 2, -halfD, def.surfaces.back, vis)      // back wall (-z)
  buildBox(W, H, t, 0, H / 2, halfD, def.surfaces.front, vis)      // front wall (+z)
  buildBox(t, H, D, -halfW, H / 2, 0, def.surfaces.left, vis)      // left wall (-x)
  buildBox(t, H, D, halfW, H / 2, 0, def.surfaces.right, vis)      // right wall (+x)
  for (const o of def.obstacles) {
    buildBox(o.size[0], o.size[1], o.size[2], o.pos[0], o.pos[1], o.pos[2], o.surface)
    obstacleBoxes.push({
      x: o.pos[0], y: o.pos[1], z: o.pos[2],
      hx: o.size[0] / 2, hy: o.size[1] / 2, hz: o.size[2] / 2,
    })
  }
  seekerStart = def.seekerStart
  // the eyedropper + seeker raycast against these; refresh them now that the room changed
  pickTargets = [...environment, ...paintableParts]
  detectTargets = [...paintableParts, ...environment]

  // M7: DIY splat backend — lift the panorama+depth into a splat and bake its CPU fields. This is
  // slow (network + lift), so guard against a newer map swap finishing first.
  if (def.splatLift) {
    await buildSplatRoom(def.splatLift.panoUrl, def.splatLift.depthUrl, def.size, def.splatTransform)
    if (gen !== loadGen) disposeSplatRoom() // superseded by a newer load — drop this splat
  } else if (def.splatUrl) {
    // a ready-made splat file (the "import" path): fetch its bytes and build directly from them.
    let buffer: ArrayBuffer
    try {
      const r = await fetch(def.splatUrl)
      if (!r.ok) throw new Error(`fetch returned ${r.status}`)
      buffer = await r.arrayBuffer()
    } catch (err) {
      throw new Error(`Reading the splat file: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
    if (gen !== loadGen) return // superseded while downloading — don't bother building
    await buildSplatRoomFromPly(buffer, def.size, def.splatTransform)
    if (gen !== loadGen) disposeSplatRoom()
  }
}

// the hand-made rooms
export const MAPS: Record<string, LevelDefinition> = {
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
export const BuiltInMaps: LevelProvider = {
  getLevel(id: string) { return Promise.resolve(MAPS[id]) }, // instant, but async to match the image provider
}
