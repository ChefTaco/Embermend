/** Deliberately unsafe fixture. The injected executor is supplied only by isolated tests. */
export interface Executor { command(command: string): Promise<string> }
export async function renderPreview(executor: Executor, filename: string): Promise<string> {
  return executor.command('convert ' + filename + ' /tmp/preview.png');
}
