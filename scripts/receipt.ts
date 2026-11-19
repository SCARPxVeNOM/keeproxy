// SPDX-License-Identifier: Apache-2.0
// Print an indexer-built receipt for one transaction:  npm run receipt -- <tx hash>
import { getConfig } from '../src/config.js';
import { txReceipt } from '../src/tx-receipt.js';

const hash = process.argv[2];
if (!hash) throw new Error('usage: npm run receipt -- <tx hash>');
console.log(JSON.stringify(await txReceipt(getConfig().indexer, hash), null, 2));
