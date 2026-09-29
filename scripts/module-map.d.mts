import type { Linter } from "eslint";

export const MAX_SOURCE_LINES: number;
export const moduleMap: {
  coreContexts: readonly string[];
  coreLayers: readonly string[];
  technicalModules: readonly string[];
  sharedAreas: readonly string[];
  outsideAreas: readonly string[];
  elements: readonly Record<string, unknown>[];
  files: readonly Record<string, unknown>[];
  boundaryPolicies: readonly Record<string, unknown>[];
  libraryAreas: readonly {
    files: readonly string[];
    allowed: readonly string[];
  }[];
  libraries: readonly { name: string; message: string }[];
  domGlobals: readonly string[];
  knip: {
    staticEntries: readonly string[];
    projectPatterns: readonly string[];
    ignore: readonly string[];
    ignoreDependencies: readonly string[];
  };
};
export function boundarySettings(
  map?: typeof moduleMap,
): Record<string, unknown>;
export function boundaryRules(map?: typeof moduleMap): Linter.RulesRecord;
export function libraryRules(map?: typeof moduleMap): Record<string, unknown>;
export function knipConfig(map?: typeof moduleMap): Record<string, unknown>;
