import { type Bus, BusError } from './bus.js'
import {
  Csr,
  MIP_MEIP,
  MIP_MSIP,
  MIP_MTIP,
  MSTATUS_MIE,
  MSTATUS_MPIE,
  MSTATUS_MPP,
  MSTATUS_MPP_SHIFT,
  Priv,
} from './csr.js'
import { InterruptCause, Trap, TrapCause } from './trap.js'

const enum Opcode {
  LOAD = 0x03,
  MISC_MEM = 0x0f,
  OP_IMM = 0x13,
  AUIPC = 0x17,
  STORE = 0x23,
  AMO = 0x2f,
  OP = 0x33,
  LUI = 0x37,
  BRANCH = 0x63,
  JALR = 0x67,
  JAL = 0x6f,
  SYSTEM = 0x73,
}

/** misa: MXL=1 (32-bit), extensions A, I, M, U. */
const MISA = (1 << 30) | (1 << 0) | (1 << 8) | (1 << 12) | (1 << 20)

const MSTATUS_WRITABLE = MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP
const MIE_WRITABLE = MIP_MSIP | MIP_MTIP | MIP_MEIP
const TWO_32 = 0x1_0000_0000

/**
 * Why `run()` returned:
 *  - limit:      the requested number of steps was executed
 *  - wfi:        the hart is stalled in WFI with no enabled interrupt pending
 *  - breakpoint: EBREAK executed while `breakOnEbreak` is set (pc left on it)
 *  - stopped:    something (e.g. a power-off device) called `stop()`
 */
export type StopReason = 'limit' | 'wfi' | 'breakpoint' | 'stopped'

export interface CPUOptions {
  /** Address of the first instruction. */
  resetVector?: number
  /** Source for the `time`/`timeh` CSRs (normally the CLINT's mtime). Without one they are illegal. */
  readTime?: () => number
  /**
   * Treat EBREAK as a debugger breakpoint: stop `run()` instead of trapping.
   * Handy for hand-assembled test programs that have no trap handler.
   */
  breakOnEbreak?: boolean
}

/**
 * RV32IMA hart with machine and user privilege modes (Zicsr, Zifencei).
 *
 * Registers are held in an Int32Array so JS bitwise ops (which work on signed
 * 32-bit ints) map directly onto them; x0 is re-zeroed after every write.
 * The PC is kept as an unsigned 32-bit number.
 *
 * Exceptions and interrupts are taken architecturally: state goes into
 * mepc/mcause/mtval/mstatus and execution continues at mtvec.
 */
export class CPU {
  readonly x = new Int32Array(32)
  pc: number
  priv: Priv = Priv.Machine

  // Machine-mode CSR state
  mstatus = 0
  mie = 0
  /** Pending interrupts. Driven by devices via `setInterruptPending()`. */
  mip = 0
  mtvec = 0
  mscratch = 0
  mepc = 0
  mcause = 0
  mtval = 0

  /** Instructions retired (also serves as the cycle counter: 1 IPC). */
  instret = 0
  /** True while stalled in WFI. */
  waiting = false

  breakOnEbreak: boolean
  private readonly readTime?: () => number
  /** Address reserved by LR.W, or -1. */
  private reservation = -1
  private stopReason: StopReason | undefined

  constructor(
    readonly bus: Bus,
    { resetVector = 0, readTime, breakOnEbreak = false }: CPUOptions = {},
  ) {
    this.pc = resetVector >>> 0
    this.readTime = readTime
    this.breakOnEbreak = breakOnEbreak
  }

  /** Return to the power-on state and start executing at `pc`. */
  reset(pc: number): void {
    this.x.fill(0)
    this.pc = pc >>> 0
    this.priv = Priv.Machine
    this.mstatus = this.mie = this.mip = this.mtvec = this.mscratch = 0
    this.mepc = this.mcause = this.mtval = 0
    this.instret = 0
    this.waiting = false
    this.reservation = -1
  }

  /** Ask `run()` to return after the current instruction. */
  stop(reason: StopReason = 'stopped'): void {
    this.stopReason = reason
  }

  setInterruptPending(bit: number, pending: boolean): void {
    this.mip = pending ? this.mip | bit : this.mip & ~bit
  }

