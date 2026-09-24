import { fetchConfig, findConfigPda, getLateriteLogEvents, parseMarketCalendarSetEvent } from '@laterite/client';
import { createClient, loadSigner } from '@laterite/devnet';

import {
    AdminHandedOverError,
    deploymentFile,
    ensureMarketCalendar,
    MARKET_CALENDAR_FILE,
    readDeploymentRecord,
    readMarketCalendar,
    writeDeploymentRecord,
} from '../src';

const client = createClient();
const file = deploymentFile();
const record = await readDeploymentRecord(file);
if (!record) throw new Error(`No deployment recorded in ${file.pathname}: run the deploy recipe first`);
const { data: config } = await fetchConfig(client.rpc, (await findConfigPda())[0]);
const calendar = await readMarketCalendar(MARKET_CALENDAR_FILE);
try {
    const signature = await ensureMarketCalendar(client, await loadSigner('devnet-authority'), config, calendar);
    if (!signature) {
        console.log(`✓ The config already holds the calendar file (through day ${calendar.validThrough})`);
        process.exit(0);
    }
    await writeDeploymentRecord(file, { ...record, marketCalendarSet: signature });
    const transaction = await client.rpc
        .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
        .send();
    const [event] = getLateriteLogEvents(transaction?.meta?.logMessages ?? []).map(parseMarketCalendarSetEvent);
    if (!event) throw new Error(`No MarketCalendarSet event in ${signature}`);
    console.log(
        `✓ MarketCalendarSet in ${signature}: ${event.holidays.length} holidays, ` +
            `${event.earlyCloses.length} early closes, valid through day ${event.validThrough}`,
    );
} catch (error) {
    if (!(error instanceof AdminHandedOverError)) throw error;
    console.error(error.message);
    process.exit(1);
}
