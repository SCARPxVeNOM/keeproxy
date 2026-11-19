// SPDX-License-Identifier: Apache-2.0
//
// The compiled Keeproxy contract, its witnesses and the zk-config path, in one
// place for the deploy script, the tests and the agent.

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(currentDir, 'managed', 'proxy');

export const CompiledKeeproxyContract = CompiledContract.make('KeeproxyContract', Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);
