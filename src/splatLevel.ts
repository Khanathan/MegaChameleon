// SplatLevelProvider (M7): build a Gaussian-splat room from one uploaded image. It calls our own
// /api proxies (which hold the fal.ai key) to (1) hallucinate the full room as a 360 panorama and
// (2) estimate its depth, then hands those two image URLs back in the LevelDefinition. The actual
// lift (panorama+depth -> 3D points) happens in splatRoom during loadLevel — this file only does
// the network orchestration and returns the same LevelDefinition shape as every other provider.
import type { LevelDefinition } from './levels'
import { shrinkToCanvas, readPalette } from './imageLevel'

type Progress = (msg: string) => void

// POST a JSON body to one of our /api routes and return the parsed JSON.
async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${await res.text()}`)
  return res.json() as Promise<T>
}

export async function imageToSplatLevel(file: File, onProgress: Progress): Promise<LevelDefinition> {
  onProgress('Reading image…')
  const canvas = await shrinkToCanvas(file, 1024) // a bit bigger than M6: better panorama input
  const palette = readPalette(canvas)             // paint-toolbar colors only (no obstacles here)
  const imageUrl = canvas.toDataURL('image/jpeg', 0.9) // sent to the proxy; fal accepts data URIs

  onProgress('Hallucinating the room (360°)… this can take ~30–90s')
  const { panoUrl } = await api<{ panoUrl: string }>('/api/pano', { imageUrl })

  onProgress('Estimating depth…')
  const { depthUrl } = await api<{ depthUrl: string }>('/api/depth', { panoUrl })

  onProgress('Lifting to a 3D splat…')
  return {
    name: 'Splat Room',
    size: { width: 50, depth: 50, height: 30 },
    surfaces: { ...SPLAT_BOUNDARY_SURFACES },
    palette: [...palette, '#ffffff', '#000000'],
    obstacles: [], // NO seeded boxes for splat levels — the splat's own geometry is the cover, and
                   // collision/detection come from the occupancy + color fields baked in splatRoom.
    seekerStart: [10, 6, -8],
    splatLift: { panoUrl, depthUrl },
  }
}

// The six invisible boundary walls a splat room needs (loadLevel hides them; detection + eyedrop
// read the splat, not these). Shared by every splat level so the shape lives in one place.
const SPLAT_BOUNDARY_SURFACES = {
  floor: { color: '#888888' }, ceiling: { color: '#888888' },
  back: { color: '#888888' }, front: { color: '#888888' },
  left: { color: '#888888' }, right: { color: '#888888' },
}

// Import path: turn a user's ready-made .ply splat straight into a room — no network, no fal. The
// file's bytes are fetched + parsed in loadLevel (via splatUrl); here we only wrap it as a level.
// We can't read a source image for paint swatches, so we hand back a neutral palette — the player
// eyedrops real colors off the splat itself anyway.
export function plyToSplatLevel(file: File): LevelDefinition {
  return {
    name: 'Imported Splat',
    size: { width: 50, depth: 50, height: 30 },
    surfaces: { ...SPLAT_BOUNDARY_SURFACES },
    palette: ['#ffffff', '#cfcfcf', '#9a9a9a', '#5a5a5a', '#000000'],
    obstacles: [], // the splat's own geometry is the cover (occupancy field in splatRoom)
    seekerStart: [10, 6, -8],
    splatUrl: URL.createObjectURL(file), // blob: URL; loadLevel fetches its bytes, ui revokes after
  }
}
