// SPDX-License-Identifier: Apache-2.0
//
// In-memory deploy-and-call harness for the compiled contract. Adapted from
// packages/sim in midnightntwrk/midnight-examples (Apache-2.0), with one
// addition: a controllable block clock (`sim.time`), which the inactivity,
// veto and mandate-expiry rules need.
//
// It runs the compiler's JS output with compact-runtime: no proof server, no
// node, no indexer. `npm run compile:fast` output is enough.

import {
  type ChargedState,
  type CircuitContext,
  type CircuitResults,
  type ConstructorContext,
  type ConstructorResult,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

export const SIM_COIN_PUBLIC_KEY = '00'.repeat(32);

export interface SimContract<PS> {
  initialState(context: ConstructorContext<PS>, ...args: never[]): Promise<ConstructorResult<PS>>;
  impureCircuits: object;
}

type ImpureOf<C> = C extends { impureCircuits: infer I } ? I : never;
type CircuitName<C> = keyof ImpureOf<C> & string;
type CircuitFn<C, K extends CircuitName<C>> = ImpureOf<C>[K] extends (...a: infer A) => infer R
  ? (...a: A) => R
  : never;
export type CircuitArgs<C, K extends CircuitName<C>> =
  Parameters<CircuitFn<C, K>> extends [unknown, ...infer Rest] ? Rest : never;
export type CircuitResult<C, K extends CircuitName<C>> =
  Awaited<ReturnType<CircuitFn<C, K>>> extends CircuitResults<unknown, infer R> ? R : never;
export type ConstructorArgs<C> = C extends { initialState(context: never, ...args: infer A): unknown } ? A : never;

export interface DeployOptions<C, PS, L> {
  contract: C;
  ledger: (state: ChargedState) => L;
  privateState: PS;
  args?: ConstructorArgs<C>;
  coinPublicKey?: string;
  /** Block time (unix seconds) for the constructor and the first calls. */
  time?: number;
}

export class Sim<C extends SimContract<PS>, PS, L> {
  readonly address = sampleContractAddress();
  coinPublicKey: string;
  privateState: PS;
  /** Block time (unix seconds) the next call runs at. Advance it to move the clock. */
  time: number;
  lastContext: CircuitContext<PS> | undefined;

  private state: ChargedState;

  private constructor(
    readonly contract: C,
    private readonly decode: (state: ChargedState) => L,
    state: ChargedState,
    privateState: PS,
    coinPublicKey: string,
    time: number,
  ) {
    this.state = state;
    this.privateState = privateState;
    this.coinPublicKey = coinPublicKey;
    this.time = time;
  }

  static async deploy<C extends SimContract<PS>, PS, L>(opts: DeployOptions<C, PS, L>): Promise<Sim<C, PS, L>> {
    const coinPublicKey = opts.coinPublicKey ?? SIM_COIN_PUBLIC_KEY;
    const args = (opts.args ?? []) as never[];
    const result = await opts.contract.initialState(createConstructorContext(opts.privateState, coinPublicKey), ...args);
    const time = opts.time ?? Math.floor(Date.now() / 1000);
    return new Sim(opts.contract, opts.ledger, result.currentContractState.data, result.currentPrivateState, coinPublicKey, time);
  }

  as(coinPublicKey: string): this {
    this.coinPublicKey = coinPublicKey;
    return this;
  }

  /** Moves the block clock forward. */
  advance(seconds: number): this {
    this.time += seconds;
    return this;
  }

  /** The vault's address bytes (kernel.self().bytes inside the circuits). */
  get vault(): Uint8Array {
    return Buffer.from(this.address, 'hex');
  }

  async call<K extends CircuitName<C>>(
    circuit: K,
    ...args: CircuitArgs<C, K>
  ): Promise<{ result: CircuitResult<C, K>; ledger: L }> {
    const fn = (this.contract.impureCircuits as Record<string, unknown>)[circuit];
    if (typeof fn !== 'function') throw new Error(`${circuit} is not an impure circuit of this contract`);
    const context = createCircuitContext<PS>({
      circuitId: circuit,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: this.coinPublicKey,
      contractState: this.state,
      privateState: this.privateState,
      time: this.time,
    });
    const out = await (
      fn as (ctx: CircuitContext<PS>, ...a: unknown[]) => Promise<CircuitResults<PS, CircuitResult<C, K>>>
    ).call(this.contract.impureCircuits, context, ...args);
    this.state = out.context.callContext.currentQueryContext.state;
    this.privateState = out.context.callContext.currentPrivateState as PS;
    this.lastContext = out.context;
    return { result: out.result, ledger: this.decode(this.state) };
  }

  ledger(): L {
    return this.decode(this.state);
  }
}

export async function expectRejects(fn: () => unknown, message?: string): Promise<Error> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) throw new Error(`expected a rejection${message ? ` containing "${message}"` : ''}, but the call succeeded`);
  const err = thrown instanceof Error ? thrown : new Error(String(thrown));
  if (message !== undefined && !err.message.includes(message)) {
    throw new Error(`expected a rejection containing "${message}", got: ${err.message}`);
  }
  return err;
}

// ------------------------------------------------------ privacy checks ----

export interface PublicBytes {
  label: string;
  bytes: Uint8Array;
}

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const isIterable = (v: object): v is Iterable<unknown> =>
  typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';

/** Every byte string in a decoded ledger, with the path it was found at. */
export function collectPublicBytes(ledger: unknown, root = ''): PublicBytes[] {
  const out: PublicBytes[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, label: string): void => {
    if (v instanceof Uint8Array) {
      out.push({ label, bytes: v });
      return;
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${label}[${i}]`));
      return;
    }
    if (isIterable(v)) {
      const isMap = typeof (v as { lookup?: unknown }).lookup === 'function';
      let i = 0;
      for (const entry of v) {
        if (isMap && Array.isArray(entry) && entry.length === 2) {
          walk(entry[0], `${label}[${i}].key`);
          walk(entry[1], `${label}[${i}].value`);
        } else {
          walk(entry, `${label}[${i}]`);
        }
        i++;
      }
      return;
    }
    for (const key of Object.keys(v)) {
      const field = (v as Record<string, unknown>)[key];
      if (typeof field === 'function') continue;
      walk(field, label ? `${label}.${key}` : key);
    }
  };
  walk(ledger, root);
  return out;
}

export function findInPublicState(ledger: unknown, secret: Uint8Array): string | null {
  const target = hex(secret);
  if (target.length === 0) return null;
  for (const { label, bytes } of collectPublicBytes(ledger)) {
    if (hex(bytes).includes(target)) return label;
  }
  return null;
}

export function assertNotInPublicState(ledger: unknown, secrets: Record<string, Uint8Array>): void {
  const leaks: string[] = [];
  for (const [name, bytes] of Object.entries(secrets)) {
    const field = findInPublicState(ledger, bytes);
    if (field !== null) leaks.push(`${name} found in public state at ${field}`);
  }
  if (leaks.length > 0) throw new Error(`privacy invariant broken:\n  ${leaks.join('\n  ')}`);
}
