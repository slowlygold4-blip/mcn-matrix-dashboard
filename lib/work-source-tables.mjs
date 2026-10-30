// Shared lightweight evidence catalog; backup readers need no XLSX runtime.
export const WORK_SOURCE_TABLES = Object.freeze(['work_source_artifacts', 'work_source_versions',
  'work_source_fact_blobs', 'work_source_version_facts', 'work_source_heads', 'work_source_link_receipts']);
