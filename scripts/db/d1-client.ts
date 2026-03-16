/**
 * Lightweight Cloudflare D1 HTTP API client for use in scripts.
 * Mirrors the interface used by sync/pull scripts.
 */

import 'dotenv/config';

interface D1Row { [key: string]: unknown }

interface D1ResultSet {
  columns: string[]
  rows: D1Row[]
  rowsAffected: number
  lastInsertRowid: number | undefined
}

interface D1Statement {
  sql: string
  args?: unknown[]
}

export interface D1Client {
  execute(input: string | D1Statement): Promise<D1ResultSet>
  batch(statements: D1Statement[], mode?: string): Promise<D1ResultSet[]>
}

interface D1ApiResultEntry {
  results: D1Row[]
  meta: {
    changed_db: boolean
    changes: number
    duration: number
    last_row_id: number
    rows_read: number
    rows_written: number
  }
  success: boolean
}

interface D1ApiResponse {
  errors: Array<{ code: number; message: string }>
  messages: string[]
  result: D1ApiResultEntry[]
  success: boolean
}

function toResultSet(entry: D1ApiResultEntry): D1ResultSet {
  const rows = entry.results ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    columns,
    rows,
    rowsAffected: entry.meta?.changes ?? 0,
    lastInsertRowid: entry.meta?.last_row_id ?? undefined,
  };
}

export function createD1Client(config: {
  accountId: string;
  databaseId: string;
  apiToken: string;
}): D1Client {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const headers = {
    'Authorization': `Bearer ${config.apiToken}`,
    'Content-Type': 'application/json',
  };

  async function querySingle(
    sql: string,
    params: unknown[] = [],
  ): Promise<D1ApiResultEntry> {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql, params }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`D1 API error ${resp.status}: ${text}`);
    }
    const json = (await resp.json()) as D1ApiResponse;
    if (!json.success) {
      const msg = json.errors?.map(e => e.message).join('; ') || 'Unknown D1 error';
      throw new Error(`D1 query failed: ${msg}`);
    }
    return json.result[0];
  }

  return {
    async execute(input: string | D1Statement): Promise<D1ResultSet> {
      const sql = typeof input === 'string' ? input : input.sql;
      const params = typeof input === 'string' ? [] : (input.args ?? []);
      const entry = await querySingle(sql, params);
      return toResultSet(entry);
    },
    async batch(statements: D1Statement[], _mode?: string): Promise<D1ResultSet[]> {
      const results: D1ResultSet[] = [];
      for (const s of statements) {
        const entry = await querySingle(s.sql, s.args ?? []);
        results.push(toResultSet(entry));
      }
      return results;
    },
  };
}

export function getD1Client(): D1Client {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();

  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      'Missing D1 env vars. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN.',
    );
  }

  return createD1Client({ accountId, databaseId, apiToken });
}
