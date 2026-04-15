import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";

const COLORS = {
  floor: 0xe8e0d4, floorAlt: 0xddd5c8,
  wall: 0x8b9dad, wallTop: 0xa3b5c7,
  desk: 0xc4a882, deskLeg: 0x8a7460,
  monitor: 0x2a2a2a, monitorScreen: 0x4a90d9,
  chair: 0x4a4a4a, chairSeat: 0x5a7a9a,
  plant: 0x5a8a5a, plantPot: 0xb8845a,
  whiteboard: 0xf0f0f0, whiteboardFrame: 0x888888,
  meetingTable: 0x7a6a5a, kitchenCounter: 0xaaaaaa,
  coffeeMachine: 0x333333, rug: 0x6a5a7a, bookshelf: 0x9a7a5a,
  bg: 0x1a1a2e,
};

const WORKER_COLORS = [
  { body: 0x4a90d9, head: 0xf5d0a9, name: "Alice", role: "Engineer" },
  { body: 0xd94a6a, head: 0xe8c090, name: "Bob", role: "Designer" },
  { body: 0x5ab88a, head: 0xf0c8a0, name: "Carol", role: "PM" },
  { body: 0xd9a04a, head: 0xeac0a0, name: "Dave", role: "DevOps" },
  { body: 0x8a5ad9, head: 0xf2d0b0, name: "Eve", role: "QA" },
  { body: 0xd95a4a, head: 0xe0b890, name: "Frank", role: "CTO" },
];

// Seat offsets: where the character actually sits relative to the location origin
// Desks: chair is behind the desk (positive Z side), character faces the monitor (negative Z)
const DESK_SEAT = { dx: 0, dz: 0.55, faceY: Math.PI };
// Meeting: 6 chairs around table at radius 1.6
const MEETING_CENTER = { x: 6, z: 3 };
const MEETING_SEATS = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2;
  return { dx: Math.cos(a) * 1.5, dz: Math.sin(a) * 1.5, faceY: -a + Math.PI, taken: false };
});
// Lounge: couch positions (couch is at z=-0.6 relative to lounge group at 2,-5)
const LOUNGE_CENTER = { x: 2, z: -5 };
const LOUNGE_SEATS = [
  { dx: -0.55, dz: -0.5, faceY: 0, taken: false },
  { dx: 0, dz: -0.5, faceY: 0, taken: false },
  { dx: 0.55, dz: -0.5, faceY: 0, taken: false },
];

const LOCATIONS = {
  "desk-alice":  { x: -6, z: -4, label: "Alice's Desk",  type: "desk" },
  "desk-bob":    { x: -6, z: -1, label: "Bob's Desk",    type: "desk" },
  "desk-carol":  { x: -6, z: 2,  label: "Carol's Desk",  type: "desk" },
  "desk-dave":   { x: -2, z: -4, label: "Dave's Desk",   type: "desk" },
  "desk-eve":    { x: -2, z: -1, label: "Eve's Desk",    type: "desk" },
  "desk-frank":  { x: -2, z: 2,  label: "Frank's Desk",  type: "desk" },
  kitchen:       { x: 6,  z: -5, label: "Kitchen",       type: "stand" },
  meeting:       { x: 6,  z: 3,  label: "Meeting Room",  type: "meeting" },
  lounge:        { x: 2,  z: -5, label: "Lounge",        type: "lounge" },
  whiteboard:    { x: 6,  z: 0,  label: "Whiteboard",    type: "stand" },
  entrance:      { x: 0,  z: 7,  label: "Entrance",      type: "stand" },
  hallway:       { x: 0,  z: 0,  label: "Hallway",       type: "stand" },
};

// Get the world-space seat position + facing for a location
function getSeatPosition(locKey, workerIdx) {
  const loc = LOCATIONS[locKey];
  if (!loc) return { x: 0, z: 0, faceY: 0 };

  if (loc.type === "desk") {
    return {
      x: loc.x + DESK_SEAT.dx,
      z: loc.z + DESK_SEAT.dz,
      faceY: DESK_SEAT.faceY,
    };
  }
  if (loc.type === "meeting") {
    // Find a free seat or use one based on worker index
    let seat = MEETING_SEATS.find(s => !s.taken);
    if (!seat) seat = MEETING_SEATS[workerIdx % 6]; // fallback
    seat.taken = true;
    return {
      x: MEETING_CENTER.x + seat.dx,
      z: MEETING_CENTER.z + seat.dz,
      faceY: seat.faceY,
      seatRef: seat,
    };
  }
  if (loc.type === "lounge") {
    let seat = LOUNGE_SEATS.find(s => !s.taken);
    if (!seat) seat = LOUNGE_SEATS[workerIdx % 3];
    seat.taken = true;
    return {
      x: LOUNGE_CENTER.x + seat.dx,
      z: LOUNGE_CENTER.z + seat.dz,
      faceY: seat.faceY,
      seatRef: seat,
    };
  }
  // Stand locations: go near the location, face it
  return {
    x: loc.x + (Math.random() - 0.5) * 0.5,
    z: loc.z + 0.6,
    faceY: Math.PI,
  };
}

// Release a seat when leaving
function releaseSeat(locKey, seatRef) {
  if (seatRef) seatRef.taken = false;
  if (locKey === "meeting") return;
  if (locKey === "lounge") return;
}

