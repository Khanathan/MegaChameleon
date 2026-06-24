// The Gaussian-splat room (M7). One module owns everything splat-specific so the rest of the game
// stays clean: the DIY lift (panorama + depth -> 3D points), handing those points to the splat
// renderer, and the CPU "fields" baked from the same points that the seeker, eyedropper and
// collision read every frame. It imports only `three` + `engine` (never `levels`), so there's no
// import cycle — callers in levels/seeker/controls/painting import THIS, downward.
import * as THREE from 'three'
import { scene } from './engine'
import { errText } from './errors'

// ----- the gaussians, as plain arrays we own -----
// We build these ourselves in the DIY lift, so the color/occupancy bake reads them directly and
// never has to dig colors back out of the splat library's internal buffers.
interface SplatData {
  positions: Float32Array // x,y,z per point (world space, already fitted to the room)
  colors: Uint8Array      // r,g,b per point (0-255)
  count: number
}

// ----- baked CPU fields (built once at load) -----
const GRID = 40                 // voxels per axis over the room box (collision + color sampling)
const DENSITY = 2               // a voxel needs at least this many points to count as "solid"
let grid = GRID
let roomSize = { width: 50, depth: 50, height: 30 }
let colorField: Float32Array | null = null  // GRID^3 * 3, average color per voxel (0..1, linear-ish)
let countGrid: Uint16Array | null = null    // GRID^3, how many points fell in each voxel
let viewer: { object?: THREE.Object3D; dispose?: () => void; update?: () => void } | null = null
let active = false

// the fitted points of the room currently loaded, kept so the player can download the splat as a
// standard .ply (see exportSplatPly). Cleared on dispose, so it only exists for a live splat room.
let lastSplat: { positions: Float32Array; colors: Uint8Array; count: number; scale: number } | null = null

// the AI-generated 360° panorama URL the DIY-lift room was built from, kept so the player can
// download that source image (see fetchPanoBlob). Only the panorama-lift path sets it — an imported
// .ply has no source panorama — and it's cleared on dispose, alongside lastSplat.
let lastPanoUrl: string | null = null

export function isSplatRoom() { return active }

// voxel index helpers: world position -> grid cell. The room box spans x,z in [-W/2,W/2] and
// y in [0,H]; anything outside maps to an edge cell (clamped).
function vx(x: number) { return clampCell(((x + roomSize.width / 2) / roomSize.width) * grid) }
function vy(y: number) { return clampCell((y / roomSize.height) * grid) }
function vz(z: number) { return clampCell(((z + roomSize.depth / 2) / roomSize.depth) * grid) }
function clampCell(c: number) { return Math.max(0, Math.min(grid - 1, Math.floor(c))) }
function cellIndex(ix: number, iy: number, iz: number) { return (iz * grid + iy) * grid + ix }

// ----- build: lift the panorama+depth into points, render them, and bake the fields -----
export async function buildSplatRoom(
  panoUrl: string,
  depthUrl: string,
  size: { width: number; depth: number; height: number },
  transform?: { rotation?: [number, number, number]; offset?: [number, number, number] },
) {
  roomSize = size
  grid = GRID
  lastPanoUrl = panoUrl // remember the source panorama so the player can download it
  const data = await liftPanoramaToPoints(panoUrl, depthUrl)
  await bakeAndRender(data, size, transform)
}

// Build a splat room from an already-made .ply file (the "import" path). Same downstream as the DIY
// lift: parse the file into points, then fit/bake/render exactly as buildSplatRoom does. The fit
// step auto-scales whatever the file's coordinate range is to fill the room box, so any splat works.
export async function buildSplatRoomFromPly(
  buffer: ArrayBuffer,
  size: { width: number; depth: number; height: number },
  transform?: { rotation?: [number, number, number]; offset?: [number, number, number] },
) {
  roomSize = size
  grid = GRID
  lastPanoUrl = null // an imported .ply has no source panorama to download
  let data: SplatData
  try {
    data = parsePly(buffer)
  } catch (err) {
    throw new Error(`Reading the .ply file: ${errText(err)}`, { cause: err })
  }
  await bakeAndRender(data, size, transform)
}

