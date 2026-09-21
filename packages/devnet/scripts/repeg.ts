import { addresses } from '../src/addresses';
import { POOLS, poolName } from '../src/assets';
import { createClient } from '../src/client';
import { loadSigner } from '../src/keys';
import { fetchUsdPrices, poolTargets } from '../src/prices';
import { repeg } from '../src/repeg';

const client = createClient();
const treasury = await loadSigner('devnet-treasury');
const targets = poolTargets(await fetchUsdPrices());

for (const { base, quote } of POOLS) {
    const pool = poolName(base, quote);
    const signature = await repeg({ addresses, client, pool, targetPrice: targets[pool], treasury });
    console.log(signature ? `✓ ${pool} re-pegged to ${targets[pool]}: ${signature}` : `✓ ${pool} in band`);
}
