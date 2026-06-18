// All the DOM event wiring: keyboard, mouse-look (pointer lock), wheel zoom, fullscreen, the
// Tab/Esc pause dance, and the hide-phase key flow (Q paint toggle, 1-4 tools, Y/N finish-hiding).
// Importing this module installs the listeners.
import { canvas } from './engine'
import { chameleon } from './chameleon'
import { game, look, settings, keys, BASE_SENSITIVITY, PITCH_MIN, PITCH_MAX } from './state'
import { enterPaintMode, exitPaintMode, selectTool, TOOL_KEYS } from './painting'
import { startSeek, pause, resume, isSettingsOpen, showConfirm } from './ui'

// ----- Which keys are held -----
window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true
  if (e.key === ' ') e.preventDefault() // stop the spacebar from scrolling the page
})
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false })

// ----- F toggles fullscreen -----
// Toggling fullscreen briefly drops pointer lock; we note the time so the pause logic knows that
// unlock came from fullscreen, not from the player pausing.
let lastFullscreenToggle = 0
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'f') return
  lastFullscreenToggle = performance.now()
  if (!document.fullscreenElement) document.documentElement.requestFullscreen()
  else document.exitFullscreen()
})

// ----- Mouse look (pointer lock) -----
// Click the game to capture the mouse; then moving it orbits the camera, and holding the RIGHT
// button turns the chameleon (hide phase only). Esc releases the mouse.
let rotatingModel = false
canvas.addEventListener('click', () => {
  if (game.paintMode) return // in paint mode we keep the cursor free for the toolbar + aiming
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock()
})
canvas.addEventListener('contextmenu', (e) => e.preventDefault()) // free up the right button
window.addEventListener('mousedown', (e) => { if (e.button === 2) rotatingModel = true })
window.addEventListener('mouseup', (e) => { if (e.button === 2) rotatingModel = false })
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return // only when the mouse is captured
  const s = BASE_SENSITIVITY * settings.sensitivity
  if (rotatingModel && game.state === 'hiding') {
    chameleon.rotation.y -= e.movementX * s // turn the model left/right (hide phase only)
  } else {
    look.yaw -= e.movementX * s               // orbit the camera
    look.pitch -= e.movementY * s
    look.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, look.pitch))
  }
})

// ----- Mouse wheel zooms (how far the camera orbits out) -----
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5, ZOOM_SPEED = 0.0015
window.addEventListener('wheel', (e) => {
  look.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, look.zoom + e.deltaY * ZOOM_SPEED))
}, { passive: true })

// ----- Tab pauses/resumes WITHOUT leaving fullscreen (Esc does, so Tab is the real pause key) -----
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return
  if (game.state !== 'hiding' && game.state !== 'seeking') return // only during play
  if (game.paintMode) return                                     // painting is its own calm sub-mode
  if (isSettingsOpen()) return                                   // ignore while Settings is open
  e.preventDefault() // stop Tab from moving keyboard focus
  if (game.paused) { resume(); canvas.requestPointerLock() } // resume and re-capture the mouse
  else { pause(); document.exitPointerLock() }              // free the cursor but stay in fullscreen
})
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) { resume(); return } // captured -> playing
  if (game.paintMode) return                                      // entering paint mode frees the cursor on purpose
  // A fullscreen toggle also drops the lock — that should NOT pause the game.
  if (performance.now() - lastFullscreenToggle < 1000) return
  pause()                                                          // genuine release (Esc / tab away) -> pause
})
// After a fullscreen change the lock is gone; if we're still playing, grab it back.
document.addEventListener('fullscreenchange', () => {
  if ((game.state === 'hiding' || game.state === 'seeking') && !game.paused && !game.paintMode &&
      document.pointerLockElement !== canvas) {
    canvas.requestPointerLock()
  }
})

// ----- Hide-phase key flow: Q paint toggle, 1-4 tools, Y/N finish-hiding -----
window.addEventListener('keydown', (e) => {
  if (game.paused) return // ignore while the pause menu is open
  const k = e.key.toLowerCase()
  if (game.state === 'hiding') {
    // Q toggles paint mode; while painting, 1-4 pick tools and Y/N hide-confirm is off
    if (k === 'q' && !game.confirmingHide) {
      game.paintMode = !game.paintMode
      if (game.paintMode) enterPaintMode()
      else exitPaintMode()
      return
    }
    if (game.paintMode) {
      if (TOOL_KEYS[k]) selectTool(TOOL_KEYS[k])
      return
    }
    if (k === 'y') {
      if (!game.confirmingHide) {
        game.confirmingHide = true
        showConfirm(true)
      } else {
        showConfirm(false)
        startSeek()
      }
    } else if (k === 'n' && game.confirmingHide) {
      game.confirmingHide = false
      showConfirm(false)
    }
  }
})
