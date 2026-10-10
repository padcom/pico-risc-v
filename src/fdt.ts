/**
 * Flattened Device Tree (DTB) encoder — the binary format a kernel reads to
 * learn what hardware it is running on (devicetree specification v0.4, ch. 5).
 *
 * Property values:
 *   number / number[]  → big-endian u32 cells
 *   string / string[]  → NUL-terminated string (list)
 *   true               → empty (boolean) property
 *   Uint8Array         → raw bytes
 */
export type FdtValue = number | number[] | string | string[] | true | Uint8Array

export interface FdtNode {
  props?: Record<string, FdtValue>
  children?: Record<string, FdtNode>
}

const FDT_MAGIC = 0xd00dfeed
const FDT_BEGIN_NODE = 1
const FDT_END_NODE = 2
const FDT_PROP = 3
const FDT_END = 9
const HEADER_SIZE = 40
const RSVMAP_SIZE = 16 // just the terminating empty entry

export function encodeFdt(root: FdtNode, { bootCpuId = 0 } = {}): Uint8Array {
  const utf8 = new TextEncoder()
  const struct: number[] = []
  const strings: number[] = []
  const stringOffsets = new Map<string, number>()

  const u32 = (out: number[], v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  const pad = (out: number[]) => {
    while (out.length % 4) out.push(0)
  }
  const cstr = (s: string) => [...utf8.encode(s), 0]

  const nameOffset = (name: string) => {
    let off = stringOffsets.get(name)
    if (off === undefined) {
      off = strings.length
      strings.push(...cstr(name))
      stringOffsets.set(name, off)
    }
    return off
  }

  const encodeValue = (v: FdtValue): number[] => {
    if (v === true) return []
    if (v instanceof Uint8Array) return [...v]
    if (typeof v === 'string') return cstr(v)
    if (typeof v === 'number') v = [v]
    if (typeof v[0] === 'string') return (v as string[]).flatMap(cstr)
    const out: number[] = []
    for (const cell of v as number[]) u32(out, cell)
    return out
  }

  const walk = (name: string, node: FdtNode) => {
    u32(struct, FDT_BEGIN_NODE)
    struct.push(...cstr(name))
    pad(struct)
    for (const [prop, value] of Object.entries(node.props ?? {})) {
      const data = encodeValue(value)
      u32(struct, FDT_PROP)
      u32(struct, data.length)
      u32(struct, nameOffset(prop))
      struct.push(...data)
      pad(struct)
    }
    for (const [child, sub] of Object.entries(node.children ?? {})) walk(child, sub)
    u32(struct, FDT_END_NODE)
  }

  walk('', root)
  u32(struct, FDT_END)

  const offStruct = HEADER_SIZE + RSVMAP_SIZE
  const offStrings = offStruct + struct.length
  const total = offStrings + strings.length

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  const header = [
    FDT_MAGIC,
    total,
    offStruct,
    offStrings,
    HEADER_SIZE, // off_mem_rsvmap
    17, // version
    16, // last_comp_version
    bootCpuId,
    strings.length,
    struct.length,
  ]
  header.forEach((v, i) => view.setUint32(i * 4, v))
  out.set(struct, offStruct)
  out.set(strings, offStrings)
  return out
}
