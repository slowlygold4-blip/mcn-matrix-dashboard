// Vite aliases cloudflare:workers here only in independent local builds.
// No storage credentials, simulated statistics or production write capability.
export const env=Object.freeze({MCN_STANDALONE_READONLY:true});