// shared tail of both build paths: place the cloud in the room, bake the CPU fields, render it.
async function bakeAndRender(
  data: SplatData,
  size: { width: number; depth: number; height: number },
  transform?: { rotation?: [number, number, number]; offset?: [number, number, number] },
) {
  fitPointsToRoom(data, size, transform) // scale+center the cloud so it fills the room box
  bakeFields(data)
  const splatScale = (roomSize.width / grid) * 0.6 // each gaussian ~ one voxel wide (shared below)
  lastSplat = { positions: data.positions, colors: data.colors, count: data.count, scale: splatScale }
  await renderPoints(data, splatScale) // hand the points to the splat library (the one playtest seam)
  active = true
}

// free the splat + fields on a map swap (mirrors disposeLevel for the box room)
export function disposeSplatRoom() {
  if (viewer) {
    if (viewer.object) scene.remove(viewer.object)
    viewer.dispose?.()
    viewer = null
  }
  colorField = null
  countGrid = null
  lastSplat = null
  lastPanoUrl = null
  active = false
}

// called every frame from the loop; the splat library re-sorts its gaussians per view
export function updateSplatRoom() { viewer?.update?.() }

// ----- let the player download the generated room as a real Gaussian-splat .ply -----
// SH degree-0 basis constant: the conversion factor between a plain 0..1 color and the f_dc
// coefficient that splat files store (color = 0.5 + C0 * f_dc).
const SH_C0 = 0.28209479177387814

// is there a splat room loaded right now that we could hand back as a file?
export function canExportSplat() { return lastSplat !== null }

// The player's download button: hand back the current room as a .ply, or null if no splat is loaded.
export function exportSplatPly(): Blob | null {
  if (!lastSplat) return null
  return splatToPlyBlob(lastSplat.positions, lastSplat.colors, lastSplat.count, lastSplat.scale)
}

// is there an AI-generated panorama behind the current room (the DIY-lift path, not an import)?
export function canExportPano() { return lastPanoUrl !== null }

// The "Download panorama" button: fetch the source panorama's bytes and hand them back as a blob
// plus a sensible file extension. The lift already read this same URL's pixels, so CORS is known to
// work. Returns null if no panorama room is loaded; throws a labeled error if the fetch fails.
export async function fetchPanoBlob(): Promise<{ blob: Blob; ext: string } | null> {
  if (!lastPanoUrl) return null
  let res: Response
  try {
    res = await fetch(lastPanoUrl)
    if (!res.ok) throw new Error(`the image server returned ${res.status}`)
  } catch (err) {
    throw new Error(`Downloading the panorama: ${errText(err)}`, { cause: err })
  }
  const blob = await res.blob()
  // pick the extension from the content type fal returned (hunyuan_world serves PNG today).
  const ext = blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png'
  return { blob, ext }
}

