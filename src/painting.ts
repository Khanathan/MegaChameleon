// Painting (paint sub-mode, Q during hiding): tools, the toolbar, custom cursors, and drawing
// onto the chameleon's per-part canvases. Also reads colors off surfaces for the eyedropper.
import * as THREE from 'three'
import { canvas, camera, renderer } from './engine'
import { paintableParts, PAINT_CANVAS, PAINT_COLS, PAINT_ROWS, SKIN } from './chameleon'
import { game, look, settings, BASE_SENSITIVITY, PITCH_MIN, PITCH_MAX } from './state'

const paintToolbar = document.getElementById('paint-toolbar') as HTMLDivElement
const currentColorEl = document.getElementById('current-color') as HTMLSpanElement
const colorInput = document.getElementById('color-input') as HTMLInputElement
const swatchesEl = document.getElementById('swatches') as HTMLSpanElement

type Tool = 'pencil' | 'brush' | 'fill' | 'pick'
let currentTool: Tool | null = 'pencil' // null = no tool, normal cursor
let currentColor = SKIN

export function setColor(hex: string) {
  currentColor = hex
  currentColorEl.style.background = hex
  colorInput.value = hex
}

// Each tool's cursor is a 32px PNG drawn from the *same* icon as its button, with a hotspot (the
// real click point). Emoji tools (pencil, brush) draw the glyph; SVG-icon tools (fill, pick)
// rasterize their <svg>. Rasterizing an SVG goes through Image().onload, so it fills in a moment.
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
function updateCursor() {
  if (!game.paintMode || !currentTool) { canvas.style.cursor = ''; return }
  canvas.style.cursor = TOOL_CURSORS[currentTool] ?? 'crosshair'
}

// switch tool + highlight its button (clicks AND number keys). Picking the active tool again
// turns it off (back to no tool / normal cursor).
export function selectTool(tool: Tool) {
  currentTool = currentTool === tool ? null : tool
  for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-toolbar .tool')) {
    b.classList.toggle('selected', b.dataset.tool === currentTool)
  }
  updateCursor()
}

// number-key shortcuts: 1 pencil · 2 brush · 3 fill · 4 pick (handled in the input keydown)
export const TOOL_KEYS: Record<string, Tool> = { '1': 'pencil', '2': 'brush', '3': 'fill', '4': 'pick' }

// (re)build the swatch buttons from a level's palette; called by ui after a level loads
export function buildSwatches(palette: string[]) {
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

// pick = read the actual rendered pixel under the cursor, straight off the WebGL canvas. This is the
// most faithful "what you see is what you get": it samples whatever was last drawn there — splat,
// model, or wall — exactly as displayed (lighting + tone-mapping included). A GPU read-back is fine
// HERE because it's a one-off on click, not the per-frame path (the seeker still judges from known
// colors, never a read-back). Needs preserveDrawingBuffer on the renderer (set in engine.ts).
const _pixel = new Uint8Array(4) // reused, no per-click garbage
function pickColor(e: MouseEvent) {
  const rect = canvas.getBoundingClientRect()
  // Map the cursor (CSS pixels) to drawing-buffer pixels. canvas.width/height already include the
  // device pixel ratio, so this works on hi-dpi screens without any extra math.
  const bw = canvas.width, bh = canvas.height
  const x = Math.max(0, Math.min(bw - 1, Math.floor(((e.clientX - rect.left) / rect.width) * bw)))
  const yTop = Math.max(0, Math.min(bh - 1, Math.floor(((e.clientY - rect.top) / rect.height) * bh)))
  const gl = renderer.getContext()
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)            // read the on-screen framebuffer (not a target)
  // WebGL's framebuffer origin is bottom-left, so flip y from our top-left cursor coordinate.
  gl.readPixels(x, bh - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _pixel)
  setColor('#' + [_pixel[0], _pixel[1], _pixel[2]].map((n) => n.toString(16).padStart(2, '0')).join(''))
}

export function enterPaintMode() {
  document.exitPointerLock()              // show the real cursor for the toolbar + aiming
  paintToolbar.classList.remove('hidden')
  updateCursor()                          // show the selected tool's icon as the cursor
}
export function exitPaintMode() {
  paintToolbar.classList.add('hidden')
  painting = false
  orbiting = false
  canvas.style.cursor = ''                // back to the normal cursor
}

// paint-mode mouse: left paints (or fills/picks), right-drag orbits the camera
window.addEventListener('mousedown', (e) => {
  if (!game.paintMode) return
  if (e.button === 2) { orbiting = true; return }         // right button orbits the camera
  if (e.button !== 0) return
  if (!currentTool) return                                // no tool selected → clicking does nothing
  if (currentTool === 'fill') fillAll()
  else if (currentTool === 'pick') pickColor(e)
  else { painting = true; lastUV = null; paintAt(e) }     // pencil / brush
})
window.addEventListener('mousemove', (e) => {
  if (!game.paintMode) return
  if (orbiting) {                                          // drag right button to look around
    const s = BASE_SENSITIVITY * settings.sensitivity
    look.yaw -= e.movementX * s
    look.pitch -= e.movementY * s
    look.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, look.pitch))
    return
  }
  if (painting) paintAt(e)
})
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { painting = false; lastUV = null }
  if (e.button === 2) orbiting = false
})
