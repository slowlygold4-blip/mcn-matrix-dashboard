# Work metric clocks

Work identity, publication time and metric observation time are separate facts.
An invalid clock must not erase a separately verified work or overwrite its raw
source record, and it must not create a publication day or a daily baseline.

`lib/work-metric-clock.mjs` is shared by work adoption, the unified author/work
read model and daily work-like comparability. External clocks require an explicit
zone. Calendar dates and clock fields are checked before normalization; `24:00`,
impossible calendar dates, locale-dependent strings and bare date-only values do
not become observation instants. Valid offsets and real zero/decreasing counters
remain supported. Metric instants retain the existing millisecond precision.

The legacy SQLite reader explicitly opts into `legacyUtc: true` for unzoned
`YYYY-MM-DD HH:mm:ss` / `YYYY-MM-DDTHH:mm:ss` values. It interprets those values
as UTC, matching SQLite date functions rather than the machine's local timezone.
This option does not make an unzoned external source clock valid.

This change does not invent timestamps, backfill absent days, alter stored data,
establish complete publication coverage or make an inaccessible API available.
Incomplete discovery remains incomplete. Collection still requires working data
access independently of clock parsing.

Validation includes process runs under UTC, America/Los_Angeles and Asia/Shanghai,
SQLite timestamp agreement, midnight boundaries, invalid rollover rejection,
unchanged raw evidence and unified work/author/publication projections. A live
deployment must also compare full results at one fixed cutoff and reload the
long-lived service at a protected maintenance boundary.

References: [SQLite date functions](https://www.sqlite.org/lang_datefunc.html),
[ECMAScript date-time strings](https://tc39.es/ecma262/#sec-date-time-string-format).
