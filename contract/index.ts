// SPDX-License-Identifier: Apache-2.0
//
// The compiled Keeproxy contract, its witnesses and the zk-config path, in one
// place for the deploy script, the tests and the agent. The browser imports
// core.ts instead.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiledKeeproxy } from './core.js';

export * from './core.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(currentDir, 'managed', 'proxy');

export const CompiledKeeproxyContract = compiledKeeproxy(zkConfigPath);
