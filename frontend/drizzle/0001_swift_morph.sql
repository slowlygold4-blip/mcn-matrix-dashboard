CREATE TABLE `replica_file_references` (
	`generation` text NOT NULL,
	`path` text NOT NULL,
	`source_generation` text NOT NULL,
	`source_checksum` text NOT NULL,
	`source_bytes` integer NOT NULL,
	`trailing_newline` integer NOT NULL,
	PRIMARY KEY(`generation`, `path`)
);
