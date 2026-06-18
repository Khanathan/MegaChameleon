// Three.js essentials shared by everything: the renderer, scene, camera, lights, and clock.
import * as THREE from 'three'

// ----- Renderer: draws the 3D picture onto the screen -----
export const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // cap pixels drawn (speed)
renderer.toneMapping = THREE.ACESFilmicToneMapping           // filmic look, gentle highlight rolloff
renderer.toneMappingExposure = 1.0
document.body.appendChild(renderer.domElement)
export const canvas = renderer.domElement

// ----- Scene: the list of everything in the world -----
export const scene = new THREE.Scene()
scene.background = new THREE.Color(0x202028)

// ----- Camera (its position is set every frame by the camera code) -----
export const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  200 // room is small; a near far-plane keeps the depth buffer precise
)

// ----- Lights -----
// Simple, soft "middleground": a hemisphere fill + a little ambient + one low directional light
// (no shadows). Surfaces vary slightly by which way they face, so a painted color matches a wall
// closely but not exactly. The seeker's litColor() mirrors these values to judge "stands out".
scene.add(new THREE.HemisphereLight(0xfff3f6, 0x6a5054, 0.7)) // soft sky-pink / warm-ground fill
scene.add(new THREE.AmbientLight(0xffffff, 0.2))              // base fill
const sun = new THREE.DirectionalLight(0xffffff, 0.45)        // gentle form, no shadows
sun.position.set(12, 30, 18)
scene.add(sun)

export const clock = new THREE.Clock()

// keep everything sized to the window
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})