  /** Execute up to `maxSteps` steps (instructions or trap entries). */
  run(maxSteps = Infinity): StopReason {
    this.stopReason = undefined
    for (let i = 0; i < maxSteps; i++) {
      if (this.waiting && (this.mip & this.mie) === 0) return 'wfi'
      this.step()
      if (this.stopReason) return this.stopReason
    }
    return 'limit'
  }

  /** Take a pending interrupt, or fetch, decode and execute one instruction. */
  step(): void {
    const pending = this.mip & this.mie
    if (this.waiting) {
      if (pending === 0) return
      this.waiting = false
    }
    if (pending !== 0 && (this.priv < Priv.Machine || this.mstatus & MSTATUS_MIE)) {
      const cause =
        pending & MIP_MEIP
          ? InterruptCause.MachineExternal
          : pending & MIP_MSIP
            ? InterruptCause.MachineSoftware
            : InterruptCause.MachineTimer
      this.enterTrap(cause, true, this.pc, 0)
      return
    }

    const pc = this.pc
    let inst: number
    try {
      inst = this.bus.read32(pc) | 0
    } catch (e) {
      if (!(e instanceof BusError)) throw e
      this.enterTrap(TrapCause.InstructionAccessFault, false, pc, pc)
      return
    }

    try {
      this.execute(inst, pc)
    } catch (e) {
      if (e instanceof Trap) {
        this.enterTrap(e.cause, false, pc, e.tval)
      } else if (e instanceof BusError) {
        // AMOs report store faults even for their read half.
        const store = e.kind === 'write' || (inst & 0x7f) === Opcode.AMO
        this.enterTrap(store ? TrapCause.StoreAccessFault : TrapCause.LoadAccessFault, false, pc, e.addr)
      } else {
        throw e
      }
    }
  }

  private enterTrap(cause: number, interrupt: boolean, epc: number, tval: number): void {
    this.mepc = epc
    this.mcause = (interrupt ? 0x8000_0000 | cause : cause) >>> 0
    this.mtval = tval >>> 0
    const mie = this.mstatus & MSTATUS_MIE
    this.mstatus =
      (this.mstatus & ~(MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP)) |
      (mie ? MSTATUS_MPIE : 0) |
      (this.priv << MSTATUS_MPP_SHIFT)
    this.priv = Priv.Machine
    this.reservation = -1
    const base = this.mtvec & ~3
    this.pc = (interrupt && (this.mtvec & 3) === 1 ? base + 4 * cause : base) >>> 0
  }

