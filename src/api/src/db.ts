import pg from "pg";
import { config } from "./config.js";

// numeric y bigint llegan como texto; se convierten a número para el JSON.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Las fechas sin hora se dejan como texto (AAAA-MM-DD) para que la zona horaria no las corra un día.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool(config.postgres);

export async function consultar<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

export function comoVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
