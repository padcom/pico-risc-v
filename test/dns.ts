/**
 * A DNS response giving the name in `query` the address `addr`, if it asks for
 * an IPv4 address (type A); other queries (e.g. AAAA) get an empty answer.
 */
export function answerA(query: Buffer, addr: number[]): Buffer {
  let end = 12
  while (query[end] !== 0) end += query[end]! + 1 // QNAME labels
  end += 5 // zero label, QTYPE, QCLASS
  const isA = query.readUInt16BE(end - 4) === 1
  const answer = isA
    ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...addr]) // name → offset 12, A, IN, TTL 60
    : Buffer.alloc(0)
  const response = Buffer.concat([query.subarray(0, end), answer])
  response.writeUInt16BE(0x8180, 2) // response, recursion available, no error
  response.writeUInt16BE(isA ? 1 : 0, 6) // ANCOUNT
  response.writeUInt16BE(0, 8) // NSCOUNT
  response.writeUInt16BE(0, 10) // ARCOUNT
  return response
}
