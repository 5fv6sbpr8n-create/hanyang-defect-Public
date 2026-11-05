import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* 한양빌딩 3D 뷰어
   - 형상: Revit 예시 모델과 같은 치수 (7층, 36×18 m, 커튼월 35 · 파라펫 8 · 창호 55)
   - 상태 색: def 하자 발생 / sim 유사 하자 점검 대상 / done 보수 완료 / ok 정상 / none 데이터 없음
   - 강조: 선택 부재 또는 상태 강조(iso)에 해당하지 않는 부재와 구조체는 반투명 처리 */
const LV = [0, 4.5, 8.1, 11.7, 15.3, 18.9, 22.5, 26.1];
const COL = { def: 0xE5534B, sim: 0xF2C200, done: 0x3FAE6A, ok: 0xBFD0E2, none: 0xB9BDC3 };
const X = x => x - 18, Z = y => 9 - y;   // 모델(m): x 0..36, y(깊이) 0..18 → three 좌표

const host = document.getElementById('v3d');
const tip = document.getElementById('v3dTip');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(34, 1, 0.5, 600);
const ctl = new OrbitControls(cam, renderer.domElement);
ctl.enableDamping = true; ctl.dampingFactor = 0.08; ctl.maxPolarAngle = Math.PI * 0.52; ctl.minDistance = 12; ctl.maxDistance = 160;
const HOME = { pos: new THREE.Vector3(46, 34, 56), tgt: new THREE.Vector3(0, 11, 0) };
function home(){ cam.position.copy(HOME.pos); ctl.target.copy(HOME.tgt); ctl.update(); }
home();

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6df, 1.05));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-30, 60, 40); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, far: 200 }); sun.shadow.bias = -0.0005;
scene.add(sun);

const M = {
  grey: new THREE.MeshStandardMaterial({ color: 0xE9E7E1, roughness: 0.9 }),
  slab: new THREE.MeshStandardMaterial({ color: 0xDCDAD3, roughness: 0.95 }),
  core: new THREE.MeshStandardMaterial({ color: 0xCFCCC4, roughness: 0.95 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xE4DFD5, roughness: 0.85, side: THREE.DoubleSide }),
  win: new THREE.MeshStandardMaterial({ color: 0x6C849E, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.7 }),
  door: new THREE.MeshStandardMaterial({ color: 0x4A4F57, roughness: 0.5, metalness: 0.4 }),
  edge: new THREE.LineBasicMaterial({ color: 0x6B6F76, transparent: true, opacity: 0.55 }),
  ground: new THREE.MeshStandardMaterial({ color: 0xF1F1EE, roughness: 1 }),
  mull: new THREE.LineBasicMaterial({ color: 0x3C4654, transparent: true, opacity: 0.75 }),
};
const memberMat = {}, winMat = {};
for (const k of Object.keys(COL)) {
  memberMat[k] = new THREE.MeshStandardMaterial({ color: COL[k], roughness: 0.35, metalness: 0.05, transparent: k === 'ok', opacity: k === 'ok' ? 0.8 : 1 });
  winMat[k] = k === 'ok' ? new THREE.MeshStandardMaterial({ color: 0x8FA9C6, roughness: 0.15, metalness: 0.2 }) : k === 'none' ? M.win : new THREE.MeshStandardMaterial({ color: COL[k], roughness: 0.3 });
}
const ghostMat = new THREE.MeshStandardMaterial({ color: 0xC9CDD3, roughness: 0.9, transparent: true, opacity: 0.14, depthWrite: false });
// 하자 윤곽: 보이는 면에서만 그림(가려진 부분은 안 그림). 벽 너머로 비춰 보이는 윤곽은 그 하자 부재를 선택했을 때만 표시
const outlineMat = new THREE.LineBasicMaterial({ color: 0xD93A35, transparent: true, opacity: 0.95 });
const xrayMat = new THREE.LineBasicMaterial({ color: 0xD93A35, depthTest: false, transparent: true, opacity: 0.55 });
// 구조체(기둥·바닥·코어·외벽·창·문·선) 반투명 전환용 원래 값
const STRUCT = [M.grey, M.slab, M.core, M.wall, M.win, M.door, M.edge, M.mull];
STRUCT.forEach(m => { m.userData.base = { t: m.transparent, o: m.opacity, dw: m.depthWrite }; });
let structGhost = null;
function ghostStructure(on){
  if (structGhost === on) return; structGhost = on;
  STRUCT.forEach(m => { const b = m.userData.base; m.transparent = on ? true : b.t; m.opacity = on ? Math.min(b.o, m.isLineBasicMaterial ? 0.18 : 0.16) : b.o; m.depthWrite = on ? false : b.dw; m.needsUpdate = true; });
}

const selBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x2F7CF6, transparent: true, opacity: 0.22, depthTest: false }));
selBox.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x2F7CF6, depthTest: false })));
selBox.renderOrder = 9; selBox.visible = false; scene.add(selBox);
const floors = [];           // floors[0..6] = 1F..7F, floors[7] = 지붕
const members = new Map();   // eid -> { mesh, kind, f, pin }
const pickables = [];
function edges(m){ m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), M.edge)); return m; }
function box(w, h, d, mat, x, y, z, grp, shadow = true){ const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; grp.add(m); return m; }
/* 창이 뚫린 외벽: len(m) × h, wins=[중심 u, 폭], 두께 0.25 */
const winByMark = new Map();   // 'WN-3F-N02' -> glass mesh
function wallWin(len, h, wins, grp, pos, rotY){
  const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(len, 0); sh.lineTo(len, h); sh.lineTo(0, h); sh.lineTo(0, 0);
  const op = ([u, w, , kind]) => kind === 'door' ? [u - w/2, 0, u + w/2, 2.4] : [u - w/2, 0.9, u + w/2, 0.9 + 1.6];
  for (const wdef of wins) { const [a, b, c, d] = op(wdef); const hp = new THREE.Path(); hp.moveTo(a, b); hp.lineTo(c, b); hp.lineTo(c, d); hp.lineTo(a, d); hp.lineTo(a, b); sh.holes.push(hp); }
  const g = new THREE.Group(); g.position.copy(pos); g.rotation.y = rotY;
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.25, bevelEnabled: false }), M.wall); m.castShadow = true; m.receiveShadow = true; g.add(edges(m));
  for (const wdef of wins) {
    const [a, b, c, d] = op(wdef);
    const gl = new THREE.Mesh(new THREE.BoxGeometry(c - a, d - b, 0.12), wdef[3] === 'door' ? M.door : M.win);
    gl.position.set((a + c) / 2, (b + d) / 2, rotY ? 0.2 : 0.05); gl.castShadow = false; g.add(gl);
    if (wdef[3] !== 'door') {
      const fr = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(c - a, d - b, 0.12)), M.mull); gl.add(fr);
      const mid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -(d - b) / 2, 0.07), new THREE.Vector3(0, (d - b) / 2, 0.07)]), M.mull); gl.add(mid);
      winByMark.set(wdef[2], gl);
    }
  }
  grp.add(g); return g;
}
/* ---- 고정 형상: 층별 그룹 ---- */
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), M.ground); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true; scene.add(ground);
for (let f = 0; f < 7; f++) {
  const g = new THREE.Group(); g.name = `${f + 1}F`; const z0 = LV[f], h = LV[f + 1] - z0;
  edges(box(36.4, 0.3, 18.4, M.slab, 0, z0 + 0.15, 0, g));                // 바닥판
  for (let i = 0; i < 6; i++) edges(box(1, h, 0.6, M.grey, X(i * 7 + 0.5), z0 + h / 2, Z(0) - 0.1, g));  // 남측 기둥형 벽
  edges(box(8, h, 6, M.core, X(18), z0 + h / 2, Z(10), g));               // 코어
  const F = `WN-${f + 1}F-`;
  const northW = [3.5, 10.5, 25.5, 32.5].map((x, j) => [x, 1.8, F + 'N0' + (j + 1)]);           // Revit 창호 위치와 동일
  const westW = [4.5, 13.5].map((y, j) => [y, 1.8, F + 'W0' + (j + 1)]);
  const eastW = [f === 0 ? [4.5, 1.8, 'DOOR-1F-E01', 'door'] : [4.5, 1.8, F + 'E01'], [13.5, 1.8, F + 'E02']];
  wallWin(36, h, northW, g, new THREE.Vector3(X(0), z0, Z(18)), 0);                    // 북측 외벽
  wallWin(18, h, eastW, g, new THREE.Vector3(X(36) - 0.25, z0, Z(0)), Math.PI / 2);    // 동측 외벽
  wallWin(18, h, westW, g, new THREE.Vector3(X(0), z0, Z(0)), Math.PI / 2);            // 서측 외벽
  floors.push(g); scene.add(g);
}
{
  const g = new THREE.Group(); g.name = '지붕';
  edges(box(36.4, 0.3, 18.4, M.slab, 0, LV[7] + 0.15, 0, g));
  edges(box(8, 3.2, 6, M.core, X(18), LV[7] + 1.6, Z(10), g));            // 옥탑
  floors.push(g); scene.add(g);
}

