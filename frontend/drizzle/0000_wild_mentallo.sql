CREATE TABLE `replica_files` (
	`generation` text NOT NULL,
	`path` text NOT NULL,
	`checksum` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`generation`, `path`)
);
--> statement-breakpoint
CREATE TABLE `replica_generations` (
	`generation` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`published_at` text NOT NULL
);
