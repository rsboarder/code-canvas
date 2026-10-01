const TARGET_REQUIREMENTS = new Set(["Frame budget", "No background stalls"]);

interface Heading {
  depth: number;
  text: string;
}

const parseHeading = (line: string): Heading | null => {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
  if (!match?.[1] || !match[2]) return null;
  return { depth: match[1].length, text: match[2] };
};

export const requiredScenarios = (specText: string): string[] => {
  const scenarios: string[] = [];
  let activeRequirement: string | null = null;

  for (const line of specText.split("\n")) {
    const heading = parseHeading(line);
    if (!heading) continue;

    if (heading.depth <= 3) {
      activeRequirement =
        heading.depth === 3 && heading.text.startsWith("Requirement: ")
          ? heading.text.slice("Requirement: ".length)
          : null;
    }

    if (
      heading.depth === 4 &&
      heading.text.startsWith("Scenario: ") &&
      activeRequirement !== null &&
      TARGET_REQUIREMENTS.has(activeRequirement)
    ) {
      scenarios.push(heading.text.slice("Scenario: ".length));
    }
  }

  return scenarios;
};

export interface CoverageResult {
  missing: string[];
  unknown: string[];
}

export const checkCoverage = (
  required: readonly string[],
  scenarioNames: readonly string[],
): CoverageResult => {
  const requiredSet = new Set(required);
  const scenarioSet = new Set(scenarioNames);
  return {
    missing: required.filter((name) => !scenarioSet.has(name)),
    unknown: scenarioNames.filter((name) => !requiredSet.has(name)),
  };
};
