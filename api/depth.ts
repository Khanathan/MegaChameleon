// Vercel function (NOT part of the Vite/tsc build). Estimates a depth map for the panorama, which
// the browser then unprojects into the splat's 3D points (the DIY lift in src/splatRoom.ts).
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
import { fal } from '@fal-ai/client'

fal.config({ credentials: process.env.FAL_KEY })

const DEPTH_MODEL = process.env.FAL_DEPTH_MODEL || 'fal-ai/image-preprocessors/depth-anything/v2'

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  try {
    const { panoUrl } = (await req.json()) as { panoUrl?: string }
    if (!panoUrl) return Response.json({ error: 'panoUrl required' }, { status: 400 })

    const result: any = await fal.subscribe(DEPTH_MODEL, { input: { image_url: panoUrl } })
    const depthUrl = result?.data?.image?.url
    if (!depthUrl) return Response.json({ error: 'no depth map in response', raw: result }, { status: 502 })
    return Response.json({ depthUrl })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
