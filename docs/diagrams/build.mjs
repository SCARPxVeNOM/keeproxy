// Builds the Excalidraw scenes in docs/diagrams/*.excalidraw from the layouts
// below. Open any .excalidraw file at https://excalidraw.com to edit it; run
// `npm run diagrams` to rebuild the scenes and re-render the PNGs.
//
//   node docs/diagrams/build.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));

// Excalidraw's own palette: [stroke, fill]
const C = {
  ink: ['#1e1e1e', 'transparent'],
  blue: ['#1971c2', '#a5d8ff'],
  green: ['#2f9e44', '#b2f2bb'],
  red: ['#e03131', '#ffc9c9'],
  amber: ['#f08c00', '#ffec99'],
  violet: ['#6741d9', '#d0bfff'],
  cyan: ['#0c8599', '#99e9f2'],
  grey: ['#868e96', '#e9ecef'],
};
const HAND = 1; // Virgil
const MONO = 3; // Cascadia

function scene() {
  let n = 0;
  const els = [];
  const id = (p) => `${p}${++n}`;
  const seed = () => Math.floor(Math.random() * 2 ** 31);
  const base = (type, x, y, w, h, o = {}) => ({
    id: o.id ?? id(type[0]),
    type, x, y, width: w, height: h, angle: 0,
    strokeColor: o.stroke ?? C.ink[0], backgroundColor: o.fill ?? 'transparent',
    fillStyle: o.fillStyle ?? 'solid', strokeWidth: o.strokeWidth ?? 2,
    strokeStyle: o.dashed ? 'dashed' : 'solid', roughness: o.roughness ?? 1, opacity: 100,
    groupIds: o.groupIds ?? [], frameId: null,
    roundness: type === 'rectangle' ? { type: 3 } : type === 'arrow' || type === 'line' ? { type: 2 } : null,
    seed: seed(), version: 1, versionNonce: seed(), isDeleted: false, boundElements: [],
    updated: 1, link: null, locked: false,
  });
  const measure = (s, size, font) => {
    const lines = s.split('\n');
    const k = font === MONO ? 0.6 : 0.56;
    return { w: Math.max(...lines.map((l) => l.length)) * size * k, h: lines.length * size * 1.25 };
  };

  /** Free text. `x` is the left edge, or the centre with align: 'center'. */
  const text = (x, y, s, o = {}) => {
    const size = o.size ?? 18, font = o.font ?? HAND;
    const { w, h } = measure(s, size, font);
    const align = o.align ?? 'left';
    const el = {
      ...base('text', align === 'center' ? x - w / 2 : x, y, w, h, { stroke: o.color ?? C.ink[0], groupIds: o.groupIds }),
      text: s, originalText: s, fontSize: size, fontFamily: font, textAlign: align, verticalAlign: 'top',
      containerId: null, lineHeight: 1.25, baseline: Math.round(h - size * 0.3),
    };
    els.push(el);
    return el;
  };

  /** A box with a centred label; returns its geometry for arrows. */
  const box = (x, y, w, h, label, o = {}) => {
    const [stroke, fill] = C[o.c ?? 'ink'];
    const g = id('g');
    const shape = o.shape ?? 'rectangle';
    const el = base(shape, x, y, w, h, {
      stroke, fill: o.fill === false ? 'transparent' : (o.fillColor ?? fill),
      dashed: o.dashed, groupIds: [g], fillStyle: o.fillStyle,
    });
    els.push(el);
    if (label) {
      const size = o.size ?? 18, font = o.font ?? HAND;
      const { h: th } = measure(label, size, font);
      const top = o.top ? y + 14 : y + (h - th) / 2;
      text(o.alignLeft ? x + 16 : x + w / 2, top, label, {
        size, font, align: o.alignLeft ? 'left' : 'center', color: o.textColor ?? C.ink[0], groupIds: [g],
      });
    }
    return { el, x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  };

  const side = (b, s) => ({
    t: [b.cx, b.y], b: [b.cx, b.y + b.h], l: [b.x, b.cy], r: [b.x + b.w, b.cy],
  })[s];

  /**
   * An arrow through absolute points. `from`/`to` may be boxes (with
   * `fromSide`/`toSide`) and are bound so the arrow follows them in the editor.
   */
  const arrow = (pts, o = {}) => {
    const [stroke] = C[o.c ?? 'ink'];
    const [x0, y0] = pts[0];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const el = {
      ...base('arrow', x0, y0, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
        stroke, dashed: o.dashed, strokeWidth: o.strokeWidth ?? 2,
      }),
      points: pts.map(([x, y]) => [x - x0, y - y0]),
      lastCommittedPoint: null,
      startBinding: o.from ? { elementId: o.from.el.id, focus: 0, gap: 4 } : null,
      endBinding: o.to ? { elementId: o.to.el.id, focus: 0, gap: 4 } : null,
      startArrowhead: o.both ? 'arrow' : null,
      endArrowhead: o.head === false ? null : 'arrow',
    };
    if (o.from) o.from.el.boundElements.push({ type: 'arrow', id: el.id });
    if (o.to) o.to.el.boundElements.push({ type: 'arrow', id: el.id });
    els.push(el);
    if (o.label) {
      const [lx, ly] = o.labelAt ?? [(pts[0][0] + pts.at(-1)[0]) / 2, (pts[0][1] + pts.at(-1)[1]) / 2];
      text(lx, ly, o.label, { size: o.labelSize ?? 16, align: o.labelAlign ?? 'center', color: o.labelColor ?? stroke, font: o.labelFont });
    }
    return el;
  };
  const link = (a, as, b, bs, o = {}) => arrow([side(a, as), ...(o.via ?? []), side(b, bs)], { ...o, from: a, to: b });

  const line = (pts, o = {}) => {
    const [x0, y0] = pts[0];
    const el = {
      ...base('line', x0, y0, 0, 0, { stroke: C[o.c ?? 'grey'][0], dashed: o.dashed, strokeWidth: o.strokeWidth ?? 1 }),
      points: pts.map(([x, y]) => [x - x0, y - y0]), lastCommittedPoint: null,
      startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
    };
    els.push(el);
    return el;
  };

  const save = (name) => {
    const doc = {
      type: 'excalidraw', version: 2, source: 'https://github.com/SCARPxVeNOM/keeproxy',
      elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {},
    };
    writeFileSync(join(OUT, `${name}.excalidraw`), JSON.stringify(doc, null, 1) + '\n');
    console.log(`${name}.excalidraw  ${els.length} elements`);
  };
  return { text, box, arrow, link, line, side, save };
}

