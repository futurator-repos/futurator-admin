import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * Reusable GLTF loader prop. Clones the underlying scene so multiple
 * instances don't share transforms, and turns on shadows on every mesh.
 */
export function Prop({
  url,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale,
}: {
  url: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
}) {
  const { scene } = useGLTF(url) as unknown as { scene: THREE.Group };
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return c;
  }, [scene]);
  return <primitive object={cloned} position={position} rotation={rotation} scale={scale} />;
}
