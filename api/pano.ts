// Vercel function (NOT part of the Vite/tsc build — tsconfig includes only `src`). Holds the fal.ai
// key server-side and turns one image into a full 360° panorama (Hunyuan World). The browser only
// ever calls /api/pano, never fal directly, so the key never reaches the client.
//
// This is a Vite project, so the function runs on Vercel's Node runtime: the handler is called as
// (req, res) and MUST end by sending through `res` — returning a Response (the web/edge style) just
// hangs the request. Setup: `vercel env add FAL_KEY` (FAL_KEY is fal.ai's standard variable name).
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fal } from '@fal-ai/client'

fal.config({ credentials: process.env.FAL_KEY })

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('POST only')
  if (!process.env.FAL_KEY) {
    return res.status(500).json({ error: 'Server is missing the FAL_KEY environment variable.' })
  }

  // the Node runtime parses a JSON body into req.body; tolerate a raw string just in case.
  let imageUrl: string | undefined
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
    imageUrl = body.imageUrl
  } catch {
    return res.status(400).json({ error: 'Request body is not valid JSON.' })
  }
  if (!imageUrl) return res.status(400).json({ error: 'Missing "imageUrl" in the request body.' })

  // The actual fal call — its own failure (bad key, unknown model, fal outage, timeout) is the most
  // likely thing to break, so label it clearly and pass fal's own detail through when present.
  let result: any
  try {
    result = await fal.subscribe('fal-ai/hunyuan_world', {
      input: { image_url: imageUrl, prompt: 'interior room, same style and lighting, full 360 view' },
    })
  } catch (err) {
    return res.status(502).json({ error: `Panorama generation (fal Hunyuan World) failed: ${falError(err)}` })
  }

  // Verified against fal.ai/models/fal-ai/hunyuan_world: output is a single `image` object, so
  // through the fal client wrapper the panorama URL is result.data.image.url (a 1920x960 PNG).
  const panoUrl = result?.data?.image?.url
  if (!panoUrl) {
    return res.status(502).json({ error: 'Panorama service returned no image URL.', raw: result })
  }
  return res.json({ panoUrl })
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