// ------------------------------------------------------- 1. architecture

{
  const s = scene();
  s.text(0, 0, 'Keeproxy: who holds what', { size: 36 });
  s.text(0, 50, 'Every secret stays on the device that owns it. The chain only ever sees hashes, roots, nullifiers and rules.', { size: 18, color: C.grey[0] });

  s.text(0, 100, 'DEVICES  ·  private state', { size: 16, color: C.violet[0], font: MONO });
  const devs = [
    ['Owner laptop', 'owner secret sk\nbackup (before split)'],
    ['AI agent\n(Claude via MCP)', 'agent secret\nmandate terms'],
    ['3 guardians', 'guardian secret\none backup share'],
    ['New phone', 'new owner secret\nX25519 device key'],
    ['2 heirs', 'heir secret\nprivate share (bps)'],
  ];
  const devBoxes = devs.map(([t, d], i) => {
    const b = s.box(i * 285, 130, 255, 130, null, { c: 'violet' });
    s.text(b.cx, b.y + 14, t, { size: 20, align: 'center' });
    s.text(b.cx, b.y + 72, d, { size: 15, align: 'center', font: MONO, color: C.violet[0] });
    return b;
  });

  const svc = s.box(0, 360, 1395, 120,
    'keeproxyd  ·  VaultService\nacts as exactly one device per call  ·  witnesses supply secrets, Merkle paths, epoch & share maths\nrestore.ts: AES-256-GCM backups  ·  Shamir k-of-n over GF(256)  ·  X25519 + HKDF sealing',
    { c: 'blue', size: 17 });
  devBoxes.forEach((b, i) => s.arrow([[b.cx, b.y + b.h], [b.cx, svc.y]], { from: b, to: svc, c: 'violet', label: i === 0 ? 'act as this device' : undefined, labelAt: [b.cx + 12, 290], labelAlign: 'left' }));

  const ui = s.box(1480, 360, 300, 120, 'Console (React)\nguided acts\non-chain receipts', { c: 'cyan' });
  s.link(ui, 'l', svc, 'r', { c: 'cyan', label: '/api/act', labelAt: [1437, 385] });

  const prover = s.box(0, 590, 420, 110, 'Proof server\nprivate inputs + circuit → zk-SNARK', { c: 'amber' });
  const node = s.box(490, 590, 420, 110, 'Midnight node\nchecks proof against the\nverifier key stored on chain', { c: 'green' });
  const idx = s.box(980, 590, 415, 110, 'Indexer (GraphQL)\nblocks · contract state · transactions', { c: 'cyan' });
  s.arrow([[210, 480], [210, 590]], { from: svc, to: prover, c: 'amber', both: true, label: 'witnesses → proof', labelAt: [225, 522], labelAlign: 'left' });
  s.arrow([[700, 480], [700, 590]], { from: svc, to: node, c: 'green', label: 'tx carrying the proof', labelAt: [715, 522], labelAlign: 'left' });

  const ledger = s.box(0, 810, 1395, 230, null, { c: 'grey', dashed: true, fillColor: '#f8f9fa' });
  s.text(20, 826, 'PUBLIC LEDGER  ·  contract/proxy.compact  ·  what the chain sees', { size: 16, font: MONO, color: C.grey[0] });
  s.text(20, 862,
    'ownerKey = H("owner" || sk || vault)   lastSeen   phase   balance\n' +
    'guardians · heirs · mandates · payees   →   Merkle roots (depth 5)\n' +
    'approvalNullifiers · releasedShares · heirClaims   (scoped per round)\n' +
    'epochSpend[ H("spend" || salt || epoch) ]   mandateGeneration\n' +
    'backupDigest · backupVersion   threshold · inactivity · veto (sealed)',
    { size: 15, font: MONO });
  const never = s.box(940, 850, 430, 170,
    'Never on chain\nwho the guardians, heirs and agent are\ncaps · expiry · allowlist\nheir shares (until claimed)\nbackup contents, key and shares',
    { c: 'red', size: 16 });
  void never;
  s.arrow([[700, 700], [700, 810]], { from: node, to: ledger, c: 'green', label: 'apply only if every proof verifies', labelAt: [715, 742], labelAlign: 'left' });
  s.arrow([[1187, 810], [1187, 700]], { from: ledger, to: idx, c: 'cyan', label: 'index', labelAt: [1200, 742], labelAlign: 'left' });
  s.arrow([[1395, 645], [1630, 645], [1630, 480]], { from: idx, to: ui, c: 'cyan', label: 'what the chain sees\n+ receipts', labelAt: [1665, 560], labelAlign: 'left' });
  s.save('architecture');
}