  private execute(inst: number, pc: number): void {
    const opcode = inst & 0x7f
    const rd = (inst >>> 7) & 0x1f
    const funct3 = (inst >>> 12) & 0x7
    const rs1 = (inst >>> 15) & 0x1f
    const rs2 = (inst >>> 20) & 0x1f
    const funct7 = inst >>> 25

    const x = this.x
    const bus = this.bus
    let nextPc = (pc + 4) >>> 0

    switch (opcode) {
      case Opcode.LUI:
        x[rd] = inst & 0xfffff000
        break

      case Opcode.AUIPC:
        x[rd] = (pc + (inst & 0xfffff000)) | 0
        break

      case Opcode.JAL: {
        const target = (pc + immJ(inst)) >>> 0
        if (target & 3) throw new Trap(TrapCause.InstructionAddressMisaligned, target)
        x[rd] = nextPc
        nextPc = target
        break
      }

      case Opcode.JALR: {
        if (funct3 !== 0) throw illegal(inst)
        const target = ((x[rs1]! + immI(inst)) & ~1) >>> 0
        if (target & 3) throw new Trap(TrapCause.InstructionAddressMisaligned, target)
        x[rd] = nextPc
        nextPc = target
        break
      }

      case Opcode.BRANCH: {
        const a = x[rs1]!
        const b = x[rs2]!
        let taken: boolean
        switch (funct3) {
          case 0b000: taken = a === b; break // BEQ
          case 0b001: taken = a !== b; break // BNE
          case 0b100: taken = a < b; break // BLT
          case 0b101: taken = a >= b; break // BGE
          case 0b110: taken = a >>> 0 < b >>> 0; break // BLTU
          case 0b111: taken = a >>> 0 >= b >>> 0; break // BGEU
          default: throw illegal(inst)
        }
        if (taken) {
          const target = (pc + immB(inst)) >>> 0
          if (target & 3) throw new Trap(TrapCause.InstructionAddressMisaligned, target)
          nextPc = target
        }
        break
      }

      case Opcode.LOAD: {
        const addr = (x[rs1]! + immI(inst)) >>> 0
        let value: number
        switch (funct3) {
          case 0b000: value = (bus.read8(addr) << 24) >> 24; break // LB
          case 0b001: value = (bus.read16(addr) << 16) >> 16; break // LH
          case 0b010: value = bus.read32(addr) | 0; break // LW
          case 0b100: value = bus.read8(addr); break // LBU
          case 0b101: value = bus.read16(addr); break // LHU
          default: throw illegal(inst)
        }
        x[rd] = value
        break
      }

      case Opcode.STORE: {
        const addr = (x[rs1]! + immS(inst)) >>> 0
        const value = x[rs2]!
        switch (funct3) {
          case 0b000: bus.write8(addr, value); break // SB
          case 0b001: bus.write16(addr, value); break // SH
          case 0b010: bus.write32(addr, value); break // SW
          default: throw illegal(inst)
        }
        break
      }

      case Opcode.OP_IMM: {
        const a = x[rs1]!
        const imm = immI(inst)
        const shamt = imm & 0x1f
        switch (funct3) {
          case 0b000: x[rd] = a + imm; break // ADDI
          case 0b010: x[rd] = a < imm ? 1 : 0; break // SLTI
          case 0b011: x[rd] = a >>> 0 < imm >>> 0 ? 1 : 0; break // SLTIU
          case 0b100: x[rd] = a ^ imm; break // XORI
          case 0b110: x[rd] = a | imm; break // ORI
          case 0b111: x[rd] = a & imm; break // ANDI
          case 0b001: // SLLI
            if (funct7 !== 0) throw illegal(inst)
            x[rd] = a << shamt
            break
          case 0b101:
            if (funct7 === 0x00) x[rd] = a >>> shamt // SRLI
            else if (funct7 === 0x20) x[rd] = a >> shamt // SRAI
            else throw illegal(inst)
            break
        }
        break
      }

      case Opcode.OP: {
        const a = x[rs1]!
        const b = x[rs2]!
        const shamt = b & 0x1f
        switch ((funct7 << 3) | funct3) {
          case 0x000: x[rd] = a + b; break // ADD
          case 0x100: x[rd] = a - b; break // SUB
          case 0x001: x[rd] = a << shamt; break // SLL
          case 0x002: x[rd] = a < b ? 1 : 0; break // SLT
          case 0x003: x[rd] = a >>> 0 < b >>> 0 ? 1 : 0; break // SLTU
          case 0x004: x[rd] = a ^ b; break // XOR
          case 0x005: x[rd] = a >>> shamt; break // SRL
          case 0x105: x[rd] = a >> shamt; break // SRA
          case 0x006: x[rd] = a | b; break // OR
          case 0x007: x[rd] = a & b; break // AND
          // RV32M
          case 0x008: x[rd] = Math.imul(a, b); break // MUL
          case 0x009: x[rd] = mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0); break // MULH
          case 0x00a: x[rd] = mulhu(a, b) - (a < 0 ? b : 0); break // MULHSU
          case 0x00b: x[rd] = mulhu(a, b); break // MULHU
          // Division by zero and INT_MIN / -1 have defined results; JS's
          // truncating `/` followed by `| 0` happens to produce exactly those
          // for the overflow case.
          case 0x00c: x[rd] = b === 0 ? -1 : (a / b) | 0; break // DIV
          case 0x00d: x[rd] = b === 0 ? -1 : (a >>> 0) / (b >>> 0); break // DIVU
          case 0x00e: x[rd] = b === 0 ? a : a % b; break // REM
          case 0x00f: x[rd] = b === 0 ? a : (a >>> 0) % (b >>> 0); break // REMU
          default: throw illegal(inst)
        }
        break
      }

      case Opcode.AMO:
        if (funct3 !== 0b010) throw illegal(inst)
        this.amo(inst, rd, x[rs1]! >>> 0, x[rs2]!)
        break

      case Opcode.MISC_MEM:
        // FENCE / FENCE.I: a single in-order hart with no caches has nothing to do.
        if (funct3 !== 0b000 && funct3 !== 0b001) throw illegal(inst)
        break

      case Opcode.SYSTEM:
        if (funct3 === 0) {
          if (!this.system(inst, pc)) return // breakpoint: leave pc on the EBREAK
          if (inst === MRET) nextPc = this.mepc
        } else {
          this.csrInstruction(inst, rd, funct3, rs1)
        }
        break

      default:
        throw illegal(inst)
    }

