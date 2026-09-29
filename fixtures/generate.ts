import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateDataset,
  generateEdgeCaseCorpus,
  writeDataset,
  writeEdgeCaseCorpus,
} from "./lib/dataset";

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const dataset = generateDataset();
const corpus = generateEdgeCaseCorpus();
await writeDataset(join(fixturesDir, "reference-dataset"), dataset);
await writeEdgeCaseCorpus(join(fixturesDir, "edge-case-corpus"), corpus);