// ------------------------------------------------------ 2. lifecycle

{
  const s = scene();
  s.text(0, 0, 'Vault lifecycle', { size: 36 });
  s.text(0, 50, 'Three phases. Every edge is a circuit; every guard is an assert inside a zero-knowledge proof.', { size: 18, color: C.grey[0] });

  const A = s.box(420, 330, 280, 130, 'ACTIVE', { c: 'blue', shape: 'ellipse', size: 30 });
  const R = s.box(1120, 330, 300, 130, 'RECOVERING', { c: 'amber', shape: 'ellipse', size: 30 });
  const I = s.box(770, 760, 280, 130, 'INHERITED', { c: 'violet', shape: 'ellipse', size: 30 });

  const start = s.box(240, 380, 30, 30, null, { c: 'ink', shape: 'ellipse', fillColor: '#1e1e1e' });
  s.link(start, 'r', A, 'l', { label: 'deploy', labelAt: [345, 350] });

  s.arrow([[560, 330], [560, 200], [1270, 200], [1270, 330]], { from: A, to: R, c: 'amber' });
  s.text(915, 120, 'openRecovery   (guardian proves membership)\nround += 1 · approvals := 1 · records new owner key + device key', { size: 16, align: 'center', color: C.amber[0] });

  s.arrow([[1120, 380], [700, 380]], { from: R, to: A, c: 'green' });
  s.text(910, 250, 'finalizeRecovery\napprovals ≥ k  ∧  now ≥ openedAt + veto\nownerKey := pendingOwner · mandateGeneration += 1', { size: 16, align: 'center', color: C.green[0] });

  s.arrow([[1160, 450], [910, 540], [690, 445]], { from: R, to: A, c: 'red', dashed: true });
  s.text(910, 555, 'heartbeat from the real owner = veto\napprovals := 0, the recovery is dead', { size: 16, align: 'center', color: C.red[0] });

  s.arrow([[520, 460], [520, 825], [770, 825]], { from: A, to: I, c: 'violet' });
  s.text(240, 650, 'triggerInheritance\nnow ≥ lastSeen + inactivity\nestate := balance\nmandateGeneration += 1', { size: 16, color: C.violet[0] });
  s.arrow([[1300, 460], [1300, 825], [1050, 825]], { from: R, to: I, c: 'violet', dashed: true });
  s.text(1320, 650, 'owner silent past inactivity:\ninheritance wins over a\npending recovery', { size: 16, color: C.violet[0] });

  s.box(0, 300, 210, 190, 'owner\nheartbeat · deposit\nwithdraw · enroll\nanchorBackup\nrevokeMandates\n\nagent\nagentPay', { c: 'blue', size: 15, font: MONO, fill: false, dashed: true });
  s.box(1480, 300, 330, 190, 'approveRecovery\nfresh nullifier\nH("approve"||sk||round||vault)\napprovals += 1\n\nagentPay frozen', { c: 'amber', size: 15, font: MONO, fill: false, dashed: true });
  s.box(1080, 920, 380, 120, 'claimInheritance  (once per heir)\nreleaseShare  (DISCLOSE)\ndeposit / heartbeat refused', { c: 'violet', size: 15, font: MONO, fill: false, dashed: true });
  s.save('lifecycle');
}

