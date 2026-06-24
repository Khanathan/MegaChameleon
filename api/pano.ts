// Vercel function (NOT part of the Vite/tsc build — tsconfig includes only `src`).
// Holds the fal.ai key server-side and turns one image into a full 360° panorama (Hunyuan World).
// The browser only ever calls /api/pano, never fal directly, so the key never reaches the client.
//
// Setup: `vercel env add FAL_KEY` (Production + Preview + Development), then run `vercel dev`
// locally so this route is served alongside Vite. FAL_KEY is fal.ai's standard variable name.
import { fal } from '@fal-ai/client'

fal.config({ credentials: process.env.FAL_KEY })

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  try {
    const { imageUrl } = (await req.json()) as { imageUrl?: string }
    if (!imageUrl) return Response.json({ error: 'imageUrl required' }, { status: 400 })

    const result: any = await fal.subscribe('fal-ai/hunyuan_world', {
      input: { image_url: imageUrl, prompt: 'interior room, same style and lighting, full 360 view' },
    })
    // Verified against fal.ai/models/fal-ai/hunyuan_world: output is a single `image` object, so
    // through the fal client wrapper the panorama URL is result.data.image.url (a 1920x960 PNG).
    const panoUrl = result?.data?.image?.url
    if (!panoUrl) return Response.json({ error: 'no panorama in response', raw: result }, { status: 502 })
    return Response.json({ panoUrl })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
