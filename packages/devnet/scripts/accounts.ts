import { findAssociatedTokenPda } from '@solana-program/token-2022';

import { addresses } from '../src/addresses';

const { cpmm, issuer, pools, tokens, treasury } = addresses;
const inventory = await Promise.all(
    Object.values(tokens).map(async ({ mint, tokenProgram }) => {
        const [account] = await findAssociatedTokenPda({ mint, owner: treasury, tokenProgram });
        return account;
    }),
);

console.log(
    [
        issuer,
        treasury,
        cpmm.ammConfig,
        ...Object.values(tokens).flatMap(({ mint, supportMint }) => (supportMint ? [mint, supportMint] : [mint])),
        ...Object.values(pools).flatMap(pool => [
            pool.address,
            pool.lpMint,
            pool.observation,
            pool.token0Vault,
            pool.token1Vault,
        ]),
        ...inventory,
    ].join(' '),
);
