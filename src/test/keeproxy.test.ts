// SPDX-License-Identifier: Apache-2.0
//
// Devnet end-to-end suite: deploys a real vault and runs all five powers with
// real proofs against a Midnight node, indexer and proof server.
//
//   npm run env:up        # node + indexer + proof server (compose.yml)
//   npm run test:local
//
// One wallet (ALICE) pays the fees; each role keeps its own private-state id,
// the way separate devices would. BOB's unshielded address receives the
// agent's payments and an heir payout, so NIGHT really leaves the vault.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, startWallet } from '../wallet.js';
import { buildProviders, ledgerState, type KeeproxyProviders } from '../providers.js';
import { assertNotInPublicState } from './sim.js';
import { deployStaged } from '../staged-deploy.js';
import {
  CompiledKeeproxyContract,
  Phase,
  Role,
  ledger,
  pureCircuits as pc,
  zkConfigPath,
  type KeeproxyPrivateState,
  type Ledger,
  type Mandate,
} from '../../contract/index.js';

// @ts-expect-error WebSocket global for the indexer's GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
const syncTimeoutMs = Number(process.env['MIDNIGHT_SYNC_TIMEOUT_MS'] ?? (network === 'local' ? 10 * 60_000 : 60 * 60_000));

const bytes32 = () => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A timestamp safely behind the node's clock (the contract accepts up to 15 minutes old).
const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 30);

// Short timers so the devnet run can wait them out.
const THRESHOLD = 2n;
const INACTIVITY = 150n; // seconds
const VETO = 40n; // seconds

const ID = {
  owner: 'owner-laptop',
  newOwner: 'owner-new-phone',
  agent: 'agent-runtime',
  g: ['guardian-0', 'guardian-1', 'guardian-2'],
  heir: ['heir-0', 'heir-1'],
} as const;