const EVENTS = [
  { type: "move", worker: 0, to: "kitchen", reason: "Getting coffee" },
  { type: "chat", worker: 0, text: "Need caffeine" },
  { type: "move", worker: 1, to: "meeting", reason: "Design review" },
  { type: "move", worker: 2, to: "meeting", reason: "Sprint planning" },
  { type: "chat", worker: 1, text: "Love the new mockups!" },
  { type: "chat", worker: 2, text: "Let's ship this week" },
  { type: "move", worker: 3, to: "whiteboard", reason: "Architecture diagram" },
  { type: "move", worker: 4, to: "lounge", reason: "Quick break" },
  { type: "chat", worker: 3, text: "Microservices or monolith?" },
  { type: "move", worker: 5, to: "meeting", reason: "Team sync" },
  { type: "chat", worker: 5, text: "Q3 looks strong" },
  { type: "move", worker: 0, to: "desk-alice", reason: "Back to coding" },
  { type: "chat", worker: 4, text: "This couch is great" },
  { type: "move", worker: 1, to: "desk-bob", reason: "Updating mockups" },
  { type: "move", worker: 3, to: "kitchen", reason: "Refilling water" },
  { type: "chat", worker: 0, text: "PR #247 is ready!" },
  { type: "move", worker: 4, to: "desk-eve", reason: "Writing test cases" },
  { type: "move", worker: 2, to: "whiteboard", reason: "Roadmap review" },
  { type: "chat", worker: 2, text: "We need more tests" },
  { type: "move", worker: 5, to: "lounge", reason: "1:1 with Dave" },
  { type: "move", worker: 3, to: "lounge", reason: "1:1 with Frank" },
  { type: "chat", worker: 5, text: "Great progress team!" },
  { type: "chat", worker: 3, text: "Deploying to staging" },
  { type: "move", worker: 0, to: "meeting", reason: "Code review session" },
  { type: "move", worker: 1, to: "kitchen", reason: "Lunch break" },
  { type: "chat", worker: 1, text: "Anyone want tacos?" },
  { type: "move", worker: 4, to: "meeting", reason: "Bug triage" },
  { type: "chat", worker: 4, text: "Found 3 edge cases" },
  { type: "move", worker: 2, to: "desk-carol", reason: "Updating JIRA" },
  { type: "move", worker: 5, to: "desk-frank", reason: "Reviewing PRs" },
  { type: "move", worker: 0, to: "lounge", reason: "Afternoon stretch" },
  { type: "chat", worker: 0, text: "Merged!" },
  { type: "move", worker: 3, to: "desk-dave", reason: "Deploying hotfix" },
  { type: "move", worker: 1, to: "whiteboard", reason: "User flow mapping" },
  { type: "move", worker: 4, to: "kitchen", reason: "Snack run" },
  { type: "chat", worker: 3, text: "Hotfix is live" },
];

// ─── Poses ─────────────────────────────────────────────────────────
const POSE = {
  stand: { bodyY: 0.55, legRot: 0, armRot: 0, armZ: 0, legY: 0.22, shoeY: 0.05 },
  desk:  { bodyY: 0.44, legRot: -1.3, armRot: -0.5, armZ: 0, legY: 0.35, shoeY: 0.22 },
  meet:  { bodyY: 0.44, legRot: -1.3, armRot: -0.15, armZ: 0, legY: 0.35, shoeY: 0.22 },
  sofa:  { bodyY: 0.30, legRot: -0.6, armRot: 0.25, armZ: 0.35, legY: 0.22, shoeY: 0.10 },
};
function poseFor(key) {
  const t = LOCATIONS[key]?.type;
  if (t === "desk") return POSE.desk;
  if (t === "meeting") return POSE.meet;
  if (t === "lounge") return POSE.sofa;
  return POSE.stand;
}

// ─── Geometry ──────────────────────────────────────────────────────
function bx(w,h,d,c,x=0,y=0,z=0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshLambertMaterial({color:c}));
  m.position.set(x,y,z); m.castShadow=true; m.receiveShadow=true; return m;
}
function cy(rt,rb,h,c,x=0,y=0,z=0,s=8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,s), new THREE.MeshLambertMaterial({color:c}));
  m.position.set(x,y,z); m.castShadow=true; m.receiveShadow=true; return m;
}