// Serialize points as a standard 3D-Gaussian-Splat binary .ply (little-endian), the same layout the
// INRIA/3DGS tools write — so the file opens in SuperSplat, Blender add-ons, etc. We use it both for
// the player's download AND to feed the renderer, which loads .ply through its own PlyLoader (its
// raw-point class isn't a public export in this version). Per point: position, zero normals, the
// color as a degree-0 SH coefficient (f_dc), opacity pre-sigmoid, log scale, and identity rotation.
function splatToPlyBlob(p: Float32Array, c: Uint8Array, count: number, scale: number): Blob {
  const FIELDS = 17 // x y z · nx ny nz · f_dc_0..2 · opacity · scale_0..2 · rot_0..3
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element vertex ${count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property float nx\nproperty float ny\nproperty float nz\n' +
    'property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n' +
    'property float opacity\n' +
    'property float scale_0\nproperty float scale_1\nproperty float scale_2\n' +
    'property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n' +
    'end_header\n'
  const headerBytes = new TextEncoder().encode(header)
  const body = new ArrayBuffer(count * FIELDS * 4)
  const view = new DataView(body)
  const logScale = Math.log(scale)
  const OPACITY = 8 // pre-sigmoid; sigmoid(8) ~= 1, i.e. fully opaque after the viewer activates it
  let o = 0
  const f = (v: number) => { view.setFloat32(o, v, true); o += 4 }
  for (let i = 0; i < count; i++) {
    f(p[i * 3]); f(p[i * 3 + 1]); f(p[i * 3 + 2])        // position
    f(0); f(0); f(0)                                      // normals (splats ignore these)
    f((c[i * 3] / 255 - 0.5) / SH_C0)                     // color -> degree-0 SH (f_dc)
    f((c[i * 3 + 1] / 255 - 0.5) / SH_C0)
    f((c[i * 3 + 2] / 255 - 0.5) / SH_C0)
    f(OPACITY)                                            // opacity (pre-sigmoid)
    f(logScale); f(logScale); f(logScale)                // isotropic scale (stored as log)
    f(1); f(0); f(0); f(0)                                // identity rotation (w,x,y,z)
  }
  const out = new Uint8Array(headerBytes.length + body.byteLength)
  out.set(headerBytes, 0)
  out.set(new Uint8Array(body), headerBytes.length)
  return new Blob([out], { type: 'application/octet-stream' })
}

// ===== DIY lift: panorama (equirectangular) + depth map -> a colored point cloud =====
// For each pixel of the panorama we know its direction (longitude/latitude from the equirect
// layout) and its distance (the depth map). direction * distance = a 3D point; the panorama pixel
// is its color. We stride over pixels to keep the point count sane.
const STRIDE = 3 // sample every Nth pixel each axis (1920x960 / 3 ~= 200k points)

async function liftPanoramaToPoints(panoUrl: string, depthUrl: string): Promise<SplatData> {
  const [pano, depth] = await Promise.all([
    loadPixels(panoUrl, 'panorama'),
    loadPixels(depthUrl, 'depth map'),
  ])
  const W = pano.width, H = pano.height
  const positions: number[] = []
  const colors: number[] = []
  for (let py = 0; py < H; py += STRIDE) {
    // latitude: top row (+pi/2) down to bottom row (-pi/2)
    const lat = (0.5 - py / H) * Math.PI
    const cosLat = Math.cos(lat), sinLat = Math.sin(lat)
    for (let px = 0; px < W; px += STRIDE) {
      const lon = (px / W) * 2 * Math.PI - Math.PI // -pi..pi around
      const i = (py * W + px) * 4
      // depth maps store distance as brightness; read the red channel as 0..1 and scale. We treat
      // brighter = farther. If the chosen depth model uses the opposite convention (near = bright),
      // the room comes out inside-out — fix by inverting here: use (1 - sampleDepth/255).
      const dist = (sampleDepth(depth, px / W, py / H) / 255) * (roomSize.width * 0.6) + 0.5
      // equirect direction -> unit vector (y up)
      positions.push(cosLat * Math.sin(lon) * dist, sinLat * dist, cosLat * Math.cos(lon) * dist)
      colors.push(pano.data[i], pano.data[i + 1], pano.data[i + 2])
    }
  }
  const count = colors.length / 3
  if (!count) throw new Error('the lift produced no 3D points (the panorama or depth map was empty)')
  return { positions: new Float32Array(positions), colors: new Uint8Array(colors), count }
}

// ===== parse an imported .ply into the same colored point cloud the lift produces =====
// Handles the standard binary Gaussian-splat .ply (what we export, and what SuperSplat and the
// INRIA tools write) plus plain colored point clouds. We only take each point's position and a
// single base color — we drop the per-gaussian scale/rotation/opacity and re-render every point as
// one uniform small gaussian, the same way the DIY lift does. That keeps the room's colors and the
// voxel fields (detection + collision) coherent, at the cost of the original's exact look.
const PLY_TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
}
const MAX_IMPORT_POINTS = 800_000 // cap so a multi-million-gaussian file doesn't freeze the tab

