import 'server-only';

import { type Address, createClient, type Instruction, type KeyPairSigner, type Signature } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToCheckedInstruction } from '@solana-program/token';
import { and, count, eq, gt, min, sql } from 'drizzle-orm';
import { addresses } from '@laterite/devnet/addresses';
import { type Database, faucetGrants } from '@laterite/db/database';

import { DOLLAR } from './onboarding';
import { signerFromEnv } from './signer';

/** What one grant mints of each devnet stablecoin: $100 of test USDC and $100 of test USDT. */
export const FAUCET_AMOUNT = 100n * DOLLAR;

/** The window the limits count grants in. */
export const FAUCET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Grants per wallet and per requesting address within the window. */
export const FAUCET_LIMITS = { ip: 3, wallet: 1 } as const;

/** The stand-ins the faucet mints: the devnet USDC and USDT of `@laterite/devnet`, whose mint authority it holds. */
const STABLES = ['USDC', 'USDT'] as const;

/** Serializes grants, so two requests never both pass the count. */
const FAUCET_LOCK = 0x6661_7563;

/** Reads `FAUCET_KEYPAIR`, the devnet faucet's key. */
export const faucetSigner = (env: NodeJS.ProcessEnv = process.env) => signerFromEnv('FAUCET_KEYPAIR', env);

/** The faucet's instructions: the wallet's USDC and USDT accounts unless they exist, then $100 minted into each. */
export async function faucetInstructions(faucet: KeyPairSigner, wallet: Address): Promise<Instruction[]> {
    const instructions: Instruction[] = [];
    for (const symbol of STABLES) {
        const { decimals, mint, tokenProgram } = addresses.tokens[symbol];
        const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint,
            owner: wallet,
            payer: faucet,
            tokenProgram,
        });
        const [, account] = create.accounts;
        instructions.push(
            create,
            getMintToCheckedInstruction(
                { amount: FAUCET_AMOUNT, decimals, mint, mintAuthority: faucet, token: account.address },
                { programAddress: tokenProgram },
            ),
        );
    }
    return instructions;
}

/** Sends the faucet's transaction through `SOLANA_RPC_URL` (and `SOLANA_WS_URL`), the faucet paying, and confirms it. */
export async function sendFaucet(faucet: KeyPairSigner, wallet: Address, env = process.env): Promise<Signature> {
    const rpcUrl = env.SOLANA_RPC_URL;
    if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not set');
    const client = createClient({ payer: faucet }).use(
        solanaRpc({ rpcSubscriptionsUrl: env.SOLANA_WS_URL, rpcUrl, transactionConfig: { version: 0 } }),
    );
    const result = await client.sendTransaction(await faucetInstructions(faucet, wallet));
    return result.context.signature;
}

/** A grant reserved for a wallet, or when it may ask again. */
export type Reservation = { id: number } | { retryAfterSeconds: number };

/**
 * Reserves a grant for `wallet` from `ip` unless the wallet or the address already had its grants within the window;
 * the reservation counts at once, so concurrent requests cannot both pass, and is released if the mint fails.
 */
export async function reserveGrant(
    db: Database,
    wallet: Address,
    ip: string | null,
    now = new Date(),
): Promise<Reservation> {
    return db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${FAUCET_LOCK})`);
        const since = new Date(now.getTime() - FAUCET_WINDOW_MS);
        const recent = (key: 'ip' | 'wallet', value: string) =>
            tx
                .select({ count: count(), oldest: min(faucetGrants.grantedAt) })
                .from(faucetGrants)
                .where(and(eq(faucetGrants[key], value), gt(faucetGrants.grantedAt, since)));
        for (const [key, value] of [
            ['wallet', wallet],
            ['ip', ip],
        ] as const) {
            if (value === null) continue;
            const [{ count: grants, oldest }] = await recent(key, value);
            if (grants >= FAUCET_LIMITS[key]) {
                const retry = oldest!.getTime() + FAUCET_WINDOW_MS - now.getTime();
                return { retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };
            }
        }
        const [{ id }] = await tx
            .insert(faucetGrants)
            .values({ grantedAt: now, ip, wallet })
            .returning({ id: faucetGrants.id });
        return { id };
    });
}

/** Records the landed mint of a reservation, or releases a reservation whose mint failed. */
export async function settleGrant(db: Database, id: number, signature: Signature | null) {
    if (signature) await db.update(faucetGrants).set({ signature }).where(eq(faucetGrants.id, id));
    else await db.delete(faucetGrants).where(eq(faucetGrants.id, id));
}
