import { declare } from './support/declarations';
import { users } from './support/keys';
import { startValidator } from './support/validator';

export default async function globalSetup() {
    await declare(Object.values(users));
    return await startValidator();
}
