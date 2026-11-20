// SPDX-License-Identifier: Apache-2.0
//
// Registers scripts/dev-wallet.ts as a DApp Connector wallet in this page, so
// the wallet app can be tested end to end before a browser wallet has synced.
//
// Only on a local host, and only when the page is opened with
// ?devwallet=<port>: the hosted site never shows it.

import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { zkProvider } from './vault';

export function installDevWallet() {
  const port = new URLSearchParams(location.search).get('devwallet');
  if (!port || !/^\d{2,5}$/.test(port) || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  const base = `http://127.0.0.1:${port}`;

  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${base}${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const j = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `dev wallet: HTTP ${r.status}`);
    return j;
  };
  const big = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, BigInt(v)]));
  const unsupported = (name: string) => () => Promise.reject(new Error(`The dev wallet does not implement ${name}`));

  type Info = {
    name: string;
    networkId: string;
    configuration: { indexerUri: string; indexerWsUri: string; substrateNodeUri: string; networkId: string };
    unshieldedAddress: string;
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  };
  type Balances = { unshielded: Record<string, string>; shielded: Record<string, string>; dust: string; dustCap: string };

  const connected = (info: Info): ConnectedAPI =>
    ({
      getConfiguration: async () => info.configuration,
      getConnectionStatus: async () => ({ status: 'connected', networkId: info.networkId }),
      getShieldedAddresses: async () => ({
        shieldedAddress: info.shieldedAddress,
        shieldedCoinPublicKey: info.shieldedCoinPublicKey,
        shieldedEncryptionPublicKey: info.shieldedEncryptionPublicKey,
      }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: info.unshieldedAddress }),
      getUnshieldedBalances: async () => big((await call<Balances>('/balances')).unshielded),
      getShieldedBalances: async () => big((await call<Balances>('/balances')).shielded),
      getDustBalance: async () => {
        const b = await call<Balances>('/balances');
        return { balance: BigInt(b.dust), cap: BigInt(b.dustCap) };
      },
      balanceUnsealedTransaction: (tx: string) => call<{ tx: string }>('/balance', { tx }),
      submitTransaction: async (tx: string) => {
        await call('/submit', { tx });
      },
      // Proofs go to the local proof server through the bridge. A real wallet
      // gets its key material from the page; this one fetches the same pinned set.
      getProvingProvider: async () => httpClientProvingProvider(`${base}/prover`, zkProvider()),
      hintUsage: async () => undefined,
      getDustAddress: unsupported('getDustAddress'),
      getTxHistory: unsupported('getTxHistory'),
      balanceSealedTransaction: unsupported('balanceSealedTransaction'),
      makeTransfer: unsupported('makeTransfer'),
      makeIntent: unsupported('makeIntent'),
      signData: unsupported('signData'),
    }) as unknown as ConnectedAPI;

  const initial: InitialAPI = {
    rdns: 'local.keeproxy.dev-wallet',
    name: 'Keeproxy dev wallet (local)',
    icon: '',
    apiVersion: '4.1.0',
    connect: async (networkId: string) => {
      const info = await call<Info>('/info');
      if (info.networkId !== networkId) throw new Error(`The dev wallet is on ${info.networkId}, not ${networkId}`);
      return connected(info);
    },
  };
  const g = globalThis as { midnight?: Record<string, InitialAPI> };
  (g.midnight ??= {})['keeproxy-dev'] = initial;
}