/* ---- 커튼월 패널 (멀리언 선 포함) ---- */
function mullions(w, h){
  const pts = [];
  for (let k = 0; k <= 4; k++) { const x = -w / 2 + k * (w / 4); pts.push(x, -h / 2, 0, x, h / 2, 0); }
  pts.push(-w / 2, h * 0.22, 0, w / 2, h * 0.22, 0);
  pts.push(-w / 2, -h / 2, 0, w / 2, -h / 2, 0, -w / 2, h / 2, 0, w / 2, h / 2, 0);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, M.mull);
}
function addCW(eid, mark){
  const r = /^CW-(\d)F-(\d{2})$/.exec(mark); if (!r) return;
  const f = +r[1] - 1, i = +r[2] - 1, z0 = LV[f], h = LV[f + 1] - z0;
  const mesh = box(6, h, 0.18, memberMat.ok, X(i * 7 + 4), z0 + h / 2, Z(0), floors[f]);
  const ln = mullions(6, h); ln.position.set(0, 0, 0.1); mesh.add(ln);
  mesh.userData = { eid, mark, kind: 'CW' }; pickables.push(mesh);
  members.set(String(eid), { mesh, f, kind: 'CW' });
}
function addPP(eid, mark){
  const r = /^PP-([NSEW])-(\d{2})$/.exec(mark); if (!r) return;
  const side = r[1], i = +r[2] - 1, y = LV[7] + 0.9, t = 0.3;
  let mesh;
  if (side === 'N') mesh = box(12, 1.2, t, memberMat.ok, X(i * 12 + 6), y, Z(18), floors[7]);
  else if (side === 'S') mesh = box(12, 1.2, t, memberMat.ok, X(i * 12 + 6), y, Z(0), floors[7]);
  else if (side === 'E') mesh = box(t, 1.2, 18.3, memberMat.ok, X(36), y, 0, floors[7]);
  else mesh = box(t, 1.2, 18.3, memberMat.ok, X(0), y, 0, floors[7]);
  mesh.userData = { eid, mark, kind: 'PP' }; pickables.push(mesh);
  members.set(String(eid), { mesh, f: 7, kind: 'PP' });
}

function addWN(eid, mark){
  const mesh = winByMark.get(mark); if (!mesh) return;
  const f = +/^WN-(\d)F-/.exec(mark)[1] - 1;
  mesh.userData = { eid, mark, kind: 'WN' }; pickables.push(mesh);
  members.set(String(eid), { mesh, f, kind: 'WN' });
}
/* ---- 하자 마커 (번호 원판) ---- */
const pinTex = new Map();
function pinSprite(n){
  if (!pinTex.has(n)) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.beginPath(); g.arc(64, 64, 54, 0, 7); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 12; g.strokeStyle = '#A82A26'; g.stroke();
    g.fillStyle = '#A82A26'; g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 64, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; pinTex.set(n, t);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTex.get(n), depthTest: false, transparent: true })); s.scale.set(1.9, 1.9, 1); s.renderOrder = 10; return s;
}

