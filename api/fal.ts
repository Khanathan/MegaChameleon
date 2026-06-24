// Vercel function (NOT part of the Vite/tsc build). One proxy for every fal call the splat pipeline
// makes, using fal's QUEUE API so no single request stays open for minutes. The browser drives each
// job as many short calls:
//   1. action:'submit'  -> kicks off the job, returns a requestId instantly
//   2. action:'status'  -> the browser polls this every few seconds (each call <1s)
//   3. action:'result'  -> fetches the finished output once status is COMPLETED
// The key stays server-side; the browser only ever talks to /api/fal and never picks a raw model
// name (it asks by KIND), so our key can't be pointed at arbitrary models.
//
// Runs on Vercel's Node runtime (Vite project), so the handler sends through `res`, not a Response.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fal } from '@fal-ai/client'

// Read env via globalThis (typed by the standard lib) instead of the bare `process` global, which
// needs Node types — Vercel type-checks /api against the browser tsconfig. process exists at runtime.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

fal.config({ credentials: env.FAL_KEY })

// Public Flux LoRA that paints images in equirectangular-360 style (2:1). We run it through Flux
// img2img so the panorama is conditioned on the uploaded room photo.
const FLUX_360_LORA =
  'https://huggingface.co/MultiTrickFox/Flux-LoRA-Equirectangular-v3/resolve/main/equirectangular_flux_lora_v3_000003072.safetensors'

// A job kind = which fal model to call, how to build its input from the client's payload, and where
// its output image URL lives (models disagree: Flux returns images[0], depth returns image).
type Job = {
  model: string
  buildInput: (p: { imageUrl?: string }) => Record<string, unknown>
  resultUrl: (data: any) => string | undefined
}

const JOBS: Record<string, Job> = {
  // Panorama from the uploaded photo. We use Flux img2img + the 360 LoRA because it runs on fal's
  // general (fast, uncongested) infra. Hunyuan World is higher quality and a true 360, but its
  // dedicated GPUs queue for minutes — see HUNYUAN_PANO_JOB below to switch back when that clears.
  pano: {
    model: 'fal-ai/flux-lora/image-to-image',
    buildInput: (p) => ({
      image_url: p.imageUrl,
      prompt: 'equirectangular 360 degree panorama, interior room, same colors and lighting',
      loras: [{ path: FLUX_360_LORA, scale: 1.1 }],
      strength: 0.85, // how far to push the photo toward a full panorama (tune in playtest)
      image_size: { width: 1408, height: 704 }, // 2:1 equirectangular (the LoRA's training ratio)
      num_inference_steps: 28,
      guidance_scale: 3,
    }),
    resultUrl: (d) => d?.images?.[0]?.url,
  },
  // Depth of the panorama -> the browser unprojects it into the splat's points (splatRoom lift). No
  // 360-aware depth model exists on fal; a general one is fine since depth only shapes geometry, not
  // the colors the player matches. Default Depth Anything v2; override via FAL_DEPTH_MODEL.
  depth: {
    model: env.FAL_DEPTH_MODEL || 'fal-ai/image-preprocessors/depth-anything/v2',
    buildInput: (p) => ({ image_url: p.imageUrl }),
    resultUrl: (d) => d?.image?.url,
  },
}

// Kept (unwired) so the panorama can switch back to Hunyuan World in one line when its queue frees
// up — just set `JOBS.pano = HUNYUAN_PANO_JOB` above. Output is a single `image` object. The `void`
// below marks it "used" so the build's noUnusedLocals check stays happy while it's not wired in.
const HUNYUAN_PANO_JOB: Job = {
  model: 'fal-ai/hunyuan_world',
  buildInput: (p) => ({ image_url: p.imageUrl, prompt: 'interior room, same style and lighting, full 360 view' }),
  resultUrl: (d) => d?.image?.url,
}
void HUNYUAN_PANO_JOB

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

  const { action, kind, requestId } = body
  const job = JOBS[kind]
  if (!job) return res.status(400).json({ error: `Unknown job kind: ${kind}` })

  try {
    if (action === 'submit') {
      const { request_id } = await fal.queue.submit(job.model, { input: job.buildInput(body) })
      return res.json({ requestId: request_id })
    }
    if (action === 'status') {
      if (!requestId) return res.status(400).json({ error: 'Missing requestId for status.' })
      const s: any = await fal.queue.status(job.model, { requestId, logs: false })
      return res.json({ status: s.status, queuePosition: s.queue_position ?? null })
    }
    if (action === 'result') {
      if (!requestId) return res.status(400).json({ error: 'Missing requestId for result.' })
      const r: any = await fal.queue.result(job.model, { requestId })
      const url = job.resultUrl(r.data)
      if (!url) return res.status(502).json({ error: `fal result (${kind}) had no image URL.`, raw: r.data })
      return res.json({ url })
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