function parsePly(buffer: ArrayBuffer): SplatData {
  const bytes = new Uint8Array(buffer)
  // the header is ascii; decode the start of the file and find where it ends. 1 char = 1 byte in
  // the header, so a string index there is also the byte offset of the binary body that follows.
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)))
  const endTag = head.indexOf('end_header')
  if (endTag < 0) throw new Error('not a .ply file (no header found)')
  const dataStart = head.indexOf('\n', endTag) + 1

  // read the header: the format (endianness), the vertex count, and each vertex property in order.
  let littleEndian = true
  let ascii = false
  let count = 0
  let inVertex = false
  const props: { name: string; type: string; offset: number }[] = []
  let stride = 0
  for (const raw of head.slice(0, dataStart).split('\n')) {
    const parts = raw.trim().split(/\s+/)
    if (parts[0] === 'format') {
      ascii = parts[1] === 'ascii'
      littleEndian = parts[1] !== 'binary_big_endian'
    } else if (parts[0] === 'element') {
      inVertex = parts[1] === 'vertex'
      if (inVertex) count = parseInt(parts[2], 10)
    } else if (parts[0] === 'property' && inVertex) {
      // we don't support list properties on a vertex (splats don't use them)
      const type = parts[1]
      const name = parts[parts.length - 1]
      props.push({ name, type, offset: stride })
      stride += PLY_TYPE_SIZE[type] ?? 0
    } else if (parts[0] === 'element' && !inVertex) {
      inVertex = false
    }
  }
  if (ascii) throw new Error('this .ply is ASCII; please export a binary .ply')
  if (!count) throw new Error('this .ply has no points')

  const find = (name: string) => props.find((p) => p.name === name)
  const px = find('x'), py = find('y'), pz = find('z')
  if (!px || !py || !pz) throw new Error('this .ply has no x/y/z positions')
  // colors: prefer a plain red/green/blue, else a Gaussian-splat degree-0 SH coefficient (f_dc).
  const rgb = [find('red'), find('green'), find('blue')]
  const dc = [find('f_dc_0'), find('f_dc_1'), find('f_dc_2')]
  const hasRGB = rgb.every(Boolean)
  const hasDC = dc.every(Boolean)

  const view = new DataView(buffer, dataStart)
  const readAt = (off: number, type: string): number => {
    switch (type) {
      case 'float': case 'float32': return view.getFloat32(off, littleEndian)
      case 'double': case 'float64': return view.getFloat64(off, littleEndian)
      case 'uchar': case 'uint8': return view.getUint8(off)
      case 'char': case 'int8': return view.getInt8(off)
      case 'ushort': case 'uint16': return view.getUint16(off, littleEndian)
      case 'short': case 'int16': return view.getInt16(off, littleEndian)
      case 'uint': case 'uint32': return view.getUint32(off, littleEndian)
      case 'int': case 'int32': return view.getInt32(off, littleEndian)
      default: return 0
    }
  }
  // a color channel may be a 0..255 integer or a 0..1 float — normalize either to a 0..255 byte.
  const colorByte = (off: number, type: string) => {
    let v = readAt(off, type)
    if (type.startsWith('float') || type.startsWith('double')) v *= 255
    return Math.max(0, Math.min(255, Math.round(v)))
  }

  // huge files are subsampled so the bake + render stay responsive (mirrors the lift's STRIDE).
  const keep = Math.max(1, Math.ceil(count / MAX_IMPORT_POINTS))
  const out = Math.ceil(count / keep)
  const positions = new Float32Array(out * 3)
  const colors = new Uint8Array(out * 3)
  let j = 0
  for (let i = 0; i < count; i += keep) {
    const base = i * stride
    positions[j * 3] = readAt(base + px.offset, px.type)
    positions[j * 3 + 1] = readAt(base + py.offset, py.type)
    positions[j * 3 + 2] = readAt(base + pz.offset, pz.type)
    if (hasRGB) {
      colors[j * 3] = colorByte(base + rgb[0]!.offset, rgb[0]!.type)
      colors[j * 3 + 1] = colorByte(base + rgb[1]!.offset, rgb[1]!.type)
      colors[j * 3 + 2] = colorByte(base + rgb[2]!.offset, rgb[2]!.type)
    } else if (hasDC) {
      for (let k = 0; k < 3; k++) {
        const c = 0.5 + SH_C0 * readAt(base + dc[k]!.offset, dc[k]!.type) // SH degree-0 -> 0..1
        colors[j * 3 + k] = Math.max(0, Math.min(255, Math.round(c * 255)))
      }
    } else {
      colors[j * 3] = colors[j * 3 + 1] = colors[j * 3 + 2] = 128 // no color in file -> mid grey
    }
    j++
  }
  return { positions, colors, count: out }
}