/* ---- 상태 반영 ---- */
const cur = { floor: 'all', sel: null, iso: null };
function addMember(m){
  const eid = String(m.eid); if (members.has(eid)) return;
  if (/^CW-/.test(m.mark)) addCW(eid, m.mark); else if (/^PP-/.test(m.mark)) addPP(eid, m.mark); else if (/^WN-/.test(m.mark)) addWN(eid, m.mark);
  const o = members.get(eid); if (!o) return;
  const eg = new THREE.EdgesGeometry(o.mesh.geometry);
  const ol = new THREE.LineSegments(eg, outlineMat); ol.renderOrder = 7; ol.visible = false; ol.userData.hj = 1; o.mesh.add(ol); o.outline = ol;
  const xr = new THREE.LineSegments(eg, xrayMat); xr.renderOrder = 8; xr.visible = false; xr.userData.hj = 1; o.mesh.add(xr); o.xray = xr;
}
/* info: Map eid -> { st: 'def'|'sim'|'done'|'ok', n: 진행 중 하자 수 }, sel: eid|null, iso: 상태키|null */
function update({ members: ms, info, sel, iso }){
  for (const m of ms.values()) addMember(m);
  // 데이터가 없는 창(모델에는 있으나 부재 목록에 없음)은 기본 유리색
  for (const [mark, mesh] of winByMark) if (!mesh.userData.eid) mesh.material = M.win;
  const focusMode = !!(sel || iso);
  ghostStructure(focusMode);
  // 부재 목록에서 빠진 항목(예: Element ID 변경 전 키)은 장면에서 정리 — 창은 같은 유리 메시를 새 키가 이어서 씀
  for (const [eid, o] of [...members]) {
    if (ms.has(eid)) continue;
    if (o.outline) o.mesh.remove(o.outline); if (o.xray) o.mesh.remove(o.xray); if (o.pin) o.mesh.remove(o.pin);
    if (o.kind !== 'WN' || String(o.mesh.userData.eid) === eid) {
      if (o.kind !== 'WN') { o.mesh.parent && o.mesh.parent.remove(o.mesh); const k = pickables.indexOf(o.mesh); if (k >= 0) pickables.splice(k, 1); }
      else { o.mesh.userData = {}; o.mesh.material = M.win; }
    }
    members.delete(eid);
  }
  for (const [eid, o] of members) {
    const it = info.get(eid) || { st: 'ok', n: 0 };
    const emph = !!(!focusMode || eid === String(sel) || (iso && it.st === iso));
    o.mesh.material = emph ? (o.kind === 'WN' ? winMat : memberMat)[it.st] : ghostMat;
    o.mesh.children.forEach(c => { if (c.isLineSegments && !c.userData.hj) c.visible = emph; });
    if (o.outline) o.outline.visible = it.st === 'def' && emph;
    if (o.xray) o.xray.visible = it.st === 'def' && eid === String(sel);   // 선택한 하자 부재만 가려져도 윤곽 표시
    const n = it.st === 'def' ? it.n : 0;
    if (o.pinN !== n) { if (o.pin) { o.mesh.remove(o.pin); o.pin = null; } if (n > 0) { const p = pinSprite(n); p.position.set(0, o.kind === 'PP' ? 1.6 : 0, o.kind === 'PP' ? 0 : 1.1); o.mesh.add(p); o.pin = p; } o.pinN = n; }
  }
  const so = sel != null && members.get(String(sel));
  if (so) { const bb = new THREE.Box3().setFromObject(so.mesh, true); bb.getCenter(selBox.position); const sz = bb.getSize(new THREE.Vector3()); selBox.scale.set(sz.x + 0.5, sz.y + 0.5, sz.z + 0.5); selBox.visible = true; }
  else selBox.visible = false;
  cur.sel = sel; cur.iso = iso; needs = true;
}
function setFloor(v){
  cur.floor = String(v);
  floors.forEach((g, i) => { g.visible = cur.floor === 'all' || String(i) === cur.floor; });
  ground.visible = cur.floor === 'all' || cur.floor === '0';
  if (cur.floor === 'all') { fly(HOME.tgt, HOME.pos); }
  else { const i = +cur.floor, y = i === 7 ? LV[7] + 1 : (LV[i] + LV[i + 1]) / 2; fly(new THREE.Vector3(0, y, 0), new THREE.Vector3(34, y + 30, 44)); }
  needs = true;
}
/* 카메라 이동 (짧은 보간, 과한 연출 없음) */
let tw = null;
function fly(tgt, pos, ms = 550){ tw = { t0: performance.now(), ms, a: { t: ctl.target.clone(), p: cam.position.clone() }, b: { t: tgt.clone(), p: pos.clone() } }; needs = true; }
function focus(eid){
  const o = members.get(String(eid)); if (!o) return false;
  const bb = new THREE.Box3().setFromObject(o.mesh, true); const c = bb.getCenter(new THREE.Vector3()); const sz = bb.getSize(new THREE.Vector3()).length();
  // 부재가 바라보는 바깥쪽에서 보이도록 방향 결정
  let dir;
  if (o.kind === 'CW') dir = new THREE.Vector3(0.35, 0.25, 1);
  else if (o.kind === 'WN') { const ww = o.mesh.getWorldPosition(new THREE.Vector3()); dir = Math.abs(ww.x) > 17 ? new THREE.Vector3(Math.sign(ww.x), 0.3, 0.35) : new THREE.Vector3(0.3, 0.3, -1); }
  else { const ww = o.mesh.getWorldPosition(new THREE.Vector3()); dir = Math.abs(ww.x) > 17 ? new THREE.Vector3(Math.sign(ww.x), 0.9, 0.25) : new THREE.Vector3(0.2, 0.9, Math.sign(ww.z) || 1); }
  dir.normalize();
  fly(c, c.clone().add(dir.multiplyScalar(o.kind === 'PP' ? Math.max(30, sz * 2.2) : Math.max(16, sz * 2.2))));
  return true;
}
const floorOf = eid => { const o = members.get(String(eid)); return o ? o.f : null; };

