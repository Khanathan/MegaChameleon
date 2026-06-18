// Entry point: wires the modules together, runs the game loop, and kicks off the first level.
// The actual work lives in focused modules (engine, state, levels, chameleon, seeker, painting,
// controls, input, ui); this file just orchestrates per-frame what runs in which phase.
import './style.css'
import { renderer, scene, camera, clock } from './engine'
import { game } from './state'
import { updateHidePhase, updateSeekPhase } from './controls'
import { updateSeeker, tickDetection, updateCaught, caught } from './seeker'
import { setState, finishSeek, selectMap, updateHud, SEEK_TIME, SEEK_GRACE } from './ui'
import './input' // side-effect: install the input event handlers

function frame() {
  const delta = clock.getDelta() // seconds since the last frame

  // run the simulation only while playing and not paused; otherwise freeze and just draw
  const playing = game.state === 'hiding' || game.state === 'seeking'
  if (!playing || game.paused) {
    renderer.render(scene, camera)
    requestAnimationFrame(frame)
    return
  }

  // count the seek timer down; surviving to 0 = win. Frozen once caught — the catch cutscene
  // ends the round with a loss instead.
  if (game.state === 'seeking' && !caught) {
    game.seekTimeLeft -= delta
    if (game.seekTimeLeft <= 0) finishSeek('win')
  }

  if (game.state === 'seeking') {
    // the chameleon is fixed; fly the camera around freely to watch the seeker
    if (caught) {
      if (updateCaught(delta)) finishSeek('lose') // stare-down finished -> result screen
    } else {
      updateSeeker(delta) // roam + peer (it "pretends to seek" during the grace)
      // head start: real detection only starts after the grace, then runs ~10x/sec
      if (SEEK_TIME - game.seekTimeLeft >= SEEK_GRACE) tickDetection(delta)
    }
    updateSeekPhase(delta)
  } else {
    updateHidePhase(delta) // move/paint the chameleon + orbit the camera
  }

  updateHud(delta)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

setState('menu')     // open on the main menu
selectMap('pink')    // load the starting room (also the menu backdrop)
frame()              // start the loop
