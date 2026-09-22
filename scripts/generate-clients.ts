import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { type AnchorIdl, rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const idl = JSON.parse(await readFile(new URL('../idl/laterite.json', import.meta.url), 'utf8')) as AnchorIdl;

await createFromRoot(rootNodeFromAnchor(idl)).accept(
    renderVisitor(fileURLToPath(new URL('../clients/typescript', import.meta.url)), { syncPackageJson: false }),
);
