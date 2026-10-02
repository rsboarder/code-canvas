// Chrome turns a trackpad pinch into ctrl+wheel events whose deltaY sums to
// roughly -K * ln(scale). The product zoom handler and the performance
// harness's synthetic pinch replay both need the same K so a measured pinch
// of scale s is simulated (and zoomed) consistently.
// K = 142.6: Chrome's own constant measured 2026-10-01 — a CDP synthetic
// touchpad pinch x2 on a page that does not preventDefault, Chrome zoomed the
// visual viewport to 2.000 for Σ deltaY -98.8; a real-trackpad check is
// pending.
export const PINCH_WHEEL_DELTA_PER_LN_SCALE = 142.6;

// The largest single wheel-event zoom step, expressed as |ln(factor)|.
export const MAX_ZOOM_STEP_LN = 0.1;
