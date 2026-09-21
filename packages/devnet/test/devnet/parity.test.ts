import { assertAccountExists, fetchEncodedAccount, generateKeyPairSigner } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { fetchMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import { MAINNET_MINTS, XSTOCKS } from '../../src/assets';
import { mintToInstructions, tokenBalance } from '../../src/mints';
import { client, keys, mainnetRpc } from './context';
import { mintDifferences } from './parity';

describe('stand-in mints', () => {
    it.each(XSTOCKS)('%s matches the mainnet mint except authorities', async symbol => {
        const mainnet = await fetchEncodedAccount(mainnetRpc, MAINNET_MINTS[symbol]);
        const devnet = await fetchEncodedAccount(client.rpc, keys.mints[symbol].address);
        assertAccountExists(mainnet);
        assertAccountExists(devnet);
        expect(devnet.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
        expect(mintDifferences(mainnet, devnet)).toEqual([]);
    });

    it.each(['USDC', 'USDT'] as const)('%s is a 6-decimal SPL Token mint the faucet can mint', async symbol => {
        const mint = await fetchMint(client.rpc, keys.mints[symbol].address);
        expect(mint.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
        expect(mint.data.decimals).toBe(6);
        const wallet = await generateKeyPairSigner();
        await client.send(
            keys.issuer,
            await mintToInstructions({
                amount: 25_000_000n,
                authority: keys.faucet,
                decimals: 6,
                mint: keys.mints[symbol].address,
                owner: wallet.address,
                payer: keys.issuer,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
        );
        expect(await tokenBalance(client.rpc, wallet.address, keys.mints[symbol].address, TOKEN_PROGRAM_ADDRESS)).toBe(
            25_000_000n,
        );
    });
});
