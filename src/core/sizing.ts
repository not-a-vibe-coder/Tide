import type { SizingInputs, SizingResult } from "./types.js";

/** New users keep h = 1 until they have this many resolved alerts of a class. */
export const MIN_OUTCOMES_FOR_TRACK_RECORD = 5;
/** Track record looks at the most recent N resolved outcomes. */
export const TRACK_RECORD_WINDOW = 10;

/**
 * Track record multiplier h from past outcomes (true = the token was up
 * 24h after the alert). Maps a 0% win rate to 0.5 and 100% to 1.2.
 */
export function trackRecordMultiplier(outcomes: boolean[]): number {
  if (outcomes.length < MIN_OUTCOMES_FOR_TRACK_RECORD) return 1;
  const recent = outcomes.slice(-TRACK_RECORD_WINDOW);
  const winRate = recent.filter(Boolean).length / recent.length;
  return round2(0.5 + 0.7 * winRate);
}

/** max size = budget left × base share × track record × token risk */
export function suggestSize(inputs: SizingInputs): SizingResult {
  const budgetLeftUsd = Math.max(0, inputs.budgetLeftUsd);
  const raw = budgetLeftUsd * inputs.baseShare * inputs.trackRecord * inputs.riskMultiplier;
  return { ...inputs, budgetLeftUsd, maxUsd: Math.floor(raw * 100) / 100 };
}

/** Proposed weekly budget: 10% of liquid balance, at least $5, rounded to $5. */
export function proposeBudget(liquidUsd: number): number {
  const tenth = liquidUsd * 0.1;
  return Math.max(5, Math.round(tenth / 5) * 5);
}

/** Start of the current week (Monday 00:00) in Africa/Lagos, which is UTC+1 with no DST. */
export function startOfWeekLagos(now: Date = new Date()): Date {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  const day = (lagos.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate() - day);
  return new Date(monday - 60 * 60 * 1000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
