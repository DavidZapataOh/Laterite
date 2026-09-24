import type { TestProject } from 'vitest/node';

import { deployFork, forkKeys, generateForkKeySeeds } from './deployment';
import { clearReports } from './report';

/** Deploys Laterite once on the fork the recipe started, with keys that live only for this run. */
export default async function setup(project: TestProject) {
    clearReports();
    const seeds = generateForkKeySeeds();
    const deployment = await deployFork(await forkKeys(seeds));
    project.provide('fork', {
        deployment: { lookupTable: deployment.lookupTable!, swapAccounts: deployment.swapAccounts },
        seeds,
    });
}
