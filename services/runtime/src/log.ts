import { createLogger, type Logger } from '@hivemagnus/hive-common/log';
import { DomainError } from '@hivemagnus/embermend-core';

/** One redacted JSON line per entry on stderr, with the request ID when there is one. */
export const logger: Logger = createLogger({ bindings: { service: 'embermend' }, write: line => { process.stderr.write(line + '\n'); } });

/**
 * Identify a failure without its message: messages can carry source, SQL, tokens or remote
 * responses. Only codes and constant-style reasons (such as `PRODUCT_GRANT_REQUIRED`) are kept.
 */
export function errorFields(error: unknown): Record<string, string> {
  if (error instanceof DomainError) return { errorCode: error.code };
  const fields: Record<string, string> = { errorName: error instanceof Error ? error.name : typeof error };
  const code: unknown = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) fields['errorCode'] = code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) fields['reason'] = error.message;
  return fields;
}