// ------------------------------------------------------ 3. delegate

{
  const s = scene();
  s.text(0, 0, 'DELEGATE: one agentPay proof', { size: 36 });
  s.text(0, 50, 'The agent proves every term of a mandate the chain has never seen. Any failed check means no proof, so no transaction.', { size: 18, color: C.grey[0] });

  const priv = s.box(0, 120, 420, 250,
    'PRIVATE  (witnesses, never published)\n\nagent secret sk\nmandate m = {\n  agentPk, capPerEpoch,\n  epochSeconds E, expiresAt,\n  generation, salt }\nMerkle paths for H(m) and the payee\nepoch index e',
    { c: 'violet', size: 16, font: MONO, alignLeft: true, top: true });
  const pub = s.box(0, 410, 420, 130, 'PUBLIC  (in the transaction)\n\nrecipient · amount a · now', { c: 'grey', size: 16, font: MONO, alignLeft: true, top: true });

  const checks = [
    ['now ≤ blockTime < now + 900', 'Timestamp is stale / in the future'],
    ['H(m) is a leaf of the mandates root', 'Mandate is not enrolled'],
    ['m.agentPk = H("agent" || sk || vault)', "Caller is not this mandate's agent"],
    ['m.generation = mandateGeneration', 'Mandate was revoked'],
    ['now < m.expiresAt', 'Mandate has expired'],
    ['Commit(recipient; m.salt) ∈ payees root', 'Recipient is not on the allowlist'],
    ['e·E ≤ now < (e+1)·E', 'Wrong epoch index'],
    ['spent[H("spend"||salt||e)] + a ≤ cap', "Payment exceeds the mandate's cap"],
    ['balance ≥ a', 'Insufficient vault balance'],
  ];
  let prev = null;
  checks.forEach(([c, err], i) => {
    const y = 120 + i * 92;
    const b = s.box(520, y, 470, 64, `${i + 1}.  ${c}`, { c: 'blue', size: 16, font: MONO });
    if (prev) s.link(prev, 'b', b, 't', { c: 'blue' });
    s.arrow([[990, y + 32], [1080, y + 32]], { c: 'red', dashed: true });
    s.text(1092, y + 20, err, { size: 15, color: C.red[0] });
    prev = b;
  });
  s.arrow([[420, 265], [520, 265]], { from: priv, c: 'violet' });
  s.arrow([[420, 515], [520, 515]], { from: pub, c: 'grey' });

  const eff = s.box(520, 980, 470, 130, 'all pass → proof → transaction\n\nepochSpend[key] += a\nbalance −= a\nsendUnshielded(a → recipient)', { c: 'green', size: 16, font: MONO });
  s.link(prev, 'b', eff, 't', { c: 'green' });
  s.box(1080, 980, 420, 130, 'The chain learns: a valid mandate paid a\nto recipient this epoch.\nNot which agent, the cap, the expiry,\nor anything else on the allowlist.', { c: 'amber', size: 16 });
  s.save('delegate');
}

