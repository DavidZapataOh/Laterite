import { writeFile } from 'node:fs/promises';

import { createSolanaRpc } from '@solana/kit';

import { createClient } from '../src/client';
import { fetchUsdPrices, poolTargets } from '../src/prices';
import { ensureAssets, loadSetupKeys } from '../src/setup';

const client = createClient();
const mainnetRpc = createSolanaRpc(process.env.SURFPOOL_DATASOURCE_RPC_URL ?? 'https://api.mainnet-beta.solana.com');
const addresses = await ensureAssets(
    { client, keys: await loadSetupKeys(), mainnetRpc },
    poolTargets(await fetchUsdPrices()),
);
await writeFile(new URL('../addresses.json', import.meta.url), `${JSON.stringify(addresses, null, 4)}\n`);
console.log(`✓ Devnet assets ready (${client.sentCount()} transactions sent)`);
