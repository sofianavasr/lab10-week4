import type { DbClient } from "../client";
import type { Cronjob } from "@agents/types";

export async function createCronjob(
  db: DbClient,
  userId: string,
  jobname: string,
  description: string,
  expression: string,
  runOnce = false
): Promise<Cronjob> {
  const { data, error } = await db
    .from("cronjobs")
    .insert({ user_id: userId, jobname, description, expression, run_once: runOnce })
    .select()
    .single();
  if (error) throw error;
  return data as Cronjob;
}

export async function getActiveCronjobs(db: DbClient): Promise<Cronjob[]> {
  const { data, error } = await db
    .from("cronjobs")
    .select("*")
    .eq("active", true);
  if (error) throw error;
  return (data ?? []) as Cronjob[];
}

export async function updateLastExecutedAt(
  db: DbClient,
  cronjobId: string
): Promise<void> {
  const { error } = await db
    .from("cronjobs")
    .update({ last_executed_at: new Date().toISOString() })
    .eq("id", cronjobId);
  if (error) throw error;
}

export async function getUserCronjobs(
  db: DbClient,
  userId: string
): Promise<Cronjob[]> {
  const { data, error } = await db
    .from("cronjobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Cronjob[];
}

export async function deactivateCronjob(
  db: DbClient,
  cronjobId: string
): Promise<void> {
  const { error } = await db
    .from("cronjobs")
    .update({ active: false })
    .eq("id", cronjobId);
  if (error) throw error;
}
