import { address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { loadSigner } from '../src/keys';

const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');

const [program, admin] = await Promise.all([loadSigner('devnet-cpmm'), loadSigner('devnet-issuer')]);
const [poolFeeReceiver] = await findAssociatedTokenPda({
    mint: WRAPPED_SOL,
    owner: admin.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

console.log(`PROGRAM_ID=${program.address}`);
console.log(`ADMIN=${admin.address}`);
console.log(`POOL_FEE_RECEIVER=${poolFeeReceiver}`);
