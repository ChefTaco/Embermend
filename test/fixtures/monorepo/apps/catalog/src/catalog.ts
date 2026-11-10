/** Repaired inert fixture. Consumers supply the configured database and document store. */
export interface CatalogDatabase { query(sql: string, parameters: readonly string[]): Promise<unknown[]> }
export async function searchCatalog(database: CatalogDatabase, term: string): Promise<unknown[]> {
  return database.query('SELECT id, title FROM catalog WHERE title = ?', [term]);
}
export interface DocumentStore { read(path: string): Promise<string> }
export async function readDocument(store: DocumentStore, requestedName: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(requestedName)) throw new Error('Single document filename required');
  return store.read('/srv/documents/' + requestedName);
}
export interface Account { id: string; ownerId: string; label: string }
export function visibleAccount(accounts: readonly Account[], requestedId: string, authenticatedOwnerId: string): Account | undefined {
  return accounts.find(account => account.id === requestedId && account.ownerId === authenticatedOwnerId);
}
