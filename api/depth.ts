// Vercel function (NOT part of the Vite/tsc build). Estimates a depth map for the panorama, which
// the browser then unprojects into the splat's 3D points (the DIY lift in src/splatRoom.ts).
//
// Runs on Vercel's Node runtime (Vite project), so the handler sends through `res`, not a Response.
//
// Model choice: fal has no 360-aware depth model, so we use a general monocular one — fine here
// because depth only shapes the room's geometry, not the colors the player matches (those come
// from the panorama). Default is Depth Anything v2 (fast, modern). Two drop-in alternatives, both
// the same input/output shape, set via the FAL_DEPTH_MODEL env var:
//   - fal-ai/imageutils/marigold-depth  (finer detail, but slow — diffusion based)
//   - fal-ai/imageutils/depth           (Midas; older/lower quality)
// All three take `image_url` and return the depth map at result.data.image.url (verified on fal.ai).
// Caveat for the playtest: depth models disagree on brightness convention (near-bright vs far-bright).
// The lift in splatRoom treats brighter = farther; if the room comes out inside-out, invert there.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fal } from '@fal-ai/client'

// Read env via globalThis (typed by the standard lib) instead of the bare `process` global, which
// needs Node types — Vercel type-checks /api against the browser tsconfig, so `process` isn't in
// scope there. globalThis.process exists at runtime on Node.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

fal.config({ credentials: env.FAL_KEY })

const DEPTH_MODEL = env.FAL_DEPTH_MODEL || 'fal-ai/image-preprocessors/depth-anything/v2'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('POST only')
  if (!env.FAL_KEY) {
    return res.status(500).json({ error: 'Server is missing the FAL_KEY environment variable.' })
  }

  let panoUrl: string | undefined
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
    panoUrl = body.panoUrl
  } catch {
    return res.status(400).json({ error: 'Request body is not valid JSON.' })
  }
  if (!panoUrl) return res.status(400).json({ error: 'Missing "panoUrl" in the request body.' })

  let result: any
  try {
    result = await fal.subscribe(DEPTH_MODEL, { input: { image_url: panoUrl } })
  } catch (err) {
    return res.status(502).json({ error: `Depth estimation (${DEPTH_MODEL}) failed: ${falError(err)}` })
  }
  const depthUrl = result?.data?.image?.url
  if (!depthUrl) {
    return res.status(502).json({ error: 'Depth service returned no image URL.', raw: result })
  }
  return res.json({ depthUrl })
}

// Pull a readable message out of a fal client error: prefer the API's own validation detail, then
// the error message, then a stringified fallback.
function falError(err: unknown): string {
  const e = err as any
  const detail = e?.body?.detail ?? e?.body?.message
  if (detail) return typeof detail === 'string' ? detail : JSON.stringify(detail)
  if (e?.message) return String(e.message)
  return String(err)
}