function buildDesk(x, z) {
  const g = new THREE.Group(); g.position.set(x,0,z);
  g.add(bx(1.2,0.06,0.7,COLORS.desk,0,0.72,0));
  [-0.5,0.5].forEach(lx=>[-0.28,0.28].forEach(lz=>g.add(cy(0.03,0.03,0.7,COLORS.deskLeg,lx,0.35,lz))));
  g.add(bx(0.5,0.35,0.03,COLORS.monitor,0,1.1,-0.2));
  g.add(bx(0.44,0.28,0.01,COLORS.monitorScreen,0,1.12,-0.185));
  g.add(cy(0.02,0.02,0.18,COLORS.monitor,0,0.84,-0.2));
  g.add(cy(0.08,0.08,0.02,COLORS.monitor,0,0.75,-0.2));
  return g;
}
function buildChair(x,z) {
  const g = new THREE.Group(); g.position.set(x,0,z);
  g.add(bx(0.45,0.06,0.45,COLORS.chairSeat,0,0.45,0));
  g.add(bx(0.45,0.4,0.05,COLORS.chairSeat,0,0.7,-0.22));
  g.add(cy(0.03,0.03,0.4,COLORS.chair,0,0.24,0));
  g.add(cy(0.18,0.18,0.03,COLORS.chair,0,0.04,0));
  return g;
}
function buildPlant(x,z,sc=1) {
  const g = new THREE.Group(); g.position.set(x,0,z); g.scale.setScalar(sc);
  g.add(cy(0.15,0.12,0.25,COLORS.plantPot,0,0.125,0));
  const f=new THREE.Mesh(new THREE.SphereGeometry(0.22,8,6),new THREE.MeshLambertMaterial({color:COLORS.plant}));
  f.position.y=0.42;f.castShadow=true;g.add(f);return g;
}
function buildKitchen(x,z) {
  const g=new THREE.Group();g.position.set(x,0,z);
  g.add(bx(2.5,0.9,0.6,COLORS.kitchenCounter,0,0.45,-0.7));
  g.add(bx(2.6,0.04,0.7,0xcccccc,0,0.92,-0.7));
  g.add(bx(0.3,0.4,0.3,COLORS.coffeeMachine,-0.6,1.12,-0.7));
  g.add(bx(0.05,0.06,0.15,0xcc4444,-0.6,1.05,-0.48));
  g.add(bx(0.5,0.08,0.35,0x999999,0.4,0.94,-0.7));
  g.add(bx(0.7,1.7,0.6,0xdddddd,-1.5,0.85,-0.7));
  g.add(bx(0.68,0.02,0.02,0xaaaaaa,-1.5,1.1,-0.38));
  g.add(bx(0.68,0.02,0.02,0xaaaaaa,-1.5,0.5,-0.38));
  return g;
}
function buildMeetingTable(x,z) {
  const g=new THREE.Group();g.position.set(x,0,z);
  const t=new THREE.Mesh(new THREE.CylinderGeometry(1.1,1.1,0.06,16),new THREE.MeshLambertMaterial({color:COLORS.meetingTable}));
  t.position.y=0.72;t.castShadow=true;t.receiveShadow=true;g.add(t);
  g.add(cy(0.08,0.12,0.7,COLORS.deskLeg,0,0.35,0));
  for(let i=0;i<6;i++){const a=(i/6)*Math.PI*2;const ch=buildChair(Math.cos(a)*1.6,Math.sin(a)*1.6);ch.rotation.y=-a+Math.PI;ch.scale.setScalar(0.8);g.add(ch);}
  return g;
}
function buildWhiteboard(x,z) {
  const g=new THREE.Group();g.position.set(x,0,z);
  g.add(bx(1.8,1.2,0.05,COLORS.whiteboardFrame,0,1.4,-0.5));
  g.add(bx(1.65,1.05,0.02,COLORS.whiteboard,0,1.42,-0.47));
  g.add(cy(0.03,0.03,0.7,COLORS.whiteboardFrame,-0.7,0.35,-0.5));
  g.add(cy(0.03,0.03,0.7,COLORS.whiteboardFrame,0.7,0.35,-0.5));
  g.add(bx(0.6,0.04,0.08,COLORS.whiteboardFrame,0,0.82,-0.42));
  return g;
}
function buildBookshelf(x,z,rY=0) {
  const g=new THREE.Group();g.position.set(x,0,z);g.rotation.y=rY;
  g.add(bx(1.0,1.6,0.3,COLORS.bookshelf,0,0.8,0));
  for(let i=0;i<4;i++)g.add(bx(0.96,0.03,0.28,0x8a6a4a,0,0.3+i*0.38,0));
  const bc=[0xcc4444,0x4444cc,0x44aa44,0xccaa44,0x8844aa];
  for(let s=0;s<3;s++){let bxx=-0.4;for(let b=0;b<4+Math.floor(Math.random()*2);b++){const bw=0.06+Math.random()*0.08,bh=0.25+Math.random()*0.1;g.add(bx(bw,bh,0.2,bc[Math.floor(Math.random()*bc.length)],bxx+bw/2,0.32+s*0.38+bh/2,0));bxx+=bw+0.02;}}
  return g;
}
function buildLounge(x,z) {
  const g=new THREE.Group();g.position.set(x,0,z);
  // Couch seat at y=0.25, back at y=0.55
  g.add(bx(1.8,0.35,0.7,0x5a6a7a,0,0.25,-0.6));
  g.add(bx(1.8,0.45,0.12,0x4a5a6a,0,0.55,-0.9));
  g.add(bx(0.12,0.25,0.7,0x4a5a6a,-0.9,0.45,-0.6));
  g.add(bx(0.12,0.25,0.7,0x4a5a6a,0.9,0.45,-0.6));
  g.add(bx(0.8,0.04,0.5,0x9a7a5a,0,0.38,0.3));
  g.add(cy(0.03,0.03,0.36,COLORS.deskLeg,-0.32,0.18,0.3));
  g.add(cy(0.03,0.03,0.36,COLORS.deskLeg,0.32,0.18,0.3));
  g.add(bx(2.4,0.01,2.0,COLORS.rug,0,0.005,-0.1));
  return g;
}
function buildWalls(scene) {
  const H=2.2,T=0.12,W=20,D=16;
  scene.add(bx(W,H,T,COLORS.wall,0,H/2,-D/2));scene.add(bx(W,0.08,T+0.1,COLORS.wallTop,0,H,-D/2));
  scene.add(bx(T,H,D,COLORS.wall,W/2,H/2,0));scene.add(bx(T+0.1,0.08,D,COLORS.wallTop,W/2,H,0));
  scene.add(bx(T,H,8,COLORS.wall,-W/2,H/2,-4));scene.add(bx(T+0.1,0.08,8,COLORS.wallTop,-W/2,H,-4));
  const gl=new THREE.Mesh(new THREE.BoxGeometry(T,H*0.7,5),new THREE.MeshLambertMaterial({color:0xaaccee,transparent:true,opacity:0.3}));
  gl.position.set(3.5,H*0.35,3);scene.add(gl);
  scene.add(bx(T+0.04,0.06,5,0x666666,3.5,H*0.7,3));
  scene.add(bx(T+0.04,H*0.7,0.06,0x666666,3.5,H*0.35,0.5));
  scene.add(bx(T+0.04,H*0.7,0.06,0x666666,3.5,H*0.35,5.5));
}
function buildFloor(scene) {
  const S=20,D=16,TS=2;
  for(let x=-S/2;x<S/2;x+=TS)for(let z=-D/2;z<D/2;z+=TS){
    const alt=((x/TS+z/TS)%2+2)%2===0;
    const t=bx(TS-0.02,0.05,TS-0.02,alt?COLORS.floor:COLORS.floorAlt,x+TS/2,-0.025,z+TS/2);
    t.receiveShadow=true;t.castShadow=false;scene.add(t);
  }
}