// draw an image url onto a canvas and read its pixels (we need the raw RGBA on the CPU). `label`
// names which image this is (panorama / depth map) so a failure says exactly what didn't load.
async function loadPixels(url: string, label: string): Promise<ImageData> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => res(i)
    i.onerror = () => rej(new Error(`couldn't load the ${label} image (it may have failed to generate, or be blocked by CORS)`))
    i.src = url
  })
  if (!img.width || !img.height) throw new Error(`the ${label} image is empty (0×0)`)
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const cx = c.getContext('2d')
  if (!cx) throw new Error('the browser gave no 2D canvas context to read image pixels')
  cx.drawImage(img, 0, 0)
  try {
    return cx.getImageData(0, 0, c.width, c.height)
  } catch (err) {
    // getImageData throws if the canvas is "tainted" by a cross-origin image without CORS headers.
    throw new Error(`couldn't read the ${label} pixels (the image's server is missing CORS headers)`, { cause: err })
  }
}

// the depth map may be a different size than the panorama; sample it by fraction (u,v in 0..1)
function sampleDepth(depth: ImageData, u: number, v: number) {
  const dx = Math.min(depth.width - 1, Math.floor(u * depth.width))
  const dy = Math.min(depth.height - 1, Math.floor(v * depth.height))
  return depth.data[(dy * depth.width + dx) * 4]
}

// ===== fit: scale+center the cloud so its bounding box fills the room box =====
function fitPointsToRoom(
  data: SplatData,
  size: { width: number; depth: number; height: number },
  transform?: { rotation?: [number, number, number]; offset?: [number, number, number] },
) {
  const p = data.positions
  // optional manual rotation (lifted panoramas can come in rolled/upside-down)
  if (transform?.rotation) {
    const e = new THREE.Euler(transform.rotation[0], transform.rotation[1], transform.rotation[2])
    const m = new THREE.Matrix4().makeRotationFromEuler(e)
    const v = new THREE.Vector3()
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m)
      p[i] = v.x; p[i + 1] = v.y; p[i + 2] = v.z
    }
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i])
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1])
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2])
  }
  const sx = maxX - minX || 1, sy = maxY - minY || 1, sz = maxZ - minZ || 1
  const TARGET = 0.95 // a room shell should fill the box
  const scale = Math.min((size.width * TARGET) / sx, (size.height * TARGET) / sy, (size.depth * TARGET) / sz)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
  const off = transform?.offset ?? [0, 0, 0]
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (p[i] - cx) * scale + off[0]
    p[i + 1] = (p[i + 1] - cy) * scale + size.height / 2 + off[1] // center the shell vertically in the room
    p[i + 2] = (p[i + 2] - cz) * scale + off[2]
  }
}

// ===== bake the color + occupancy fields from the fitted points =====
function bakeFields(data: SplatData) {
  const n = grid * grid * grid
  const sum = new Float32Array(n * 3)
  const cnt = new Uint16Array(n)
  const p = data.positions, c = data.colors
  for (let i = 0; i < data.count; i++) {
    const idx = cellIndex(vx(p[i * 3]), vy(p[i * 3 + 1]), vz(p[i * 3 + 2]))
    sum[idx * 3] += c[i * 3]
    sum[idx * 3 + 1] += c[i * 3 + 1]
    sum[idx * 3 + 2] += c[i * 3 + 2]
    if (cnt[idx] < 65535) cnt[idx]++
  }
  const avg = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    if (cnt[i] > 0) {
      avg[i * 3] = sum[i * 3] / cnt[i]
      avg[i * 3 + 1] = sum[i * 3 + 1] / cnt[i]
      avg[i * 3 + 2] = sum[i * 3 + 2] / cnt[i]
    }
  }
  colorField = avg
  countGrid = cnt
}

