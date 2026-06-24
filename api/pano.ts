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
  try {
    // the Node runtime parses a JSON body into req.body; tolerate a raw string just in case.
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
    const imageUrl = body.imageUrl as string | undefined
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' })

    const result: any = await fal.subscribe('fal-ai/hunyuan_world', {
      input: { image_url: imageUrl, prompt: 'interior room, same style and lighting, full 360 view' },
    })
    // Verified against fal.ai/models/fal-ai/hunyuan_world: output is a single `image` object, so
    // through the fal client wrapper the panorama URL is result.data.image.url (a 1920x960 PNG).
    const panoUrl = result?.data?.image?.url
    if (!panoUrl) return res.status(502).json({ error: 'no panorama in response', raw: result })
    return res.json({ panoUrl })
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
