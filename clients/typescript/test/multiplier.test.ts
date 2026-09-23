import { type Address, lamports } from '@solana/kit';
import { createRpcFromSvm } from '@solana/kit-plugin-litesvm';
import {
    amountToUiAmountForMintWithoutSimulation,
    amountToUiAmountForScaledUiAmountMintWithoutSimulation,
    getMintDecoder,
    getMintEncoder,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { LiteSVM } from 'litesvm';
import { describe, expect, it } from 'vitest';

import { quote, scaledUiAmountMultiplier, uiTokenPrice } from '../src';
import { fixture, PYTH_SPYX_QQQX, PYTH_SPYX_QUOTE, PYTH_UPDATES_AT } from './fixtures';

const SPYX = 'Av85xasqSyE6KfyW85h1RJXBs631sExR5ncFoHhtEDnU' as Address;

describe('ScaledUiAmount', () => {
    it('applies the multiplier in force, as Token-2022 converts amounts, and prices a UI token over it', async () => {
        // The devnet SPYx stand-in replicates the mainnet mint's extensions; a new multiplier is scheduled at 100.
        const mint = getMintDecoder().decode(fixture(`devnet/${SPYX}.bin`));
        const extensions = mint.extensions.__option === 'Some' ? mint.extensions.value : [];
        const config = extensions.find(extension => extension.__kind === 'ScaledUiAmountConfig');
        expect(config).toBeDefined();
        const scheduled = { ...config!, multiplier: 1.5, newMultiplier: 2, newMultiplierEffectiveTimestamp: 100n };
        const scaled = {
            ...mint,
            extensions: {
                __option: 'Some' as const,
                value: extensions.map(extension => (extension === config ? scheduled : extension)),
            },
        };
        expect(scaledUiAmountMultiplier(scaled, 99n)).toBe(1.5);
        expect(scaledUiAmountMultiplier(scaled, 100n)).toBe(2);
        expect(scaledUiAmountMultiplier({ ...mint, extensions: { __option: 'None' } }, 0n)).toBe(1);

        const svm = new LiteSVM();
        const data = new Uint8Array(getMintEncoder().encode(scaled));
        svm.setAccount({
            address: SPYX,
            data,
            executable: false,
            lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
            programAddress: TOKEN_2022_PROGRAM_ADDRESS,
            space: BigInt(data.length),
        });
        const rpc = createRpcFromSvm(svm);
        for (const now of [99n, 100n, 101n]) {
            const clock = svm.getClock();
            clock.unixTimestamp = now;
            svm.setClock(clock);
            for (const amount of [1n, 123_456_789n, 10n ** 12n]) {
                const ours = amountToUiAmountForScaledUiAmountMintWithoutSimulation(
                    amount,
                    mint.decimals,
                    scaledUiAmountMultiplier(scaled, now),
                );
                expect(ours).toBe(await amountToUiAmountForMintWithoutSimulation(rpc, SPYX, amount));
            }
        }

        const spyx = quote(PYTH_SPYX_QQQX, 1843, PYTH_UPDATES_AT);
        expect(spyx).toEqual(PYTH_SPYX_QUOTE);
        expect(uiTokenPrice(spyx, 2)).toBeCloseTo(778.47155496 / 2, 8);
    });
});