// ----- queries the rest of the game uses every frame -----

// is the voxel at this world point "solid" (enough gaussians to bump into)?
export function splatSolidAt(x: number, y: number, z: number): boolean {
  if (!countGrid) return false
  return countGrid[cellIndex(vx(x), vy(y), vz(z))] >= DENSITY
}

// march from `point` along `dir` until a solid voxel; return its baked color as #rrggbb, or null
// if nothing solid is in front (the chameleon is out in the open -> it stands out -> caught).
const _step = new THREE.Vector3()
export function readSplatColor(point: THREE.Vector3, dir: THREE.Vector3): string | null {
  if (!colorField || !countGrid) return null
  const stepLen = roomSize.width / grid // ~ one voxel
  _step.copy(dir).normalize().multiplyScalar(stepLen)
  let x = point.x, y = point.y, z = point.z
  for (let s = 0; s < grid * 2; s++) {
    const idx = cellIndex(vx(x), vy(y), vz(z))
    if (countGrid[idx] >= DENSITY) {
      const r = Math.round(colorField[idx * 3]), g = Math.round(colorField[idx * 3 + 1]), b = Math.round(colorField[idx * 3 + 2])
      return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
    }
    x += _step.x; y += _step.y; z += _step.z
  }
  return null
}

// push a moving box out of solid voxels, one axis at a time (voxel-game style). The caller passes
// the box centre (cx,cy,cz) and half-extents (hx,hy,hz); we return how far to nudge it. Resolving
// per axis gives wall-sliding for free and matches the box room's per-axis push-out.
export function resolveSplatCollision(
  cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
): { dx: number; dy: number; dz: number } {
  const out = { dx: 0, dy: 0, dz: 0 }
  if (!countGrid) return out
  const step = roomSize.width / grid
  // probe the centre of each box face; if it's in a solid voxel, nudge one step the other way.
  // coarse but cheap, and the box room is still the hard boundary behind this.
  if (splatSolidAt(cx + hx, cy, cz)) out.dx = -step
  else if (splatSolidAt(cx - hx, cy, cz)) out.dx = step
  if (splatSolidAt(cx, cy + hy, cz)) out.dy = -step
  else if (splatSolidAt(cx, cy - hy, cz)) out.dy = step
  if (splatSolidAt(cx, cy, cz + hz)) out.dz = -step
  else if (splatSolidAt(cx, cy, cz - hz)) out.dz = step
  return out
}

// ===== render the points via the splat library =====
// We serialize our points to a standard .ply (splatToPlyBlob) and load it through the library's own
// PlyLoader via DropInViewer.addSplatScene — the supported public path. (Its raw-point builder
// class, UncompressedSplatArray, is NOT a public export in 0.4.7, so we go through .ply instead.)
// `sharedMemoryForWorkers: false` avoids needing cross-origin-isolation (COOP/COEP) headers, which
// a plain Vercel deploy doesn't send; without it the splat sort worker can't start.
async function renderPoints(data: SplatData, SCALE: number) {
  let GS: any
  try {
    GS = await import('@mkkellogg/gaussian-splats-3d')
  } catch (err) {
    throw new Error('Rendering the splat: could not load the renderer (@mkkellogg/gaussian-splats-3d)', { cause: err })
  }
  const blobUrl = URL.createObjectURL(splatToPlyBlob(data.positions, data.colors, data.count, SCALE))
  try {
    const dropIn = new GS.DropInViewer({ gpuAcceleratedSort: true, sharedMemoryForWorkers: false })
    await dropIn.addSplatScene(blobUrl, {
      format: GS.SceneFormat.Ply,
      showLoadingUI: false,
      progressiveLoad: false, // load it all before resolving, so the blob URL is safe to revoke
    })
    scene.add(dropIn)
    viewer = { object: dropIn, dispose: () => dropIn.dispose?.(), update: () => dropIn.update?.() }
  } catch (err) {
    throw new Error(`Rendering the splat: the renderer failed on ${data.count} points`, { cause: err })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
