'use client';
import { Text, Billboard } from '@react-three/drei';
import { useMemo } from 'react';
import type { BubbleTier } from '../types';

/**
 * Proper speech-bubble look for in-scene chat — white rounded backing with
 * dark text (readable even over bright monitors and wall colors).
 *
 * Rendered inside a Billboard so the whole bubble faces the camera. Size
 * is adaptive to the text length — we estimate width from character count
 * × glyph width ratio, then cap at a maximum to force line-wrapping.
 *
 * Per-tier accent: left stripe colored by tier (thought=slate,
 * action=plan-color, milestone=gold, blocker=red). This lets users
 * triage at a glance without reading the full text.
 */
export function SpeechBubble({
  text,
  emoji,
  tier,
  planColor,
  offsetY,
}: {
  text: string;
  emoji: string;
  tier: BubbleTier;
  planColor?: string;
  offsetY: number;
}) {
  const content = emoji ? `${emoji}  ${text}` : text;
  const fontSize = tier === 'milestone' || tier === 'blocker' ? 0.18 : 0.16;

  // Approximate width: glyph is ~0.55 * fontSize wide. Cap so long text
  // wraps instead of ballooning. Height grows if wrapping is expected.
  const { w, h, maxWidth } = useMemo(() => {
    const glyphW = fontSize * 0.55;
    const pad = 0.35;
    const ideal = content.length * glyphW + pad;
    const MAX_W = 4.2;
    if (ideal <= MAX_W) {
      return {
        w: Math.max(1.2, ideal),
        h: fontSize * 2.6,
        maxWidth: MAX_W,
      };
    }
    // Two-line estimate — text wrap kicks in.
    return {
      w: MAX_W,
      h: fontSize * 4.4,
      maxWidth: MAX_W - 0.3,
    };
  }, [content, fontSize]);

  const stripeColor =
    tier === 'blocker'
      ? '#dc2626'
      : tier === 'milestone'
        ? '#f59e0b'
        : tier === 'action'
          ? (planColor ?? '#64748b')
          : '#94a3b8';

  return (
    <Billboard position={[0, offsetY, 0]} follow lockX={false} lockY={false} lockZ={false}>
      {/* Drop shadow */}
      <mesh position={[0.02, -0.02, -0.003]} renderOrder={10}>
        <planeGeometry args={[w + 0.04, h + 0.04]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.2} toneMapped={false} depthWrite={false} />
      </mesh>
      {/* White bubble body */}
      <mesh position={[0, 0, -0.002]} renderOrder={11}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} depthWrite={false} />
      </mesh>
      {/* Left accent stripe (tier color) */}
      <mesh position={[-w / 2 + 0.04, 0, -0.001]} renderOrder={12}>
        <planeGeometry args={[0.08, h - 0.04]} />
        <meshBasicMaterial color={stripeColor} toneMapped={false} depthWrite={false} />
      </mesh>
      {/* Bubble text — drei Text with no outline (background gives contrast). */}
      <Text
        position={[0.04, 0, 0]}
        fontSize={fontSize}
        color="#1e293b"
        anchorX="center"
        anchorY="middle"
        maxWidth={maxWidth}
        material-depthTest={false}
        renderOrder={13}
      >
        {content}
      </Text>
    </Billboard>
  );
}
