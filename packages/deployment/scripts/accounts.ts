import { findConfigPda, findPlanAddress } from '@laterite/client';
import { address, fixEncoderSize, getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from '@solana/kit';

import { deploymentFile, readDeploymentRecord } from '../src';

// The recorded deployment's accounts a local copy of its cluster clones besides the program: the config, the plans,
// the swap authority's accounts, the onboarding table, the sponsor (it pays onboarding), the IDL Program Metadata
// holds and the verification PDA.

const PROGRAM_METADATA = address('ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S');
const VERIFIER = address('verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC');

const record = await readDeploymentRecord(deploymentFile());
if (!record?.lookupTable) throw new Error(`No complete deployment recorded in ${deploymentFile().pathname}`);
const encoder = getAddressEncoder();
const utf8 = getUtf8Encoder();
const [[config], plans, [idl], [verification]] = await Promise.all([
    findConfigPda(),
    Promise.all([0, 1].flatMap(token => [0, 1].map(tier => findPlanAddress(token, tier)))),
    getProgramDerivedAddress({
        programAddress: PROGRAM_METADATA,
        seeds: [encoder.encode(record.program), fixEncoderSize(utf8, 16).encode('idl')],
    }),
    getProgramDerivedAddress({
        programAddress: VERIFIER,
        seeds: [utf8.encode('otter_verify'), encoder.encode(record.upgradeAuthority), encoder.encode(record.program)],
    }),
]);
const { swapAccounts } = record;
console.log(
    [
        config,
        ...plans,
        swapAccounts.USDC,
        swapAccounts.USDT,
        record.lookupTable,
        record.sponsor,
        idl,
        verification,
    ].join(' '),
);
