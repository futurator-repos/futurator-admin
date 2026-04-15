import * as THREE from 'three';
import type { Pose } from './office-constants';

export interface WorkerMesh extends THREE.Group {
  _lA: THREE.Group;
  _rA: THREE.Group;
  _lL: THREE.Group;
  _rL: THREE.Group;
  _lS: THREE.Mesh;
  _rS: THREE.Mesh;
  _body: THREE.Mesh;
  _shoulder: THREE.Mesh;
  _head: THREE.Mesh;
}

export function createWorkerMesh(bodyColor: number, headColor: number): WorkerMesh {
  const g = new THREE.Group() as WorkerMesh;
  const bMat = new THREE.MeshLambertMaterial({ color: bodyColor });

  // Body
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.4, 8), bMat);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);

  // Shoulder
  const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), bMat);
  shoulder.position.y = 0.75;
  shoulder.scale.set(1, 0.5, 0.8);
  shoulder.castShadow = true;
  g.add(shoulder);

  // Head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 8),
    new THREE.MeshLambertMaterial({ color: headColor }),
  );
  head.position.y = 0.92;
  head.castShadow = true;
  g.add(head);

  // Hair
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.145, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(bodyColor).multiplyScalar(0.4) }),
  );
  hair.position.y = 0.95;
  g.add(hair);

  // Arms
  const armGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.28, 6);
  const lA = new THREE.Group();
  lA.add(new THREE.Mesh(armGeo, new THREE.MeshLambertMaterial({ color: bodyColor })));
  lA.position.set(-0.22, 0.58, 0);
  g.add(lA);
  const rA = new THREE.Group();
  rA.add(new THREE.Mesh(armGeo.clone(), new THREE.MeshLambertMaterial({ color: bodyColor })));
  rA.position.set(0.22, 0.58, 0);
  g.add(rA);

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.25, 6);
  const legMat = new THREE.MeshLambertMaterial({ color: 0x3a3a5a });
  const lL = new THREE.Group();
  lL.add(new THREE.Mesh(legGeo, legMat));
  lL.position.set(-0.08, 0.22, 0);
  g.add(lL);
  const rL = new THREE.Group();
  rL.add(new THREE.Mesh(legGeo.clone(), legMat.clone()));
  rL.position.set(0.08, 0.22, 0);
  g.add(rL);

  // Shoes
  const shoeGeo = new THREE.BoxGeometry(0.1, 0.05, 0.15);
  const shoeMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
  const lS = new THREE.Mesh(shoeGeo, shoeMat);
  lS.position.set(-0.08, 0.05, 0.02);
  g.add(lS);
  const rS = new THREE.Mesh(shoeGeo.clone(), shoeMat.clone());
  rS.position.set(0.08, 0.05, 0.02);
  g.add(rS);

  // Shadow circle
  const sh = new THREE.Mesh(
    new THREE.CircleGeometry(0.2, 8),
    new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.15 }),
  );
  sh.rotation.x = -Math.PI / 2;
  sh.position.y = 0.01;
  g.add(sh);

  g._lA = lA;
  g._rA = rA;
  g._lL = lL;
  g._rL = rL;
  g._lS = lS;
  g._rS = rS;
  g._body = body;
  g._shoulder = shoulder;
  g._head = head;

  return g;
}

export function applyPose(m: WorkerMesh, p: Pose): void {
  m._body.position.y = p.bodyY;
  m._shoulder.position.y = p.bodyY + 0.2;
  m._lL.rotation.x = p.legRot;
  m._rL.rotation.x = p.legRot;
  m._lA.rotation.x = p.armRot;
  m._rA.rotation.x = p.armRot;
  m._lA.rotation.z = -p.armZ;
  m._rA.rotation.z = p.armZ;
  m._lL.position.y = p.legY;
  m._rL.position.y = p.legY;
  m._lS.position.y = p.shoeY;
  m._rS.position.y = p.shoeY;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(t, 1);
}
