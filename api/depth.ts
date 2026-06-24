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

fal.config({ credentials: process.env.FAL_KEY })

const DEPTH_MODEL = process.env.FAL_DEPTH_MODEL || 'fal-ai/image-preprocessors/depth-anything/v2'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('POST only')
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
    const panoUrl = body.panoUrl as string | undefined
    if (!panoUrl) return res.status(400).json({ error: 'panoUrl required' })

    const result: any = await fal.subscribe(DEPTH_MODEL, { input: { image_url: panoUrl } })
    const depthUrl = result?.data?.image?.url
    if (!depthUrl) return res.status(502).json({ error: 'no depth map in response', raw: result })
    return res.json({ depthUrl })
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
