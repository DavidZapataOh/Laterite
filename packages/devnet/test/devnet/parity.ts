import { isDeepStrictEqual } from 'node:util';

import { address, type Address, isSome, none, type Option, some } from '@solana/kit';
import { type Extension, getMintDecoder, type Mint } from '@solana-program/token-2022';

const AUTHORITY = address('11111111111111111111111111111111');
const THIS_MINT = address('So11111111111111111111111111111111111111111');

const authority = (value: Option<Address>): Option<Address> => (isSome(value) ? some(AUTHORITY) : none());

function normalize(mint: Mint, self: Address) {
    const own = (value: Address) => (value === self ? THIS_MINT : value);
    const extensions = isSome(mint.extensions)
        ? mint.extensions.value.map((e): Extension => {
              switch (e.__kind) {
                  case 'MetadataPointer':
                      return {
                          ...e,
                          authority: authority(e.authority),
                          metadataAddress: isSome(e.metadataAddress) ? some(own(e.metadataAddress.value)) : none(),
                      };
                  case 'PermanentDelegate':
                      return { ...e, delegate: AUTHORITY };
                  case 'ScaledUiAmountConfig':
                      return { ...e, authority: AUTHORITY, multiplier: 0 };
                  case 'PausableConfig':
                  case 'ConfidentialTransferMint':
                      return { ...e, authority: authority(e.authority) };
                  case 'TransferHook':
                      return { ...e, authority: AUTHORITY };
                  case 'TokenMetadata':
                      return { ...e, mint: own(e.mint), updateAuthority: authority(e.updateAuthority) };
                  default:
                      return e;
              }
          })
        : [];
    const { supply: _supply, ...config } = mint;
    return {
        ...config,
        extensions: some(extensions),
        freezeAuthority: authority(mint.freezeAuthority),
        mintAuthority: authority(mint.mintAuthority),
    };
}

export type MintAccount = { address: Address; data: Uint8Array };

/** Paths where two mints differ beyond authorities and supply, plus the account length. */
export function mintDifferences(mainnet: MintAccount, devnet: MintAccount): string[] {
    const a = normalize(getMintDecoder().decode(mainnet.data), mainnet.address);
    const b = normalize(getMintDecoder().decode(devnet.data), devnet.address);
    const differences: string[] = [];
    const walk = (x: unknown, y: unknown, path: string) => {
        if (isDeepStrictEqual(x, y)) return;
        if (x && y && typeof x === 'object' && typeof y === 'object' && !(x instanceof Map)) {
            for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
                walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${path}.${key}`);
            }
        } else differences.push(path);
    };
    walk(a, b, 'mint');
    if (mainnet.data.length !== devnet.data.length) differences.push('account.length');
    return differences;
}
