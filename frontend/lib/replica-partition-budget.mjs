// UTF-8 byte budgets shared by the producer and the hosted upload route.
// The growing account directory gets one bounded standalone upload; history
// partitions and multi-file batches retain the smaller original budgets.
export const REPLICA_UPLOAD_MAX_BYTES = 11_500_000;
export function replicaPartitionByteLimit(path) {
 if(path==='catalog.json')return 8_000_000;
 if(path==='summary.json')return 6_000_000;
 if(/^summary\/|^date-summary\/|^date-summary-index\.json$/.test(path))return 1_000_000;
 return 4_000_000;
}
export function replicaBatchByteLimit(files) {
 return files.length===1&&files[0]?.path==='catalog.json'?REPLICA_UPLOAD_MAX_BYTES:7_500_000;
}
