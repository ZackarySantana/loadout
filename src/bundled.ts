import { fileURLToPath } from 'node:url';

// Shared by source runs and the published dist/ entry point.
export const bundledRoot = fileURLToPath(new URL('../kits/', import.meta.url));