// ------------------------------------------------ 4. recover & restore

{
  const s = scene();
  s.text(0, 0, 'RECOVER + RESTORE: losing the laptop', { size: 36 });
  s.text(0, 50, 'Guardians move the vault to a new phone after a veto window, then hand back the backup key, sealed to that phone only.', { size: 18, color: C.grey[0] });

  const lanes = [['Owner laptop', 'violet', 160], ['Guardians g0 g1 g2', 'amber', 560], ['Chain', 'green', 960], ['New phone', 'cyan', 1360]];
  const TOP = 110, BOTTOM = 1290;
  for (const [t, c, x] of lanes) {
    s.box(x - 150, TOP, 300, 60, t, { c, size: 20 });
    s.line([[x, TOP + 60], [x, BOTTOM]], { c, dashed: true, strokeWidth: 2 });
  }
  const X = Object.fromEntries(lanes.map(([t, , x]) => [t.split(' ')[0], x]));
  let y = 220;
  const step = (n, from, to, label, o = {}) => {
    const a = X[from], b = X[to];
    if (a === b) {
      s.box(a - 215, y - 6, 430, o.h ?? 58, `${n}. ${label}`, { c: o.c ?? 'grey', size: 15, font: o.font ?? HAND, fill: o.fill });
    } else {
      s.arrow([[a, y + 26], [b, y + 26]], { c: o.c ?? 'ink', dashed: o.dashed });
      s.text((a + b) / 2, y - 8, `${n}. ${label}`, { size: 15, align: 'center', color: C[o.c ?? 'ink'][0], font: o.font });
    }
    y += o.gap ?? 82;
  };
  step(1, 'Owner', 'Owner', 'blob = AES-GCM(K, state, aad = "v1")\nd = SHA-256(blob)', { c: 'violet', font: MONO, h: 62 });
  step(2, 'Owner', 'Chain', 'anchorBackup(d, version 1)', { c: 'violet' });
  step(3, 'Owner', 'Guardians', 'Shamir: s_i = f(i), f(0) = K  (off chain)', { c: 'violet' });
  step(4, 'Owner', 'Owner', 'laptop lost or stolen  ✗', { c: 'red' });
  step(5, 'New', 'New', "new owner secret sk'\nX25519 device key pk_dev", { c: 'cyan', font: MONO, h: 62 });
  step(6, 'Guardians', 'Chain', "g0: openRecovery(H(owner||sk'||vault), pk_dev)", { c: 'amber' });
  step(7, 'Guardians', 'Chain', 'g1: approveRecovery  · nullifier H(approve||sk||r||vault)', { c: 'amber' });
  step(8, 'Chain', 'Chain', 'veto window: a heartbeat\nfrom the old key would cancel', { c: 'red', h: 62 });
  step(9, 'Guardians', 'Chain', 'finalizeRecovery: ownerKey := pending, mandates revoked', { c: 'green' });
  step(10, 'Guardians', 'Chain', 'g0, g1: releaseShare( Seal(pk_dev, s_i) )', { c: 'amber' });
  step(11, 'Chain', 'New', 'read sealed shares, d, version', { c: 'cyan' });
  step(12, 'New', 'New', 'open seals → K = Σ λ_i s_i\ncheck SHA-256(blob) = d, then decrypt', { c: 'cyan', font: MONO, h: 62 });
  step(13, 'Owner', 'Chain', 'thief: heartbeat  →  "Only the owner can do this"', { c: 'red', dashed: true });
  s.save('recover-restore');
}

