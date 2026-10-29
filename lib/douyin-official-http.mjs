// Shared bounded JSON reader for isolated, authorized official-API probes.
export async function boundedOfficialJson(response, maxBytes = 2 * 1024 * 1024) {
  const fail = code => Object.assign(new Error(code), { code });
  if (!response.body?.getReader) throw fail('invalid_response');
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw fail('response_too_large');
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.code === 'response_too_large') throw error;
    throw fail('invalid_response');
  } finally { reader.releaseLock(); }
}
