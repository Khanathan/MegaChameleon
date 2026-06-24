// SplatLevelProvider (M7): build a Gaussian-splat room from one uploaded image. It calls our own
// /api proxies (which hold the fal.ai key) to (1) hallucinate the full room as a 360 panorama and
// (2) estimate its depth, then hands those two image URLs back in the LevelDefinition. The actual
// lift (panorama+depth -> 3D points) happens in splatRoom during loadLevel — this file only does
// the network orchestration and returns the same LevelDefinition shape as every other provider.
import type { LevelDefinition } from './levels'
import { shrinkToCanvas, readPalette } from './imageLevel'
import { step } from './errors'

type Progress = (msg: string) => void

// POST a JSON body to one of our /api routes and return the parsed JSON. Three failure modes, each
// with its own clear message: the request never reaches the server, the server replies with an
// error (we surface the { error } our routes send), or the reply isn't JSON.
async function api<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`couldn't reach ${path} (network error — is the API running?)`, { cause: err })
  }
  if (!res.ok) {
    const raw = await res.text()
    let detail = raw
    try { detail = JSON.parse(raw).error ?? raw } catch { /* not JSON — keep the raw text */ }
    throw new Error(`${path} failed (${res.status}): ${detail || res.statusText}`)
  }
  try {
    return (await res.json()) as T
  } catch (err) {
    throw new Error(`${path} returned a response that wasn't JSON`, { cause: err })
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Run one fal job through the queue proxy: submit it, poll status until it finishes (reporting queue
// position / progress as we go), then fetch the result. Each call is short, so nothing times out.
// `kind` ('pano' | 'depth') tells the server which model to use. Returns the model's output object.
const POLL_MS = 2000
const MAX_POLLS = 180 // ~6 minutes — well past any real fal job; a backstop against polling forever

async function falJob<T>(kind: 'pano' | 'depth', input: unknown, onProgress: Progress, label: string): Promise<T> {
  const { requestId } = await api<{ requestId: string }>('/api/fal', { action: 'submit', kind, input })
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS)
    const s = await api<{ status: string; queuePosition: number | null }>('/api/fal', { action: 'status', kind, requestId })
    if (s.status === 'COMPLETED') {
      const { data } = await api<{ data: T }>('/api/fal', { action: 'result', kind, requestId })
      return data
    }
    if (s.status === 'IN_QUEUE') {
      onProgress(`${label} — in queue${s.queuePosition != null ? ` (position ${s.queuePosition})` : ''}…`)
    } else {
      onProgress(`${label}…`) // IN_PROGRESS (or any other in-flight state)
    }
  }
  throw new Error(`${label}: timed out after ${Math.round((MAX_POLLS * POLL_MS) / 1000)}s waiting for fal.`)
}

export async function imageToSplatLevel(file: File, onProgress: Progress): Promise<LevelDefinition> {
  onProgress('Reading image…')
  const { imageUrl, palette } = await step('Reading the image', async () => {
    const canvas = await shrinkToCanvas(file, 1024) // a bit bigger than M6: better panorama input
    return {
      imageUrl: canvas.toDataURL('image/jpeg', 0.9), // sent to the proxy; fal accepts data URIs
      palette: readPalette(canvas),                  // paint-toolbar colors only (no obstacles here)
    }
  })

  const pano = await step('Generating the 360° panorama', () =>
    falJob<{ image?: { url?: string } }>(
      'pano',
      { image_url: imageUrl, prompt: 'interior room, same style and lighting, full 360 view' },
      onProgress, 'Hallucinating the room (360°)',
    ))
  const panoUrl = pano?.image?.url
  if (!panoUrl) throw new Error('Generating the 360° panorama: the service returned no image.')

  const depth = await step('Estimating depth', () =>
    falJob<{ image?: { url?: string } }>('depth', { image_url: panoUrl }, onProgress, 'Estimating depth'))
  const depthUrl = depth?.image?.url
  if (!depthUrl) throw new Error('Estimating depth: the service returned no image.')

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
