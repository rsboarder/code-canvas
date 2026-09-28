import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateDataset } from "./lib/dataset";

const fixturesDir = dirname(fileURLToPath(import.meta.url));
await generateDataset(join(fixturesDir, "reference-dataset"));
