import path from 'node:path';
import { appendFile, chmod, mkdir } from 'node:fs/promises';

type AuditEvent = Record<string, unknown>;

const ensuredPaths = new Set<string>();

async function ensureAuditPath(filePath: string): Promise<void> {
  if (ensuredPaths.has(filePath)) {
    return;
  }

  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => undefined);

  await appendFile(filePath, '', { encoding: 'utf8', mode: 0o600, flag: 'a' });
  await chmod(filePath, 0o600).catch(() => undefined);

  ensuredPaths.add(filePath);
}

export async function appendAuditEvent(filePath: string, event: AuditEvent): Promise<void> {
  await ensureAuditPath(filePath);
  const line = `${JSON.stringify(event)}\n`;
  await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}
