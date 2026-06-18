// ImagePaletteProvider — build a level from an uploaded image, all in-browser. Returns the same
// LevelDefinition the built-ins do, so loadLevel + everything downstream is untouched; only the
// input differs (a File instead of an id).
import type { LevelDefinition, Surface, Obstacle } from './levels'

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
export async function imageToLevel(file: File): Promise<LevelDefinition> {
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