/* ---- 입력 ---- */
function visibleDeep(o){ while (o) { if (!o.visible) return false; o = o.parent; } return true; }
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); let hover = null, down = null;
function pick(e){ const r = renderer.domElement.getBoundingClientRect(); ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam); const hit = ray.intersectObjects(pickables.filter(visibleDeep), false)[0]; return hit ? hit.object : null; }
renderer.domElement.addEventListener('pointermove', e => {
  const o = pick(e); renderer.domElement.style.cursor = o ? 'pointer' : '';
  if (o !== hover) { hover = o; needs = true; }
  if (o) {
    const info = window.HJ3D_info ? window.HJ3D_info(o.userData.eid) : o.userData.mark;
    tip.innerHTML = info; tip.style.display = 'block';
    const r = renderer.domElement.getBoundingClientRect(); let x = e.clientX - r.left + 14, y = e.clientY - r.top - 8;
    if (x + 220 > r.width) x = e.clientX - r.left - 230;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  } else tip.style.display = 'none';
});
renderer.domElement.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; tw = null; });
renderer.domElement.addEventListener('pointerup', e => { if (!down) return; const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6; down = null; if (moved) return; const o = pick(e); if (o && window.HJ_openMember) window.HJ_openMember(o.userData.eid, 'from3d'); });

/* ---- 렌더 루프 (변화가 있을 때만) ---- */
let needs = true;
function resize(){ const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); needs = true; }
new ResizeObserver(resize).observe(host); resize();
ctl.addEventListener('change', () => { needs = true; });
const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
(function loop(){
  requestAnimationFrame(loop);
  if (tw) { const k = Math.min(1, (performance.now() - tw.t0) / tw.ms), e = ease(k); ctl.target.lerpVectors(tw.a.t, tw.b.t, e); cam.position.lerpVectors(tw.a.p, tw.b.p, e); needs = true; if (k >= 1) tw = null; }
  const moved = ctl.update();
  if (needs || moved) { renderer.render(scene, cam); needs = false; }
})();

window.HJ3D = { update, setFloor, focus, floorOf, home: () => { fly(HOME.tgt, HOME.pos); }, get floor(){ return cur.floor; } };
window.dispatchEvent(new Event('hj3d-ready'));
