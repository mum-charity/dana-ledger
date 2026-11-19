/*
 * 善款簿 backup server on AWS: a Lambda function behind an API Gateway HTTP API, keeping backups
 * in a private S3 bucket. server/aws/template.yaml creates all of it; server/aws/deploy.sh
 * builds this code to JavaScript and uploads it. What it accepts and refuses is in
 * ../backup-core.ts, the same as on the Pi.
 *
 * Settings come from the function's environment, set by the template:
 *   BACKUP_TOKEN     the key for reading backups ("Authorization: Bearer <key>")
 *   BACKUP_BUCKET    the bucket
 *   ALLOWED_ORIGINS  comma-separated sites the app runs on
 *   QUOTA_BYTES      all backups together
 *
 * There is no per-address upload limit here: the function keeps no memory between requests.
 * API Gateway limits how many requests a second reach it instead (see the template).
 */
import { createRequire } from 'node:module';
import { createBackupService, type BackupService } from '../backup-core.ts';
import { createS3Store } from './store-s3.ts';

/** The parts of API Gateway's request (payload format 2.0) that are used. */
export interface ApiEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; sourceIp?: string } };
}
export interface ApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Turn API Gateway's request into a call to the backup service, and back. */
export function createHandler(service: BackupService) {
  return async (event: ApiEvent): Promise<ApiResult> => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
    const http = event.requestContext?.http || {};
    const body = event.body == null ? '' : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const out = await service.handle({
      method: http.method,
      url: event.rawPath || '/',
      headers,
      ip: http.sourceIp, // from API Gateway itself, not a header a caller could set
      readBody: async () => body,
    });
    return { statusCode: out.status, headers: out.headers, body: out.body };
  };
}

let ready: ReturnType<typeof createHandler> | null = null;
function realHandler() {
  if (!ready) {
    // The AWS SDK comes with the Lambda runtime; nothing is installed for it. It is loaded with
    // require, which finds the runtime's copy, and only when a real request arrives.
    const sdk = createRequire(import.meta.url)('@aws-sdk/client-s3');
    const env = process.env;
    ready = createHandler(
      createBackupService({
        token: env.BACKUP_TOKEN,
        store: createS3Store({ s3: new sdk.S3Client({}), cmd: sdk, bucket: env.BACKUP_BUCKET || '' }),
        origins: (env.ALLOWED_ORIGINS || 'https://mum.franklee.asia').split(',').map((s) => s.trim()).filter(Boolean),
        quotaBytes: Number(env.QUOTA_BYTES) || undefined,
      })
    );
  }
  return ready;
}

export const handler = (event: ApiEvent): Promise<ApiResult> => realHandler()(event);