describe(`Keeproxy on ${network}`, () => {
  const config = getConfig();
  let alice: MidnightWalletProvider;
  let bob: MidnightWalletProvider;
  let prov: KeeproxyProviders;
  let address: ContractAddress;
  let vault: Uint8Array;
  let bobAddress: { bytes: Uint8Array };

  const vaultId = bytes32();
  const owner = bytes32();
  const newOwner = bytes32();
  const agent = bytes32();
  const guardians = [bytes32(), bytes32(), bytes32()];
  const heirs = [
    { sk: bytes32(), bps: 7000n },
    { sk: bytes32(), bps: 3000n },
  ];
  let mandate: Mandate;

  const read = async (): Promise<Ledger> =>
    ledger(ledgerState(await prov.publicDataProvider.queryContractState(address)));

  const setState = (id: string, ps: KeeproxyPrivateState) =>
    prov.privateStateProvider.forContract(address).set(id, ps);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (privateStateId: string, circuitId: any, ...args: unknown[]) =>
    submitCallTx(prov, {
      compiledContract: CompiledKeeproxyContract,
      contractAddress: address,
      privateStateId,
      circuitId,
      args,
    } as never);

  beforeAll(async () => {
    const env: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };
    alice = await startWallet(logger, env, { network, role: 'ALICE', faucet: config.faucet, syncTimeoutMs });
    bob = await startWallet(logger, env, { network, role: 'BOB', faucet: config.faucet, syncTimeoutMs });
    prov = buildProviders(alice, zkConfigPath, config);
    const bobUnshielded = await bob.wallet.unshielded.getAddress();
    bobAddress = { bytes: new Uint8Array(bobUnshielded.data) };
  });

  afterAll(async () => {
    if (alice) await alice.stop();
    if (bob) await bob.stop();
  });

  it('deploys a vault; only a hash of the owner secret is stored', async () => {
    const deployed = await deployStaged(prov, {
      privateStateId: ID.owner,
      initialPrivateState: { ownerSecret: owner },
      args: [vaultId, THRESHOLD, INACTIVITY, VETO, nowSec()],
      onProgress: ({ stage, circuit, index, total }) =>
        logger.info(`tx ${index}/${total} ${stage}${circuit ? ` ${circuit}` : ''}`),
    });
    address = deployed.contractAddress;
    logger.info(`Vault deployed at ${address} (+${deployed.insertedCircuits.length} verifier-key txs)`);
    const l = await read();
    vault = l.vaultId;
    expect(l.ownerKey).toEqual(pc.ownerKeyOf(owner, vault));
    expect(l.phase).toBe(Phase.ACTIVE);

    mandate = {
      agentPk: pc.agentKeyOf(agent, vault),
      capPerEpoch: 200n,
      epochSeconds: 604_800n,
      expiresAt: nowSec() + 30n * 86_400n,
      generation: 0n,
      salt: bytes32(),
    };
    await setState(ID.newOwner, { ownerSecret: newOwner });
    await setState(ID.agent, { agentSecret: agent, mandate });
    for (const [i, g] of guardians.entries()) await setState(ID.g[i]!, { guardianSecret: g });
    for (const [i, h] of heirs.entries()) await setState(ID.heir[i]!, { heirSecret: h.sk, heirShareBps: h.bps });
  });

  it('enrolls 3 guardians, 2 heirs, a mandate and a payee, and takes a deposit', async () => {
    for (const g of guardians) await call(ID.owner, 'enroll', Role.GUARDIAN, pc.guardianLeafOf(g, vault));
    for (const h of heirs) await call(ID.owner, 'enroll', Role.HEIR, pc.heirLeafOf(pc.heirKeyOf(h.sk, vault), h.bps));
    await call(ID.owner, 'enroll', Role.MANDATE, pc.mandateLeafOf(mandate));
    await call(ID.owner, 'enroll', Role.PAYEE, pc.payeeLeafOf(bobAddress.bytes, mandate.salt));
    await call(ID.owner, 'deposit', 1000n);
    const l = await read();
    expect(l.guardianCount).toBe(3n);
    expect(l.balance).toBe(1000n);
  });

  it('DELEGATE: the agent pays BOB within its cap, and is refused over it', async () => {
    await call(ID.agent, 'agentPay', bobAddress, 150n, nowSec());
    expect((await read()).balance).toBe(850n);
    await expect(call(ID.agent, 'agentPay', bobAddress, 51n, nowSec())).rejects.toThrow(/exceeds the mandate's cap/);
  });

  it('RESTORE: anchors a backup digest; a stale version is refused', async () => {
    await call(ID.owner, 'anchorBackup', bytes32(), 1n);
    await expect(call(ID.owner, 'anchorBackup', bytes32(), 1n)).rejects.toThrow(/Backup version must increase/);
    expect((await read()).backupVersion).toBe(1n);
  });

  it('RECOVER: two guardians rotate the owner after the veto window; the old key dies', async () => {
    await call(ID.g[0], 'openRecovery', pc.ownerKeyOf(newOwner, vault), bytes32(), nowSec());
    await expect(call(ID.g[0], 'approveRecovery')).rejects.toThrow(/already approved/);
    await call(ID.g[1], 'approveRecovery');
    await expect(call(ID.g[2], 'finalizeRecovery', nowSec())).rejects.toThrow(/Veto window is still open/);
    await sleep(Number(VETO) * 1000 + 15_000);
    await call(ID.g[2], 'finalizeRecovery', nowSec());
    const l = await read();
    expect(l.ownerKey).toEqual(pc.ownerKeyOf(newOwner, vault));
    await expect(call(ID.owner, 'heartbeat', nowSec())).rejects.toThrow(/Only the owner/);
    await expect(call(ID.agent, 'agentPay', bobAddress, 1n, nowSec())).rejects.toThrow(/Mandate was revoked/);
    await call(ID.newOwner, 'heartbeat', nowSec());
  });

  it('RESTORE: guardians release sealed shares to the new device, once each', async () => {
    await call(ID.g[0], 'releaseShare', new Uint8Array(randomBytes(48)));
    await call(ID.g[1], 'releaseShare', new Uint8Array(randomBytes(48)));
    await expect(call(ID.g[0], 'releaseShare', new Uint8Array([1]))).rejects.toThrow(/already released/);
    expect((await read()).releasedShares.size()).toBe(2n);
  });

  it('INHERIT: after the owner goes silent, heirs claim their private shares', async () => {
    await expect(call(ID.g[0], 'triggerInheritance', nowSec())).rejects.toThrow(/Owner is still active/);
    await sleep(Number(INACTIVITY) * 1000 + 40_000);
    await call(ID.g[0], 'triggerInheritance', nowSec());
    let l = await read();
    expect(l.phase).toBe(Phase.INHERITED);
    expect(l.estate).toBe(850n);
    await call(ID.heir[0], 'claimInheritance', bobAddress);
    await expect(call(ID.heir[0], 'claimInheritance', bobAddress)).rejects.toThrow(/already claimed/);
    await call(ID.heir[1], 'claimInheritance', bobAddress);
    l = await read();
    expect(l.balance).toBe(0n);
    expect(l.estatePaid).toBe(850n);
  });

  it('keeps every secret, mandate term and heir key out of the public ledger the indexer serves', async () => {
    const l = await read();
    const secrets: Record<string, Uint8Array> = {
      ownerSecret: owner,
      newOwnerSecret: newOwner,
      agentSecret: agent,
      agentPublicKey: mandate.agentPk,
      mandateSalt: mandate.salt,
    };
    guardians.forEach((g, i) => (secrets[`guardianSecret${i}`] = g));
    heirs.forEach((h, i) => {
      secrets[`heirSecret${i}`] = h.sk;
      secrets[`heirKey${i}`] = pc.heirKeyOf(h.sk, vault);
    });
    assertNotInPublicState(l, secrets);
  });
});
