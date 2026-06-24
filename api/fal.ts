// Vercel function (NOT part of the Vite/tsc build). One proxy for every fal call the splat pipeline
// makes, using fal's QUEUE API so no single request stays open for minutes. A panorama job takes
// 1–3 minutes — far longer than a serverless function (or Vercel's gateway) will hold a connection
// — so instead the browser drives it as many short calls:
//   1. action:'submit'  -> kicks off the job, returns a requestId instantly
//   2. action:'status'  -> the browser polls this every couple seconds (each call <1s)
//   3. action:'result'  -> fetches the finished output once status is COMPLETED
// The key stays server-side; the browser only ever talks to /api/fal.
//
// Runs on Vercel's Node runtime (Vite project), so the handler sends through `res`, not a Response.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fal } from '@fal-ai/client'

// Read env via globalThis (typed by the standard lib) instead of the bare `process` global, which
// needs Node types — Vercel type-checks /api against the browser tsconfig. process exists at runtime.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

fal.config({ credentials: env.FAL_KEY })

// The client asks for a job by KIND, not a raw model name, so model choice (and the FAL_DEPTH_MODEL
// override) stays server-side and our key can't be pointed at arbitrary models.
//   - pano:  fal-ai/hunyuan_world — hallucinates a full 360° panorama from one photo.
//   - depth: a general monocular depth model (fal has no 360-aware one). Default Depth Anything v2;
//            swap via FAL_DEPTH_MODEL. Alternatives: fal-ai/imageutils/marigold-depth (finer, slow),
//            fal-ai/imageutils/depth (Midas, older). The lift treats brighter = farther.
const MODELS: Record<string, string> = {
  pano: 'fal-ai/hunyuan_world',
  depth: env.FAL_DEPTH_MODEL || 'fal-ai/image-preprocessors/depth-anything/v2',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('POST only')
  if (!env.FAL_KEY) {
    return res.status(500).json({ error: 'Server is missing the FAL_KEY environment variable.' })
  }

  let body: any
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
  } catch {
    return res.status(400).json({ error: 'Request body is not valid JSON.' })
  }

  const { action, kind, input, requestId } = body
  const model = MODELS[kind]
  if (!model) return res.status(400).json({ error: `Unknown job kind: ${kind}` })

  try {
    if (action === 'submit') {
      const { request_id } = await fal.queue.submit(model, { input })
      return res.json({ requestId: request_id })
    }
    if (action === 'status') {
      if (!requestId) return res.status(400).json({ error: 'Missing requestId for status.' })
      const s: any = await fal.queue.status(model, { requestId, logs: false })
      return res.json({ status: s.status, queuePosition: s.queue_position ?? null })
    }
    if (action === 'result') {
      if (!requestId) return res.status(400).json({ error: 'Missing requestId for result.' })
      const r: any = await fal.queue.result(model, { requestId })
      return res.json({ data: r.data })
    }
    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    return res.status(502).json({ error: `fal ${action} (${kind}) failed: ${falError(err)}` })
  }
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