// ─── Chat bubble ───────────────────────────────────────────────────
function createChatBubble(text, bodyColor) {
  const c=document.createElement("canvas");const ctx=c.getContext("2d");
  c.width=256;c.height=96;ctx.font="bold 17px sans-serif";
  const tw=Math.min(ctx.measureText(text).width+28,240);
  const bw=Math.max(tw,60),bh=46,bxx=(256-bw)/2,by=6,r=12;
  ctx.fillStyle="#ffffff";ctx.strokeStyle="#"+bodyColor.toString(16).padStart(6,"0");ctx.lineWidth=3;
  ctx.beginPath();ctx.moveTo(bxx+r,by);
  ctx.lineTo(bxx+bw-r,by);ctx.quadraticCurveTo(bxx+bw,by,bxx+bw,by+r);
  ctx.lineTo(bxx+bw,by+bh-r);ctx.quadraticCurveTo(bxx+bw,by+bh,bxx+bw-r,by+bh);
  ctx.lineTo(128+8,by+bh);ctx.lineTo(128,by+bh+14);ctx.lineTo(128-8,by+bh);
  ctx.lineTo(bxx+r,by+bh);ctx.quadraticCurveTo(bxx,by+bh,bxx,by+bh-r);
  ctx.lineTo(bxx,by+r);ctx.quadraticCurveTo(bxx,by,bxx+r,by);
  ctx.closePath();ctx.fill();ctx.stroke();
  ctx.fillStyle="#222";ctx.font="bold 16px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";
  ctx.fillText(text,128,by+bh/2+1,228);
  const tex=new THREE.CanvasTexture(c);tex.needsUpdate=true;
  const mat=new THREE.SpriteMaterial({map:tex,transparent:true,opacity:0});
  const sp=new THREE.Sprite(mat);sp.scale.set(1.8,0.68,1);sp.position.set(0,1.45,0);
  return sp;
}

// ─── Worker ────────────────────────────────────────────────────────
function createWorker(cfg) {
  const g=new THREE.Group();
  const bMat=new THREE.MeshLambertMaterial({color:cfg.body});
  const body=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.13,0.4,8),bMat);
  body.position.y=0.55;body.castShadow=true;g.add(body);
  const shoulder=new THREE.Mesh(new THREE.SphereGeometry(0.16,8,6),bMat);
  shoulder.position.y=0.75;shoulder.scale.set(1,0.5,0.8);shoulder.castShadow=true;g.add(shoulder);
  const head=new THREE.Mesh(new THREE.SphereGeometry(0.14,8,8),new THREE.MeshLambertMaterial({color:cfg.head}));
  head.position.y=0.92;head.castShadow=true;g.add(head);
  const hair=new THREE.Mesh(new THREE.SphereGeometry(0.145,8,4,0,Math.PI*2,0,Math.PI*0.5),new THREE.MeshLambertMaterial({color:new THREE.Color(cfg.body).multiplyScalar(0.4)}));
  hair.position.y=0.95;g.add(hair);
  const aG=new THREE.CylinderGeometry(0.04,0.05,0.28,6);
  const lA=new THREE.Group();lA.add(new THREE.Mesh(aG,new THREE.MeshLambertMaterial({color:cfg.body})));lA.position.set(-0.22,0.58,0);g.add(lA);
  const rA=new THREE.Group();rA.add(new THREE.Mesh(aG.clone(),new THREE.MeshLambertMaterial({color:cfg.body})));rA.position.set(0.22,0.58,0);g.add(rA);
  const lG=new THREE.CylinderGeometry(0.05,0.06,0.25,6);const lM=new THREE.MeshLambertMaterial({color:0x3a3a5a});
  const lL=new THREE.Group();lL.add(new THREE.Mesh(lG,lM));lL.position.set(-0.08,0.22,0);g.add(lL);
  const rL=new THREE.Group();rL.add(new THREE.Mesh(lG.clone(),lM.clone()));rL.position.set(0.08,0.22,0);g.add(rL);
  const sG=new THREE.BoxGeometry(0.1,0.05,0.15);const sM=new THREE.MeshLambertMaterial({color:0x2a2a2a});
  const lS=new THREE.Mesh(sG,sM);lS.position.set(-0.08,0.05,0.02);g.add(lS);
  const rS=new THREE.Mesh(sG.clone(),sM.clone());rS.position.set(0.08,0.05,0.02);g.add(rS);
  const sh=new THREE.Mesh(new THREE.CircleGeometry(0.2,8),new THREE.MeshBasicMaterial({color:0,transparent:true,opacity:0.15}));
  sh.rotation.x=-Math.PI/2;sh.position.y=0.01;g.add(sh);
  g._lA=lA;g._rA=rA;g._lL=lL;g._rL=rL;g._lS=lS;g._rS=rS;g._body=body;g._shoulder=shoulder;g._head=head;
  return g;
}
function applyPose(m,p){
  m._body.position.y=p.bodyY;m._shoulder.position.y=p.bodyY+0.2;
  m._lL.rotation.x=p.legRot;m._rL.rotation.x=p.legRot;
  m._lA.rotation.x=p.armRot;m._rA.rotation.x=p.armRot;
  m._lA.rotation.z=-p.armZ;m._rA.rotation.z=p.armZ;
  m._lL.position.y=p.legY;m._rL.position.y=p.legY;
  m._lS.position.y=p.shoeY;m._rS.position.y=p.shoeY;
}
function lp(a,b,t){return a+(b-a)*Math.min(t,1);}

