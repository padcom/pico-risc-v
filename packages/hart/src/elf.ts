/**
 * Just enough of an ELF reader to run test programs: the loadable segments
 * and the symbol table. Little-endian ELF32 and ELF64.
 */
export interface Elf {
  /** 32 or 64. */
  bits: 32 | 64
  entry: number
  /** PT_LOAD segments: bytes to place at a physical address (zero-filled up to memSize). */
  segments: { addr: number; data: Uint8Array; memSize: number }[]
  symbols: Map<string, number>
}

const PT_LOAD = 1
const SHT_SYMTAB = 2

export function parseElf(file: Uint8Array): Elf {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength)
  if (v.getUint32(0) !== 0x7f454c46) throw new Error('not an ELF file')
  const bits = file[4] === 2 ? 64 : 32
  if (file[5] !== 1) throw new Error('not a little-endian ELF file')
  const word = (offset: number) => (bits === 64 ? Number(v.getBigUint64(offset, true)) : v.getUint32(offset, true))
  const half = (offset: number) => v.getUint16(offset, true)
  const W = bits / 8 // size of an address field

  const entry = word(24)
  const phoff = word(24 + W)
  const shoff = word(24 + 2 * W)
  const header = 24 + 3 * W + 4 // e_flags
  const [phentsize, phnum, shentsize, shnum] = [half(header + 2), half(header + 4), half(header + 6), half(header + 8)]

  const segments: Elf['segments'] = []
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize
    if (v.getUint32(p, true) !== PT_LOAD) continue
    // ELF64 puts p_flags right after p_type; ELF32 puts it near the end.
    const [offset, paddr, filesz, memsz] =
      bits === 64 ? [word(p + 8), word(p + 24), word(p + 32), word(p + 40)] : [word(p + 4), word(p + 12), word(p + 16), word(p + 20)]
    segments.push({ addr: paddr, data: file.subarray(offset, offset + filesz), memSize: memsz })
  }

  const symbols = new Map<string, number>()
  const section = (i: number) => {
    const s = shoff + i * shentsize
    return { type: v.getUint32(s + 4, true), offset: word(s + 8 + 2 * W), size: word(s + 8 + 3 * W), link: v.getUint32(s + 8 + 4 * W, true) }
  }
  for (let i = 0; i < shnum; i++) {
    const symtab = section(i)
    if (symtab.type !== SHT_SYMTAB) continue
    const strtab = section(symtab.link)
    const entsize = bits === 64 ? 24 : 16
    for (let s = symtab.offset; s < symtab.offset + symtab.size; s += entsize) {
      const nameOffset = strtab.offset + v.getUint32(s, true)
      const value = bits === 64 ? word(s + 8) : word(s + 4)
      let end = nameOffset
      while (file[end]) end++
      const name = new TextDecoder().decode(file.subarray(nameOffset, end))
      if (name) symbols.set(name, value)
    }
  }
  return { bits, entry, segments, symbols }
}