// ------------------------------------------------------- 5. inherit

{
  const s = scene();
  s.text(0, 0, 'INHERIT + DISCLOSE: silence, then private shares', { size: 36 });
  s.text(0, 50, 'Anyone may trigger once the owner has been silent long enough. Each heir proves a share the chain never saw, and is paid once.', { size: 18, color: C.grey[0] });

  s.arrow([[0, 260], [1500, 260]], { c: 'ink', strokeWidth: 3 });
  s.text(1460, 275, 'time', { size: 16, color: C.grey[0] });
  const tick = (x, label, c) => {
    s.line([[x, 240], [x, 280]], { c, strokeWidth: 3 });
    s.text(x, 140, label, { size: 16, align: 'center', color: C[c][0] });
  };
  tick(80, 'lastSeen\n(heartbeat)', 'blue');
  tick(700, 'lastSeen + inactivity\n(trigger allowed)', 'violet');
  tick(980, 'triggerInheritance\nestate := balance', 'violet');
  s.arrow([[380, 300], [100, 300]], { c: 'blue', dashed: true });
  s.text(400, 288, 'a heartbeat before the deadline resets the clock', { size: 15, color: C.blue[0] });
  s.box(160, 205, 480, 30, 'trigger refused: "Owner is still active"', { c: 'red', size: 14, fill: false });

  const claim = s.box(560, 380, 560, 210,
    'claimInheritance  (per heir)\n\nleaf = Commit(bps; H("heir"||sk||vault)) ∈ heirs root\nnullifier H("claim"||sk||vault) not yet used\nq = floor(estate · bps / 10000)\nchecked: q·10000 ≤ estate·bps < (q+1)·10000\nestatePaid + q ≤ estate',
    { c: 'violet', size: 15, font: MONO });
  s.arrow([[980, 290], [980, 380]], { to: claim, c: 'violet' });

  const ex = s.box(0, 380, 470, 210, 'Example: estate 1000\n\nheir 0 · 60.00%  →  600\nheir 1 · 40.00%  →  400\n\nestate 1001 at 33.33/33.33/33.34%\n→ 333 + 333 + 333, dust 2 stays', { c: 'green', size: 16, font: MONO });
  void ex;
  s.box(1200, 380, 330, 210, 'DISCLOSE\n\nguardians releaseShare\nsealed document keys\nown round: once each\neven after RESTORE', { c: 'amber', size: 16 });
  s.box(560, 640, 560, 90, 'over-allocated shares can never overpay: the second claim\nthat would exceed the estate is refused', { c: 'red', size: 15 });
  s.save('inherit');
}

// ------------------------------------------------------ 6. cryptography

