// SPDX-License-Identifier: Apache-2.0
//
// The compiled Keeproxy contract and its witnesses, with no node:* imports, so
// the browser app and the Node tools share it. index.ts adds the file path of
// the proving keys for Node.

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';

export {
  Contract,
  ledger,
  pureCircuits,
  Phase,
  Role,
  type Mandate,
  type Witnesses,
  type Ledger,
  type ImpureCircuits,
  type PureCircuits,
} from './managed/proxy/contract/index.js';
import { Contract } from './managed/proxy/contract/index.js';
import { witnesses } from './witnesses.js';
export { witnesses, emptyPrivateState, type KeeproxyPrivateState } from './witnesses.js';

/** The contract with its witnesses; `assets` is where services that read files find the keys. */
export const compiledKeeproxy = (assets: string) =>
  CompiledContract.make('KeeproxyContract', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(assets),
  );
