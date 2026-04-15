import * as THREE from 'three';
import type { KanbanStory } from '@/types/agentic-office';

// ── Monitor screen animations ──

type ScreenMode = 'off' | 'coding' | 'reviewing';

const CODE_COLORS = ['#5ab88a', '#4a90d9', '#d9a04a', '#8a5ad9', '#d94a6a', '#4ad9d9', '#aaaaaa'];
const REVIEW_COLORS = ['#d9a04a', '#d9a04a', '#5ab88a', '#d94a6a', '#aaaaaa', '#d9a04a'];

interface ScreenState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mode: ScreenMode;
  scrollOffset: number;
  lines: { width: number; color: string; indent: number }[];
}

function generateCodeLines(): ScreenState['lines'] {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const indent = Math.floor(Math.random() * 4);
    lines.push({
      width: 20 + Math.random() * 60,
      color: CODE_COLORS[Math.floor(Math.random() * CODE_COLORS.length)],
      indent,
    });
  }
  return lines;
}

function generateReviewLines(): ScreenState['lines'] {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const indent = Math.floor(Math.random() * 3);
    lines.push({
      width: 30 + Math.random() * 50,
      color: REVIEW_COLORS[Math.floor(Math.random() * REVIEW_COLORS.length)],
      indent,
    });
  }
  return lines;
}

export function createScreenState(): ScreenState {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return {
    canvas,
    ctx,
    texture,
    mode: 'off',
    scrollOffset: 0,
    lines: generateCodeLines(),
  };
}

export function setScreenMode(state: ScreenState, mode: ScreenMode): void {
  if (state.mode === mode) return;
  state.mode = mode;
  state.scrollOffset = 0;
  state.lines = mode === 'reviewing' ? generateReviewLines() : generateCodeLines();
}

export function updateScreen(state: ScreenState, dt: number): void {
  const { ctx, canvas, texture, mode } = state;

  if (mode === 'off') {
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
    return;
  }

  // Scrolling speed: coding is faster, review is slower
  const speed = mode === 'coding' ? 12 : 6;
  state.scrollOffset += dt * speed;

  // Dark background
  ctx.fillStyle = mode === 'coding' ? '#0d1117' : '#1a1520';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw scrolling lines
  const lineHeight = 5;
  const startLine = Math.floor(state.scrollOffset) % state.lines.length;

  for (let i = 0; i < 18; i++) {
    const lineIdx = (startLine + i) % state.lines.length;
    const line = state.lines[lineIdx];
    const y = i * lineHeight - (state.scrollOffset % 1) * lineHeight;

    // Line number gutter
    ctx.fillStyle = '#333';
    ctx.fillRect(2, y + 1, 8, 3);

    // Code/review content
    ctx.fillStyle = line.color;
    const x = 14 + line.indent * 6;
    const w = Math.min(line.width, canvas.width - x - 4);
    ctx.fillRect(x, y + 1, w, 3);

    // Review mode: occasional markers in the margin
    if (mode === 'reviewing' && i % 5 === 0) {
      ctx.fillStyle = i % 10 === 0 ? '#d94a6a' : '#5ab88a';
      ctx.fillRect(0, y, 2, lineHeight);
    }
  }

  // Cursor blink for coding mode
  if (mode === 'coding') {
    const cursorLine = 8;
    const blink = Math.sin(state.scrollOffset * 4) > 0;
    if (blink) {
      const cl = state.lines[(startLine + cursorLine) % state.lines.length];
      const cx = 14 + cl.indent * 6 + cl.width + 2;
      const cy = cursorLine * lineHeight - (state.scrollOffset % 1) * lineHeight;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx, cy, 1, 4);
    }
  }

  texture.needsUpdate = true;
}

// ── Whiteboard post-it rendering ──

const COLUMN_COLORS: Record<string, string> = {
  backlog: '#666666',
  in_progress: '#4a90d9',
  in_review: '#d9a04a',
  fixing: '#d94a6a',
  done: '#4ad996',
};

const EPIC_HUES = ['#4a90d9', '#d94a6a', '#5ab88a', '#d9a04a', '#8a5ad9'];

export interface WhiteboardState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  lastHash: string;
}

export function createWhiteboardState(): WhiteboardState {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Initial blank state
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  texture.needsUpdate = true;

  return { canvas, ctx, texture, lastHash: '' };
}

export function updateWhiteboard(
  state: WhiteboardState,
  stories: KanbanStory[],
  allEpicIds: string[],
): void {
  // Simple hash to avoid unnecessary redraws
  const hash = stories.map((s) => `${s.storyId}:${s.column}`).join(',');
  if (hash === state.lastHash) return;
  state.lastHash = hash;

  const { ctx, canvas, texture } = state;
  const W = canvas.width;
  const H = canvas.height;

  // Background
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, W, H);

  if (stories.length === 0) {
    ctx.fillStyle = '#ccc';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No stories', W / 2, H / 2);
    texture.needsUpdate = true;
    return;
  }

  // Column headers
  const columns = ['backlog', 'in_progress', 'in_review', 'fixing', 'done'] as const;
  const colW = W / columns.length;

  for (let c = 0; c < columns.length; c++) {
    const col = columns[c];
    const x = c * colW;

    // Column separator
    if (c > 0) {
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, H - 4);
      ctx.stroke();
    }

    // Header dot
    ctx.fillStyle = COLUMN_COLORS[col];
    ctx.beginPath();
    ctx.arc(x + 6, 10, 3, 0, Math.PI * 2);
    ctx.fill();

    // Post-its for this column
    const colStories = stories.filter((s) => s.column === col);
    for (let i = 0; i < Math.min(colStories.length, 8); i++) {
      const s = colStories[i];
      const epicIdx = allEpicIds.indexOf(s.epicId);
      const color = EPIC_HUES[epicIdx >= 0 ? epicIdx % EPIC_HUES.length : 0];

      const px = x + 3;
      const py = 20 + i * 17;
      const pw = colW - 6;
      const ph = 15;

      // Post-it shadow
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(px + 1, py + 1, pw, ph);

      // Post-it body
      ctx.fillStyle = color + '40'; // semi-transparent
      ctx.fillRect(px, py, pw, ph);

      // Left accent
      ctx.fillStyle = color;
      ctx.fillRect(px, py, 2, ph);

      // Failed indicator
      if (s.failed) {
        ctx.fillStyle = '#d94a6a';
        ctx.fillRect(px + pw - 4, py, 4, 3);
      }
    }

    // Overflow indicator
    if (colStories.length > 8) {
      ctx.fillStyle = '#999';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`+${colStories.length - 8}`, x + colW / 2, H - 6);
    }
  }

  texture.needsUpdate = true;
}