{
  const s = scene();
  s.text(0, 0, 'The mathematics', { size: 36 });
  s.text(0, 50, 'Left: how roles become anonymous on chain. Right: how a backup survives a lost device.', { size: 18, color: C.grey[0] });

  // Left: derivations
  const sk = s.box(0, 120, 200, 70, 'sk\n(device secret)', { c: 'violet', size: 16 });
  const vid = s.box(240, 120, 200, 70, 'vault id\n(sealed, random)', { c: 'grey', size: 16 });
  const H = s.box(90, 250, 260, 60, 'persistentHash  H(tag || …)', { c: 'blue', size: 16, font: MONO });
  s.link(sk, 'b', H, 't', { c: 'violet' });
  s.link(vid, 'b', H, 't', { c: 'grey' });
  s.box(0, 360, 640, 250,
    'ownerKey      = H("owner"    || sk || vault)\nagentPk       = H("agent"    || sk || vault)\nguardianLeaf  = H("guardian" || sk || vault)\nheirLeaf      = Commit(bps ; H("heir" || sk || vault))\nmandateLeaf   = H(m)\npayeeLeaf     = Commit(recipient ; m.salt)\napproveNull   = H("approve" || sk || round || vault)\nreleaseNull   = H("release" || sk || round || vault)\nclaimNull     = H("claim"   || sk || vault)\nspendKey      = H("spend"   || salt || floor(now / E))',
    { c: 'blue', size: 15, font: MONO, alignLeft: true, fill: false });
  s.arrow([[220, 310], [220, 360]], { c: 'blue' });

  // Merkle tree
  s.text(0, 650, 'Membership: Merkle path, depth 5 (32 leaves)', { size: 18 });
  const root = s.box(250, 700, 140, 50, 'root', { c: 'green', size: 16 });
  const n1 = s.box(110, 800, 120, 46, 'h₁₂', { c: 'amber', size: 16 });
  const n2 = s.box(410, 800, 120, 46, 'h₃₄', { c: 'grey', size: 16 });
  const leaves = [['leaf₁', 'amber'], ['leaf₂', 'grey'], ['leaf₃', 'grey'], ['leaf₄', 'grey']].map(([t, c], i) =>
    s.box(30 + i * 150, 900, 110, 46, t, { c, size: 16 }));
  s.link(n1, 't', root, 'b', { c: 'green' });
  s.link(n2, 't', root, 'b', { c: 'green' });
  s.link(leaves[0], 't', n1, 'b', { c: 'amber' });
  s.link(leaves[1], 't', n1, 'b', { c: 'grey' });
  s.link(leaves[2], 't', n2, 'b', { c: 'grey' });
  s.link(leaves[3], 't', n2, 'b', { c: 'grey' });
  s.text(0, 970, 'The prover recomputes the root from its leaf and the sibling\nhashes (grey) inside the proof. The chain only checks that\nthe result is a valid root: checkRoot(root). The leaf stays hidden.', { size: 15, color: C.grey[0] });

  // Right: restore pipeline
  const X0 = 760;
  const st = s.box(X0, 120, 200, 60, 'private state', { c: 'violet', size: 16 });
  const aes = s.box(X0 + 260, 110, 340, 80, 'AES-256-GCM\nkey K, 96-bit IV\nAAD = "keeproxy:backup:v{n}"', { c: 'blue', size: 14, font: MONO });
  const blob = s.box(X0 + 660, 120, 180, 60, 'blob', { c: 'grey', size: 16 });
  const dig = s.box(X0 + 660, 230, 180, 60, 'd = SHA-256(blob)', { c: 'green', size: 14, font: MONO });
  s.link(st, 'r', aes, 'l', { c: 'violet' });
  s.link(aes, 'r', blob, 'l', { c: 'blue' });
  s.link(blob, 'b', dig, 't', { c: 'green' });
  s.text(X0 + 860, 245, 'on chain with\nversion n', { size: 15, color: C.green[0] });

  const sh = s.box(X0, 340, 840, 110,
    'Shamir over GF(2⁸), per byte:   f(x) = K + a₁x + … + a_{k−1}x^{k−1},   a_j random\nshare i = (i, f(i))   for i = 1 … n         any k shares rebuild K, k−1 reveal nothing',
    { c: 'amber', size: 15, font: MONO });
  s.arrow([[X0 + 430, 190], [X0 + 430, 340]], { c: 'amber', label: 'K', labelAt: [X0 + 445, 255], labelAlign: 'left' });

  const seal = s.box(X0, 510, 840, 130,
    'Seal to the new phone (per share):\neph ← X25519 keypair       Z = ECDH(eph, pk_dev)\nk_s = HKDF-SHA256(Z, salt = eph || pk_dev, info = "keeproxy:share")\nsealed = eph || AES-GCM(k_s, share, AAD = pk_dev)   →   releaseShare',
    { c: 'cyan', size: 15, font: MONO });
  s.link(sh, 'b', seal, 't', { c: 'cyan' });

  const open = s.box(X0, 700, 840, 140,
    'On the phone:\nopen k seals with the device key → (x_i, y_i)\nK = Σ_i y_i · Π_{j≠i} x_j / (x_j − x_i)        (Lagrange at x = 0, in GF(2⁸))\nrefuse unless SHA-256(blob) = d and version = n, then decrypt',
    { c: 'green', size: 15, font: MONO });
  s.link(seal, 'b', open, 't', { c: 'green' });
  s.box(X0, 890, 840, 100,
    'Why it is safe: a thief with the old laptop has neither k shares nor pk_dev\'s private key;\na guardian alone holds one share; the chain holds only sealed bytes and a digest.',
    { c: 'red', size: 15 });
  s.save('crypto');
}
