import fs from 'fs';
import path from 'path';
import { DLQ_DIR } from './config';

/**
 * Append a failure record to the source-specific JSONL dead-letter queue.
 * Creates the DLQ directory if it doesn't exist.
 */
export function writeToDLQ(
  source: string,
  url: string,
  error: string,
  attempt: number,
): void {
  const dir = DLQ_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${source}-failures.jsonl`);
  const record = JSON.stringify({
    source,
    url,
    error,
    attempt,
    timestamp: new Date().toISOString(),
  });
  fs.appendFileSync(filePath, record + '\n');
}
