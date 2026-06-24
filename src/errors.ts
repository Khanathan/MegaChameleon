// One place for turning low-level failures into clear, human-readable messages — so when the splat
// pipeline breaks, the message says exactly which step failed and why, instead of a cryptic stack.
//
// `errText` pulls a readable string out of anything thrown. `step` runs one stage and, if it throws,
// re-labels the error with that stage's name ("Generating the panorama: <reason>") while keeping the
// original as `cause` for the console. Wrap each API call and generation stage with it.

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new Error(`${label}: ${errText(err)}`, { cause: err })
  }
}
