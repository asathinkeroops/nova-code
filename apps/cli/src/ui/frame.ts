/**
 * Shared cadence for the two high-frequency drivers of a full-frame Ink
 * repaint: the spinner's animation tick and the streaming live-draft flush.
 *
 * Ink rewrites the entire frame on any state change, so both the spinner
 * (every tick) and the live draft (every flush) trigger a full repaint. Running
 * them on different periods (the spinner ran at 60/80ms, the draft at 80ms)
 * meant their frames landed out of phase and interleaved into extra repaints.
 * Pinning both to one period bounds the repaint rate to ~12.5 fps and lets
 * near-simultaneous updates coalesce into a single frame. Synchronized Output
 * (see sync-output.ts) makes each of those repaints atomic; this keeps their
 * count down.
 */
export const UI_FRAME_MS = 80;
