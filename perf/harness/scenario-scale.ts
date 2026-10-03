import type { Scenario } from "../scenarios/schema";

export function scenarioAtDevicePixelRatio(
  scenario: Scenario,
  devicePixelRatio: number,
): Scenario {
  const referenceRatio = scenario.setup.scaleAtDevicePixelRatio;
  if (referenceRatio === undefined) return scenario;
  const conversion = referenceRatio / devicePixelRatio;
  const camera = scenario.setup.camera;
  const convertedSetup = { ...scenario.setup };
  delete convertedSetup.scaleAtDevicePixelRatio;
  if (camera)
    convertedSetup.camera = { ...camera, scale: camera.scale * conversion };
  if (scenario.setup.approachScale !== undefined)
    convertedSetup.approachScale = scenario.setup.approachScale * conversion;

  return {
    ...scenario,
    setup: convertedSetup,
  };
}
