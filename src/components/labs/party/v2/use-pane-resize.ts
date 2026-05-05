'use client';
import { useEffect, useRef, useState } from 'react';
import { PANE_DEFAULTS, PANE_SIZES_KEY } from './tokens';

interface PaneSizes {
  left: number;
  right: number;
}

function loadSizes(): PaneSizes {
  if (typeof window === 'undefined') {
    return { left: PANE_DEFAULTS.left, right: PANE_DEFAULTS.right };
  }
  try {
    const raw = window.localStorage.getItem(PANE_SIZES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PaneSizes>;
      return {
        left: clamp(
          parsed.left ?? PANE_DEFAULTS.left,
          PANE_DEFAULTS.leftMin,
          PANE_DEFAULTS.leftMax,
        ),
        right: clamp(
          parsed.right ?? PANE_DEFAULTS.right,
          PANE_DEFAULTS.rightMin,
          PANE_DEFAULTS.rightMax,
        ),
      };
    }
  } catch {
    /* fall through */
  }
  return { left: PANE_DEFAULTS.left, right: PANE_DEFAULTS.right };
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Pane-resize state for the V2 three-column layout.
 *
 * - Persists to localStorage under `partyMode.paneSizes`
 * - Returns `dragLeft`/`dragRight` callbacks that components attach to drag
 *   handles. Each callback installs window-level mousemove/mouseup listeners
 *   for the duration of the drag.
 */
export function usePaneResize() {
  const [sizes, setSizes] = useState<PaneSizes>(() => loadSizes());
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  const startRef = useRef<{ x: number; sizes: PaneSizes } | null>(null);

  // Persist on every change. Cheap — JSON of two numbers.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(sizes));
    } catch {
      /* quota errors etc — best effort */
    }
  }, [sizes]);

  // Mouse move / up handlers — installed only while dragging.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const start = startRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      if (dragging === 'left') {
        const next = clamp(
          start.sizes.left + dx,
          PANE_DEFAULTS.leftMin,
          PANE_DEFAULTS.leftMax,
        );
        setSizes((s) => ({ ...s, left: next }));
      } else {
        // right pane resize handle is on its LEFT edge → drag-right shrinks the pane
        const next = clamp(
          start.sizes.right - dx,
          PANE_DEFAULTS.rightMin,
          PANE_DEFAULTS.rightMax,
        );
        setSizes((s) => ({ ...s, right: next }));
      }
    }
    function onUp() {
      setDragging(null);
      startRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  function startDrag(which: 'left' | 'right') {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      startRef.current = { x: e.clientX, sizes };
      setDragging(which);
    };
  }

  return {
    leftWidth: sizes.left,
    rightWidth: sizes.right,
    dragging,
    startLeftDrag: startDrag('left'),
    startRightDrag: startDrag('right'),
  };
}
