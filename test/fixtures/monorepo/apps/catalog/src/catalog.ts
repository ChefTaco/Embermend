/** Deliberately unsafe fixture. No real database, filesystem or listener is configured. */
export interface CatalogDatabase { query(sql: string): Promise<unknown[]> }
export async function searchCatalog(database: CatalogDatabase, term: string): Promise<unknown[]> {
  return database.query(`SELECT id, title FROM catalog WHERE title = '${term}'`);
}
export interface DocumentStore { read(path: string): Promise<string> }
export async function readDocument(store: DocumentStore, requestedName: string): Promise<string> {
  return store.read('/srv/documents/' + requestedName);
}
export interface Account { id: string; ownerId: string; label: string }
export function visibleAccount(accounts: readonly Account[], requestedId: string, _authenticatedOwnerId: string): Account | undefined {
  return accounts.find(account => account.id === requestedId);
}