// ─── MAIN ──────────────────────────────────────────────────────────
export default function IsometricOffice() {
  const mountRef=useRef(null);const animRef=useRef(null);const clockRef=useRef(new THREE.Clock());
  const [eventLog,setEventLog]=useState([]);
  const [isPaused,setIsPaused]=useState(false);const isPausedRef=useRef(false);
  const evtIdx=useRef(0);const evtTimer=useRef(0);
  const [stats,setStats]=useState({moving:0,idle:0,seated:6});
  const [speed,setSpeed]=useState(1);const speedRef=useRef(1);
  const [panelOpen,setPanelOpen]=useState(true);

  useEffect(()=>{speedRef.current=speed;},[speed]);
  useEffect(()=>{isPausedRef.current=isPaused;},[isPaused]);

  const addEvt=useCallback((wi,to,reason,type,text)=>{
    const ts=new Date().toLocaleTimeString();const w=WORKER_COLORS[wi];
    setEventLog(prev=>[{worker:w.name,to:to?(LOCATIONS[to]?.label||to):null,reason,timestamp:ts,color:w.body,type:type||"move",text},...prev.slice(0,40)]);
  },[]);

  useEffect(()=>{
    if(!mountRef.current)return;
    const el=mountRef.current;
    const scene=new THREE.Scene();
    scene.background=new THREE.Color(COLORS.bg);
    scene.fog=new THREE.FogExp2(COLORS.bg,0.018);

    const aspect=el.clientWidth/el.clientHeight;const frustum=10;
    const cam=new THREE.OrthographicCamera(-frustum*aspect/2,frustum*aspect/2,frustum/2,-frustum/2,0.1,100);
    const isoA=Math.PI/6,dist=20;
    // Camera offset for panning
    const camTarget=new THREE.Vector3(0,0,0);
    const camBaseOffset=new THREE.Vector3(dist*Math.cos(isoA),dist*Math.sin(Math.PI/4),dist*Math.sin(isoA));
    cam.position.copy(camBaseOffset);cam.lookAt(camTarget);
    cam.zoom=0.85;cam.updateProjectionMatrix();

    const ren=new THREE.WebGLRenderer({antialias:true});
    ren.setSize(el.clientWidth,el.clientHeight);
    ren.setPixelRatio(Math.min(window.devicePixelRatio,2));
    ren.shadowMap.enabled=true;ren.shadowMap.type=THREE.PCFSoftShadowMap;
    ren.toneMapping=THREE.ACESFilmicToneMapping;ren.toneMappingExposure=1.1;
    el.appendChild(ren.domElement);

    scene.add(new THREE.AmbientLight(0xffffff,0.6));
    const dL=new THREE.DirectionalLight(0xfff4e0,1.2);dL.position.set(8,12,6);dL.castShadow=true;
    dL.shadow.mapSize.set(2048,2048);dL.shadow.camera.left=-15;dL.shadow.camera.right=15;
    dL.shadow.camera.top=15;dL.shadow.camera.bottom=-15;dL.shadow.camera.near=0.1;dL.shadow.camera.far=40;dL.shadow.bias=-0.002;scene.add(dL);
    scene.add(new THREE.DirectionalLight(0xc0d0ff,0.3).translateX(-6).translateY(8).translateZ(-4));

    buildFloor(scene);buildWalls(scene);

    // Desks: place desk at (x,z), chair at (x, z+0.55) - offset to match seat position
    [[-6,-4],[-6,-1],[-6,2],[-2,-4],[-2,-1],[-2,2]].forEach(([x,z])=>{
      scene.add(buildDesk(x,z));
      const ch=buildChair(x,z+0.55);
      ch.rotation.y=Math.PI; // face toward desk
      scene.add(ch);
    });
    scene.add(buildKitchen(6,-5));scene.add(buildMeetingTable(6,3));
    scene.add(buildWhiteboard(6,0));scene.add(buildLounge(2,-5));
    scene.add(buildPlant(-9,-7,1.2));scene.add(buildPlant(9,-7,0.9));
    scene.add(buildPlant(-9,5,1.0));scene.add(buildPlant(3.5,0.3,0.8));scene.add(buildPlant(3.5,5.7,1.1));
    scene.add(buildBookshelf(-9,-2,0));scene.add(buildBookshelf(-9,1,0));

    // Workers start at their desks, seated
    const homeKeys=["desk-alice","desk-bob","desk-carol","desk-dave","desk-eve","desk-frank"];
    const workers=WORKER_COLORS.map((cfg,i)=>{
      const mesh=createWorker(cfg);
      const seat=getSeatPosition(homeKeys[i],i);
      mesh.position.set(seat.x,0,seat.z);
      mesh.rotation.y=seat.faceY;
      scene.add(mesh);
      const p=poseFor(homeKeys[i]);
      applyPose(mesh,p);
      return {
        mesh,cfg,target:null,targetKey:homeKeys[i],curLoc:homeKeys[i],
        speed:2.0,state:"seated",walkPhase:Math.random()*Math.PI*2,
        sitT:1,curPose:{...p},tgtPose:{...p},
        bubble:null,bubbleT:0,bubblePhase:0,
        seatRef:null,
      };
    });

    // ── Camera controls ──
    let isDragging=false, dragStart={x:0,y:0};
    const onWheel=(e)=>{
      e.preventDefault();
      cam.zoom=Math.max(0.35,Math.min(2.5,cam.zoom-e.deltaY*0.001));
      cam.updateProjectionMatrix();
    };
    const onPointerDown=(e)=>{
      if(e.button===0||e.button===1||e.button===2){isDragging=true;dragStart={x:e.clientX,y:e.clientY};el.style.cursor="grabbing";}
    };
    const onPointerMove=(e)=>{
      if(!isDragging)return;
      const dx=(e.clientX-dragStart.x)*0.02/cam.zoom;
      const dy=(e.clientY-dragStart.y)*0.02/cam.zoom;
      // Pan along the isometric plane
      camTarget.x-=dx*Math.cos(isoA)+dy*Math.sin(isoA)*0.5;
      camTarget.z-=-dx*Math.sin(isoA)+dy*Math.cos(isoA)*0.5;
      camTarget.x=Math.max(-12,Math.min(12,camTarget.x));
      camTarget.z=Math.max(-10,Math.min(10,camTarget.z));
      cam.position.copy(camTarget).add(camBaseOffset);
      cam.lookAt(camTarget);
      dragStart={x:e.clientX,y:e.clientY};
    };
    const onPointerUp=()=>{isDragging=false;el.style.cursor="grab";};
    const onCtx=(e)=>e.preventDefault();

    el.addEventListener("wheel",onWheel,{passive:false});
    el.addEventListener("pointerdown",onPointerDown);
    el.addEventListener("pointermove",onPointerMove);
    el.addEventListener("pointerup",onPointerUp);
    el.addEventListener("pointerleave",onPointerUp);
    el.addEventListener("contextmenu",onCtx);
    el.style.cursor="grab";

    // ── Animation ──
    const animate=()=>{
      animRef.current=requestAnimationFrame(animate);
      const dt=clockRef.current.getDelta();const time=clockRef.current.getElapsedTime();
      const sp=speedRef.current;

      if(!isPausedRef.current){
        evtTimer.current+=dt*sp;
        if(evtTimer.current>2.0){
          evtTimer.current=0;
          const ev=EVENTS[evtIdx.current%EVENTS.length];evtIdx.current++;
          const w=workers[ev.worker];
          if(ev.type==="move"){
            const loc=LOCATIONS[ev.to];
            if(loc){
              // Release old seat
              if(w.seatRef)w.seatRef.taken=false;
              w.seatRef=null;
              // Get new seat position
              const seat=getSeatPosition(ev.to,ev.worker);
              w.target={x:seat.x,z:seat.z,faceY:seat.faceY};
              w.targetKey=ev.to;
              w.state="walking";w.tgtPose={...POSE.stand};w.sitT=0;
              if(seat.seatRef)w.seatRef=seat.seatRef;
              addEvt(ev.worker,ev.to,ev.reason,"move");
            }
          } else if(ev.type==="chat"){
            if(w.bubble){w.mesh.remove(w.bubble);w.bubble=null;}
            w.bubble=createChatBubble(ev.text,w.cfg.body);
            w.mesh.add(w.bubble);w.bubbleT=0;w.bubblePhase=1;
            addEvt(ev.worker,null,null,"chat",ev.text);
          }
        }
      }

      let nMov=0,nSit=0,nIdl=0;
      workers.forEach((w,wi)=>{
        const m=w.mesh;

        if(w.state==="walking"&&w.target){
          const dx=w.target.x-m.position.x,dz=w.target.z-m.position.z;
          const dist=Math.sqrt(dx*dx+dz*dz);
          if(dist<0.1){
            w.state="sitting_down";w.curLoc=w.targetKey;
            w.tgtPose=poseFor(w.targetKey);w.sitT=0;
            w.seatFaceY=w.target.faceY;
            w.target=null;
          } else {
            nMov++;
            const step=Math.min(w.speed*dt*sp,dist);
            m.position.x+=(dx/dist)*step;m.position.z+=(dz/dist)*step;
            m.rotation.y=Math.atan2(dx,dz);
            w.walkPhase+=dt*10*sp;const sw=Math.sin(w.walkPhase)*0.4;
            m._lA.rotation.x=sw;m._rA.rotation.x=-sw;m._lA.rotation.z=0;m._rA.rotation.z=0;
            m._lL.rotation.x=-sw*0.6;m._rL.rotation.x=sw*0.6;
            m._body.position.y=0.55+Math.abs(Math.sin(w.walkPhase*2))*0.03;
            m._shoulder.position.y=0.75+Math.abs(Math.sin(w.walkPhase*2))*0.03;
            m._lL.position.y=0.22;m._rL.position.y=0.22;m._lS.position.y=0.05;m._rS.position.y=0.05;
          }
        }

        if(w.state==="sitting_down"){
          nSit++;w.sitT+=dt*3*sp;const t=Math.min(w.sitT,1);const e=t*(2-t);const p=w.tgtPose;
          // Lerp facing direction to saved seat facing
          if(w.seatFaceY!==undefined) m.rotation.y=lp(m.rotation.y,w.seatFaceY,e);
          m._body.position.y=lp(m._body.position.y,p.bodyY,e);
          m._shoulder.position.y=m._body.position.y+0.2;
          m._lL.rotation.x=lp(m._lL.rotation.x,p.legRot,e);m._rL.rotation.x=lp(m._rL.rotation.x,p.legRot,e);
          m._lA.rotation.x=lp(m._lA.rotation.x,p.armRot,e);m._rA.rotation.x=lp(m._rA.rotation.x,p.armRot,e);
          m._lA.rotation.z=lp(m._lA.rotation.z,-p.armZ,e);m._rA.rotation.z=lp(m._rA.rotation.z,p.armZ,e);
          m._lL.position.y=lp(m._lL.position.y,p.legY,e);m._rL.position.y=lp(m._rL.position.y,p.legY,e);
          m._lS.position.y=lp(m._lS.position.y,p.shoeY,e);m._rS.position.y=lp(m._rS.position.y,p.shoeY,e);
          if(t>=1){w.state="seated";w.curPose={...p};}
        }

        if(w.state==="seated"){
          nSit++;const br=Math.sin(time*1.5+wi*1.3)*0.008;
          m._body.position.y=w.curPose.bodyY+br;m._shoulder.position.y=w.curPose.bodyY+0.2+br;
          const loc=LOCATIONS[w.curLoc];
          if(loc&&loc.type==="desk"){const ty=Math.sin(time*8+wi*2)*0.06;m._lA.rotation.x=w.curPose.armRot+ty;m._rA.rotation.x=w.curPose.armRot-ty;}
        }

        if(w.state==="idle"){
          nIdl++;const br=Math.sin(time*2+wi)*0.01;
          m._body.position.y=0.55+br;m._shoulder.position.y=0.75+br;
          m._lA.rotation.x*=0.9;m._rA.rotation.x*=0.9;m._lL.rotation.x*=0.9;m._rL.rotation.x*=0.9;
        }

        // Chat bubble
        if(w.bubble){
          w.bubbleT+=dt*sp;const mat=w.bubble.material;
          if(w.bubblePhase===1){const t2=Math.min(w.bubbleT*4,1);mat.opacity=t2;const sc=0.5+t2*0.5;w.bubble.scale.set(sc*2.6,sc,1);if(t2>=1){w.bubblePhase=2;w.bubbleT=0;}}
          else if(w.bubblePhase===2){w.bubble.position.y=1.45+Math.sin(time*2)*0.02;if(w.bubbleT>3.5){w.bubblePhase=3;w.bubbleT=0;}}
          else if(w.bubblePhase===3){mat.opacity=Math.max(1-w.bubbleT*3,0);w.bubble.position.y=1.45+w.bubbleT*0.15;if(mat.opacity<=0){m.remove(w.bubble);w.bubble=null;w.bubblePhase=0;}}
          if(w.bubble&&w.bubblePhase!==3)m._head.rotation.x=Math.sin(time*4)*0.08;
        } else { m._head.rotation.x*=0.92; }
      });

      setStats({moving:nMov,idle:nIdl,seated:nSit});
      ren.render(scene,cam);
    };
    clockRef.current.start();animate();

    const onResize=()=>{
      if(!el)return;const w=el.clientWidth,h=el.clientHeight,a=w/h;
      cam.left=-frustum*a/2;cam.right=frustum*a/2;cam.top=frustum/2;cam.bottom=-frustum/2;
      cam.updateProjectionMatrix();ren.setSize(w,h);
    };
    window.addEventListener("resize",onResize);
    return()=>{
      window.removeEventListener("resize",onResize);
      el.removeEventListener("wheel",onWheel);
      el.removeEventListener("pointerdown",onPointerDown);
      el.removeEventListener("pointermove",onPointerMove);
      el.removeEventListener("pointerup",onPointerUp);
      el.removeEventListener("pointerleave",onPointerUp);
      el.removeEventListener("contextmenu",onCtx);
      cancelAnimationFrame(animRef.current);
      if(el&&ren.domElement.parentNode===el)el.removeChild(ren.domElement);
      ren.dispose();
    };
  },[addEvt]);

  const hx=(h)=>"#"+h.toString(16).padStart(6,"0");
  const PW=panelOpen?300:0;

  return (
    <div style={{width:"100%",height:"100vh",display:"flex",fontFamily:"'JetBrains Mono','SF Mono','Fira Code',monospace",background:"#1a1a2e",color:"#e0e0e0",overflow:"hidden",position:"relative"}}>
      {/* 3D viewport */}
      <div ref={mountRef} style={{flex:1,position:"relative"}}>
        <div style={{position:"absolute",top:0,left:0,right:0,padding:"14px 20px",background:"linear-gradient(180deg,rgba(16,16,32,0.9) 0%,transparent 100%)",display:"flex",alignItems:"center",gap:16,zIndex:10,pointerEvents:"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:"#4aff8a",boxShadow:"0 0 8px #4aff8a"}}/>
            <span style={{fontSize:11,color:"#4aff8a",letterSpacing:2,textTransform:"uppercase"}}>Live</span>
          </div>
          <span style={{fontSize:14,fontWeight:600,color:"#fff",letterSpacing:1}}>FUTURATOR OFFICE</span>
          <span style={{fontSize:10,color:"#555",marginLeft:"auto",letterSpacing:1}}>Drag to pan · Scroll to zoom</span>
        </div>
        <div style={{position:"absolute",bottom:16,left:16,display:"flex",gap:10,zIndex:10,pointerEvents:"none"}}>
          {[{l:"Moving",c:stats.moving,cl:"#4a90d9",bg:"74,144,217"},{l:"Seated",c:stats.seated,cl:"#d9a04a",bg:"217,160,74"},{l:"Idle",c:stats.idle,cl:"#5aba8a",bg:"90,186,138"}].map((s,i)=>(
            <div key={i} style={{padding:"6px 14px",borderRadius:20,fontSize:11,background:`rgba(${s.bg},0.15)`,border:`1px solid rgba(${s.bg},0.3)`,color:s.cl,display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:s.cl}}/>{s.c} {s.l}
            </div>
          ))}
        </div>
      </div>

      {/* Panel toggle */}
      <button onClick={()=>setPanelOpen(!panelOpen)} style={{
        position:"absolute",right:panelOpen?300:0,top:"50%",transform:"translateY(-50%)",zIndex:20,
        width:24,height:56,background:"#12122a",border:"1px solid rgba(255,255,255,0.1)",
        borderRight:panelOpen?"none":"1px solid rgba(255,255,255,0.1)",
        borderRadius:panelOpen?"6px 0 0 6px":"0 6px 6px 0",
        color:"#888",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",
        transition:"right 0.3s ease",
      }}>
        {panelOpen?"›":"‹"}
      </button>

      {/* Side panel */}
      <div style={{
        width:PW,maxWidth:PW,minWidth:PW,background:"#12122a",borderLeft:"1px solid rgba(255,255,255,0.06)",
        display:"flex",flexDirection:"column",overflow:"hidden",transition:"all 0.3s ease",
      }}>
        {panelOpen && <>
          <div style={{padding:"16px 16px 12px",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
            <div style={{fontSize:10,letterSpacing:2,color:"#666",marginBottom:12,textTransform:"uppercase"}}>Controls</div>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={()=>setIsPaused(!isPaused)} style={{flex:1,padding:"8px 0",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,background:isPaused?"rgba(217,74,106,0.15)":"rgba(74,217,150,0.15)",color:isPaused?"#d94a6a":"#4ad996",cursor:"pointer",fontSize:11,fontFamily:"inherit",letterSpacing:1}}>
                {isPaused?"▶ RESUME":"⏸ PAUSE"}
              </button>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:10,color:"#666",minWidth:40}}>Speed</span>
              <input type="range" min="0.2" max="3" step="0.1" value={speed} onChange={e=>setSpeed(parseFloat(e.target.value))} style={{flex:1,accentColor:"#4a90d9",height:4}}/>
              <span style={{fontSize:11,color:"#4a90d9",minWidth:30,textAlign:"right"}}>{speed.toFixed(1)}x</span>
            </div>
          </div>
          <div style={{padding:"12px 16px",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
            <div style={{fontSize:10,letterSpacing:2,color:"#666",marginBottom:10,textTransform:"uppercase"}}>Team</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {WORKER_COLORS.map((w,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:12,background:`${hx(w.body)}15`,border:`1px solid ${hx(w.body)}30`,fontSize:10}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:hx(w.body)}}/>
                  <span style={{color:hx(w.body)}}>{w.name}</span>
                  <span style={{color:"#555",fontSize:9}}>{w.role}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"12px 16px 8px",fontSize:10,letterSpacing:2,color:"#666",textTransform:"uppercase",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>Event Log</span><span style={{fontSize:9,color:"#444"}}>{eventLog.length}</span>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"0 16px 16px"}}>
              {eventLog.length===0&&<div style={{color:"#444",fontSize:11,padding:"20px 0",textAlign:"center"}}>Waiting for events...</div>}
              {eventLog.map((evt,i)=>(
                <div key={i} style={{padding:"8px 10px",marginBottom:4,borderRadius:6,background:i===0?(evt.type==="chat"?"rgba(217,160,74,0.08)":"rgba(74,144,217,0.08)"):"transparent",borderLeft:`2px solid ${hx(evt.color)}`,opacity:Math.max(0.3,1-i*0.04)}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <span style={{fontSize:11,fontWeight:600,color:hx(evt.color)}}>{evt.type==="chat"?"💬 ":""}{evt.worker}</span>
                    <span style={{fontSize:9,color:"#555"}}>{evt.timestamp}</span>
                  </div>
                  <div style={{fontSize:10,color:"#888"}}>
                    {evt.type==="chat"?<span style={{color:"#aaa",fontStyle:"italic"}}>"{evt.text}"</span>:<>→ {evt.to} · <span style={{color:"#666"}}>{evt.reason}</span></>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>}
      </div>
    </div>
  );
}