    x[0] = 0
    this.pc = nextPc
    this.instret++
  }

  /** ECALL / EBREAK / MRET / WFI. Returns false if execution should stop at a breakpoint. */
  private system(inst: number, pc: number): boolean {
    switch (inst) {
      case ECALL:
        throw new Trap(this.priv === Priv.User ? TrapCause.EnvironmentCallFromUMode : TrapCause.EnvironmentCallFromMMode)
      case EBREAK:
        if (this.breakOnEbreak) {
          this.stop('breakpoint')
          return false
        }
        throw new Trap(TrapCause.Breakpoint, pc)
      case MRET: {
        if (this.priv !== Priv.Machine) throw illegal(inst)
        const mpp = (this.mstatus & MSTATUS_MPP) >>> MSTATUS_MPP_SHIFT
        this.mstatus = (this.mstatus & ~(MSTATUS_MIE | MSTATUS_MPP)) | MSTATUS_MPIE | (this.mstatus & MSTATUS_MPIE ? MSTATUS_MIE : 0)
        this.priv = mpp === Priv.Machine ? Priv.Machine : Priv.User
        return true
      }
      case WFI:
        // Resumes once an interrupt is pending and enabled in mie, even if
        // mstatus.MIE is clear (then execution simply continues past WFI).
        if ((this.mip & this.mie) === 0) this.waiting = true
        return true
      default:
        throw illegal(inst)
    }
  }

  private csrInstruction(inst: number, rd: number, funct3: number, rs1: number): void {
    const csr = inst >>> 20
    if (this.priv < ((csr >>> 8) & 3)) throw illegal(inst)

    const op = funct3 & 3 // 1 = write, 2 = set, 3 = clear
    if (op === 0) throw illegal(inst)
    const src = funct3 & 4 ? rs1 : this.x[rs1]! // CSRR*I take a 5-bit immediate
    const writes = op === 1 || rs1 !== 0 // CSRRS/CSRRC with x0/0 only read
    if (writes && csr >>> 10 === 3) throw illegal(inst) // read-only CSR

    const old = this.readCsr(csr, inst)
    if (writes) this.writeCsr(csr, op === 1 ? src : op === 2 ? old | src : old & ~src)
    this.x[rd] = old
  }

  private readCsr(csr: number, inst: number): number {
    switch (csr) {
      case Csr.mstatus: return this.mstatus
      case Csr.misa: return MISA
      case Csr.mie: return this.mie
      case Csr.mtvec: return this.mtvec
      case Csr.mcounteren: return 0x7 // cycle, time, instret readable from U-mode
      case Csr.mscratch: return this.mscratch
      case Csr.mepc: return this.mepc
      case Csr.mcause: return this.mcause
      case Csr.mtval: return this.mtval
      case Csr.mip: return this.mip
      case Csr.mstatush:
      case Csr.mcountinhibit:
      case Csr.mvendorid:
      case Csr.marchid:
      case Csr.mimpid:
      case Csr.mhartid:
      case Csr.mconfigptr:
        return 0
      case Csr.cycle:
      case Csr.instret:
      case Csr.mcycle:
      case Csr.minstret:
        return this.instret % TWO_32 | 0
      case Csr.cycleh:
      case Csr.instreth:
      case Csr.mcycleh:
      case Csr.minstreth:
        return (this.instret / TWO_32) | 0
      case Csr.time:
      case Csr.timeh:
        if (!this.readTime) throw illegal(inst)
        return csr === Csr.time ? this.readTime() % TWO_32 | 0 : (this.readTime() / TWO_32) | 0
    }
    if (csr >= Csr.pmpcfg0 && csr <= Csr.pmpaddr63) return 0 // no PMP entries
    throw illegal(inst)
  }

  private writeCsr(csr: number, value: number): void {
    switch (csr) {
      case Csr.mstatus: {
        let v = value & MSTATUS_WRITABLE
        if ((v & MSTATUS_MPP) !== MSTATUS_MPP) v &= ~MSTATUS_MPP // MPP holds only M or U
        this.mstatus = v
        break
      }
      case Csr.mie: this.mie = value & MIE_WRITABLE; break
      case Csr.mtvec: this.mtvec = value & 3 ? (value & ~3) | 1 : value; break // direct or vectored
      case Csr.mscratch: this.mscratch = value; break
      case Csr.mepc: this.mepc = (value & ~3) >>> 0; break
      case Csr.mcause: this.mcause = value >>> 0; break
      case Csr.mtval: this.mtval = value >>> 0; break
      // Everything else that reads successfully is WARL read-only here: mip
      // bits are driven by devices, counters can't be rewritten, no PMP.
    }
  }

  private amo(inst: number, rd: number, addr: number, src: number): void {
    const op = inst >>> 27
    if (op === 0b00010) {
      // LR.W
      if (addr & 3) throw new Trap(TrapCause.LoadAddressMisaligned, addr)
      this.x[rd] = this.bus.read32(addr) | 0
      this.reservation = addr
      return
    }
    if (addr & 3) throw new Trap(TrapCause.StoreAddressMisaligned, addr)
    if (op === 0b00011) {
      // SC.W
      const ok = this.reservation === addr
      this.reservation = -1
      if (ok) this.bus.write32(addr, src)
      this.x[rd] = ok ? 0 : 1
      return
    }

    const old = this.bus.read32(addr) | 0
    let value: number
    switch (op) {
      case 0b00001: value = src; break // AMOSWAP.W
      case 0b00000: value = old + src; break // AMOADD.W
      case 0b00100: value = old ^ src; break // AMOXOR.W
      case 0b01100: value = old & src; break // AMOAND.W
      case 0b01000: value = old | src; break // AMOOR.W
      case 0b10000: value = Math.min(old, src); break // AMOMIN.W
      case 0b10100: value = Math.max(old, src); break // AMOMAX.W
      case 0b11000: value = old >>> 0 < src >>> 0 ? old : src; break // AMOMINU.W
      case 0b11100: value = old >>> 0 > src >>> 0 ? old : src; break // AMOMAXU.W
      default: throw illegal(inst)
    }
    this.bus.write32(addr, value)
    this.x[rd] = old
  }
}

const ECALL = 0x00000073
const EBREAK = 0x00100073
const MRET = 0x30200073
const WFI = 0x10500073

const illegal = (inst: number) => new Trap(TrapCause.IllegalInstruction, inst)

/** Upper 32 bits of the unsigned 64-bit product, without BigInt. */
function mulhu(a: number, b: number): number {
  const al = a & 0xffff
  const ah = a >>> 16
  const bl = b & 0xffff
  const bh = b >>> 16
  const lh = al * bh
  const hl = ah * bl
  const mid = ((al * bl) >>> 16) + (lh & 0xffff) + (hl & 0xffff)
  return (ah * bh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) | 0
}

// Immediate decoders. All return sign-extended values.
const immI = (i: number) => i >> 20
const immS = (i: number) => ((i >> 25) << 5) | ((i >>> 7) & 0x1f)
const immB = (i: number) =>
  ((i >> 31) << 12) | (((i >>> 7) & 1) << 11) | (((i >>> 25) & 0x3f) << 5) | (((i >>> 8) & 0xf) << 1)
const immJ = (i: number) =>
  ((i >> 31) << 20) | (((i >>> 12) & 0xff) << 12) | (((i >>> 20) & 1) << 11) | (((i >>> 21) & 0x3ff) << 1)
