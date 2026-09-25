import { generateKeyPairSigner, getBase58Decoder, type KeyPairSigner } from '@solana/kit';
import { createTranslator } from 'next-intl';
import en from '@laterite/i18n/messages/en.json';
import es from '@laterite/i18n/messages/es-AR.json';

import { declarationMessage, type DeclarationTranslator } from '@/lib/declaration';

export const translators = {
    en: createTranslator({ locale: 'en', messages: en, namespace: 'declaration' }) as DeclarationTranslator,
    'es-AR': createTranslator({ locale: 'es-AR', messages: es, namespace: 'declaration' }) as DeclarationTranslator,
};

/** A wallet's signed declaration, as the app asks for it. */
export async function signedDeclaration(
    options: { domain?: string; issuedAt?: string; locale?: keyof typeof translators; signer?: KeyPairSigner } = {},
) {
    const { domain = 'app.laterite.cash', issuedAt = new Date().toISOString(), locale = 'en' } = options;
    const signer = options.signer ?? (await generateKeyPairSigner());
    const declaration = { domain, issuedAt, wallet: signer.address };
    const message = new TextEncoder().encode(declarationMessage(translators[locale], declaration));
    const [signatures] = await signer.signMessages([{ content: message, signatures: {} }]);
    return { ...declaration, locale, signature: getBase58Decoder().decode(signatures[signer.address]), signer };
}
