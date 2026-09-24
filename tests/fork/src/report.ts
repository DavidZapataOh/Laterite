import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const DIRECTORY = new URL('../reports/', import.meta.url);

/** Empties `reports/` (git-ignored) before a run. */
export const clearReports = () => rmSync(DIRECTORY, { force: true, recursive: true });

/** Appends `rows` to `reports/<name>.json`, which several test files may write, and prints them. */
export function report(name: string, rows: Record<string, unknown>[]) {
    mkdirSync(DIRECTORY, { recursive: true });
    const file = new URL(`${name}.json`, DIRECTORY);
    const earlier = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown[]) : [];
    const json = JSON.stringify(
        [...earlier, ...rows],
        (_, value) => (typeof value === 'bigint' ? value.toString() : value),
        4,
    );
    writeFileSync(file, `${json}\n`);
    console.table(rows.map(row => Object.fromEntries(Object.entries(row).filter(([, v]) => typeof v !== 'object'))));
}
