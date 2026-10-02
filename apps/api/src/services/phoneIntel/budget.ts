import { pool } from "../../db/pool.js";

// Twilio spend can never exceed this per day, whatever is configured.
export const HARD_DAILY_CAP_USD = 7;
export const DEFAULT_PRICE_USD = 0.008;

export interface BudgetState {
  day: string;
  limitUsd: number;
  priceUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  remainingLookups: number;
  twilioLookups: number;
  localLookups: number;
}

// Budget days run on US Eastern time, matching the team's working day.
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

async function config(organizationId: string): Promise<{ limit: number; price: number }> {
  const r = await pool.query(
    `insert into coverage_budgets (organization_id, budget_usd) values ($1, ${HARD_DAILY_CAP_USD})
     on conflict (organization_id) do update set organization_id = excluded.organization_id
     returning budget_usd, price_per_lookup_usd`,
    [organizationId]
  );
  const price = Number(r.rows[0].price_per_lookup_usd) || DEFAULT_PRICE_USD;
  return { limit: Math.min(HARD_DAILY_CAP_USD, Math.max(0, Number(r.rows[0].budget_usd))), price };
}

export async function budgetState(organizationId: string): Promise<BudgetState> {
  const { limit, price } = await config(organizationId);
  const day = today();
  const r = await pool.query(
    `insert into lookup_budget_days (organization_id, day) values ($1, $2)
     on conflict (organization_id, day) do update set day = excluded.day returning *`,
    [organizationId, day]
  );
  const row = r.rows[0];
  const spent = Number(row.spent_usd);
  const reserved = Number(row.reserved_usd);
  const remaining = Math.max(0, limit - spent - reserved);
  return {
    day,
    limitUsd: limit,
    priceUsd: price,
    spentUsd: spent,
    reservedUsd: reserved,
    remainingUsd: remaining,
    remainingLookups: Math.floor(remaining / price + 1e-9),
    twilioLookups: row.twilio_lookups,
    localLookups: row.local_lookups,
  };
}

export interface Reservation {
  day: string;
  amount: number;
}

// Atomic: one UPDATE checks and reserves in the same statement, so
// concurrent single, bulk and background lookups can't overspend.
export async function reserve(organizationId: string): Promise<Reservation | null> {
  const { limit, price } = await config(organizationId);
  const day = today();
  await pool.query("insert into lookup_budget_days (organization_id, day) values ($1, $2) on conflict do nothing", [organizationId, day]);
  const r = await pool.query(
    `update lookup_budget_days set reserved_usd = reserved_usd + $3
     where organization_id = $1 and day = $2 and spent_usd + reserved_usd + $3 <= $4
     returning day`,
    [organizationId, day, price, limit]
  );
  return r.rows[0] ? { day, amount: price } : null;
}

// Twilio charged: move the reservation to spent.
export async function commit(organizationId: string, res: Reservation) {
  await pool.query(
    `update lookup_budget_days set reserved_usd = greatest(reserved_usd - $3, 0), spent_usd = spent_usd + $3,
       twilio_lookups = twilio_lookups + 1
     where organization_id = $1 and day = $2`,
    [organizationId, res.day, res.amount]
  );
  // Keep the legacy running total the stats card reads.
  await pool.query("update coverage_budgets set spent_usd = spent_usd + $2, updated_at = now() where organization_id = $1", [organizationId, res.amount]);
}

// Request failed before Twilio charged: give the reservation back.
export async function release(organizationId: string, res: Reservation) {
  await pool.query(
    "update lookup_budget_days set reserved_usd = greatest(reserved_usd - $3, 0) where organization_id = $1 and day = $2",
    [organizationId, res.day, res.amount]
  );
}

export async function countLocal(organizationId: string, n: number) {
  if (n <= 0) return;
  await pool.query(
    `insert into lookup_budget_days (organization_id, day, local_lookups) values ($1, $2, $3)
     on conflict (organization_id, day) do update set local_lookups = lookup_budget_days.local_lookups + $3`,
    [organizationId, today(), n]
  );
}
