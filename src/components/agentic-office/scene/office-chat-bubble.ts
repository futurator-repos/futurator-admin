import * as THREE from 'three';

/**
 * Creates a chat bubble sprite rendered via canvas texture.
 * Supports emoji prefix and wider text for human-readable messages.
 */
export function createChatBubble(
  text: string,
  bodyColor: number,
  isMilestone = false,
): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  c.width = 512;
  c.height = 128;

  ctx.font = 'bold 20px sans-serif';
  const tw = Math.min(ctx.measureText(text).width + 36, 480);
  const bw = Math.max(tw, 80);
  const bh = 52;
  const bxx = (512 - bw) / 2;
  const by = 8;
  const r = 14;

  // Background
  const bgColor = isMilestone ? '#2a2a4a' : '#ffffff';
  const borderColor = '#' + bodyColor.toString(16).padStart(6, '0');
  const textColor = isMilestone ? '#ffffff' : '#222222';

  ctx.fillStyle = bgColor;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = isMilestone ? 4 : 3;

  // Rounded rect with speech pointer
  ctx.beginPath();
  ctx.moveTo(bxx + r, by);
  ctx.lineTo(bxx + bw - r, by);
  ctx.quadraticCurveTo(bxx + bw, by, bxx + bw, by + r);
  ctx.lineTo(bxx + bw, by + bh - r);
  ctx.quadraticCurveTo(bxx + bw, by + bh, bxx + bw - r, by + bh);
  ctx.lineTo(256 + 10, by + bh);
  ctx.lineTo(256, by + bh + 16);
  ctx.lineTo(256 - 10, by + bh);
  ctx.lineTo(bxx + r, by + bh);
  ctx.quadraticCurveTo(bxx, by + bh, bxx, by + bh - r);
  ctx.lineTo(bxx, by + r);
  ctx.quadraticCurveTo(bxx, by, bxx + r, by);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = textColor;
  ctx.font = isMilestone ? 'bold 20px sans-serif' : 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, by + bh / 2 + 1, 460);

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    depthTest: false,
  });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.6, 1);
  sp.position.set(0, 1.5, 0);
  sp.renderOrder = 999;
  return sp;
}

/**
 * Bubble animation state — managed per-worker in the scene loop.
 */
export interface BubbleState {
  sprite: THREE.Sprite;
  phase: 'fade_in' | 'show' | 'fade_out';
  elapsed: number;
  isMilestone: boolean;
}

const FADE_IN_DURATION = 0.25;
const SHOW_DURATION_NORMAL = 3.5;
const SHOW_DURATION_MILESTONE = 5.0;
const FADE_OUT_DURATION = 0.33;

export function updateBubble(state: BubbleState, dt: number, time: number): boolean {
  state.elapsed += dt;
  const mat = state.sprite.material;
  const showDuration = state.isMilestone ? SHOW_DURATION_MILESTONE : SHOW_DURATION_NORMAL;

  if (state.phase === 'fade_in') {
    const t = Math.min(state.elapsed / FADE_IN_DURATION, 1);
    mat.opacity = t;
    const sc = 0.5 + t * 0.5;
    state.sprite.scale.set(sc * 2.4, sc * 0.6, 1);
    if (t >= 1) {
      state.phase = 'show';
      state.elapsed = 0;
    }
  } else if (state.phase === 'show') {
    state.sprite.position.y = 1.5 + Math.sin(time * 2) * 0.02;
    if (state.elapsed > showDuration) {
      state.phase = 'fade_out';
      state.elapsed = 0;
    }
  } else if (state.phase === 'fade_out') {
    mat.opacity = Math.max(1 - state.elapsed / FADE_OUT_DURATION, 0);
    state.sprite.position.y = 1.5 + state.elapsed * 0.15;
    if (mat.opacity <= 0) return true; // done, remove
  }
  return false;
}
