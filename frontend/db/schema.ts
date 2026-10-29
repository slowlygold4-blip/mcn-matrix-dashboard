// Intentionally empty by default.
// Add Drizzle tables here when the site actually needs a database.
// See examples/d1/db/schema.ts for an opt-in example.
export {};
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
export const replicaFiles = sqliteTable("replica_files", {
  generation: text("generation").notNull(), path: text("path").notNull(),
  checksum: text("checksum").notNull(), bytes: integer("bytes").notNull(),
}, table => [primaryKey({columns:[table.generation, table.path]})]);
export const replicaGenerations = sqliteTable("replica_generations", {
  generation: text("generation").primaryKey(), manifest: text("manifest").notNull(),
  publishedAt: text("published_at").notNull(),
});
export const replicaFileReferences = sqliteTable("replica_file_references", {
  generation: text("generation").notNull(), path: text("path").notNull(),
  sourceGeneration: text("source_generation").notNull(), sourceChecksum: text("source_checksum").notNull(),
  sourceBytes: integer("source_bytes").notNull(), trailingNewline: integer("trailing_newline").notNull(),
}, table => [primaryKey({columns:[table.generation, table.path]})]);
