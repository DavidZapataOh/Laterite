import { genesis } from './support/chain';
import { declare } from './support/declarations';
import { users } from './support/keys';
import { CLOSED_RPC_PORT, startValidator } from './support/validator';

export default async function globalSetup() {
    await declare(Object.values(users));
    const [open, closed] = await Promise.all([
        startValidator(await genesis()),
        startValidator(await genesis({ paused: true }), CLOSED_RPC_PORT),
    ]);
    return async () => {
        await Promise.all([open(), closed()]);
    };
}
