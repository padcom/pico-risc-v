import { type Bus, BusError } from './bus.js'
import {
  Csr,
  MIP_MEIP,
  MIP_MSIP,
  MIP_MTIP,
  MIP_SEIP,
  MIP_SSIP,
  MIP_STIP,
  MSTATUS_MIE,
  MSTATUS_MPIE,
  MSTATUS_MPP,
  MSTATUS_MPP_SHIFT,
  MSTATUS_MPRV,
  MSTATUS_MXR,
  MSTATUS_SIE,
  MSTATUS_SPIE,
  MSTATUS_SPP,
  MSTATUS_SUM,
  MSTATUS_TSR,
  MSTATUS_TVM,
  MSTATUS_TW,
  Priv,
  SATP_MODE_SV32,
  SATP_PPN,
} from './csr.js'
import { Access, Sv32Mmu } from './mmu.js'
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

/** misa: MXL=1 (32-bit), extensions A, I, M, S, U. */
const MISA = (1 << 30) | (1 << 0) | (1 << 8) | (1 << 12) | (1 << 18) | (1 << 20)

const MSTATUS_WRITABLE =
  MSTATUS_SIE | MSTATUS_MIE | MSTATUS_SPIE | MSTATUS_MPIE | MSTATUS_SPP | MSTATUS_MPP |
  MSTATUS_MPRV | MSTATUS_SUM | MSTATUS_MXR | MSTATUS_TVM | MSTATUS_TW | MSTATUS_TSR
/** The part of mstatus visible (and writable) as sstatus. */
const SSTATUS_MASK = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_SUM | MSTATUS_MXR
const MIE_WRITABLE = MIP_SSIP | MIP_MSIP | MIP_STIP | MIP_MTIP | MIP_SEIP | MIP_MEIP
/** mip bits software may write; the machine ones are driven by devices (CLINT). */
const MIP_WRITABLE = MIP_SSIP | MIP_STIP | MIP_SEIP
const MIDELEG_WRITABLE = MIP_SSIP | MIP_STIP | MIP_SEIP
/** Delegatable exceptions: all but ECALL from M-mode (11) and the reserved causes 10 and 14. */
const MEDELEG_WRITABLE = 0xb3ff
const COUNTEREN_WRITABLE = 0x7 // cycle, time, instret
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
 * RV32IMA hart with machine, supervisor and user privilege modes (Zicsr,
 * Zifencei) and Sv32 virtual memory.
 *
 * Registers are held in an Int32Array so JS bitwise ops (which work on signed
 * 32-bit ints) map directly onto them; x0 is re-zeroed after every write.
 * The PC is kept as an unsigned 32-bit number.
 *
 * Exceptions and interrupts are taken architecturally: into M-mode
 * (mepc/mcause/mtval, mtvec), or into S-mode when delegated through
 * medeleg/mideleg (sepc/scause/stval, stvec).
 */
export class CPU {
  readonly x = new Int32Array(32)
  pc: number
  priv: Priv = Priv.Machine

  // Machine-mode CSR state (sstatus, sie and sip are views of these)
  mstatus = 0
  mie = 0
  /** Pending interrupts. Machine bits are driven by devices via `setInterruptPending()`. */
  mip = 0
  mtvec = 0
  mscratch = 0
  mepc = 0
  mcause = 0
  mtval = 0
  medeleg = 0
  mideleg = 0
  mcounteren = COUNTEREN_WRITABLE

  // Supervisor-mode CSR state
  stvec = 0
  sscratch = 0
  sepc = 0
  scause = 0
  stval = 0
  satp = 0
  scounteren = COUNTEREN_WRITABLE

  /** Instructions retired (also serves as the cycle counter: 1 IPC). */
  instret = 0
  /** True while stalled in WFI. */
  waiting = false

  breakOnEbreak: boolean
  private readonly readTime?: () => number
  private readonly mmu: Sv32Mmu
  /** Whether fetches / loads and stores go through the MMU, and with which privilege. */
  private translateFetch = false
  private translateData = false
  private dataPriv: Priv = Priv.Machine
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
    this.mmu = new Sv32Mmu(bus)
  }

  /** Return to the power-on state and start executing at `pc`. */
  reset(pc: number): void {
    this.x.fill(0)
    this.pc = pc >>> 0
    this.priv = Priv.Machine
    this.mstatus = this.mie = this.mip = this.mtvec = this.mscratch = 0
    this.mepc = this.mcause = this.mtval = this.medeleg = this.mideleg = 0
    this.stvec = this.sscratch = this.sepc = this.scause = this.stval = this.satp = 0
    this.mcounteren = this.scounteren = COUNTEREN_WRITABLE
    this.instret = 0
    this.waiting = false
    this.reservation = -1
    this.mmu.flush()
    this.updateTranslation()
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
    if (pending !== 0 && this.takeInterrupt(pending)) return

    const pc = this.pc
    let inst: number
    try {
      inst = this.bus.read32(this.translateFetch ? this.translate(pc, Access.Fetch, this.priv) : pc) | 0
    } catch (e) {
      if (e instanceof Trap) this.enterTrap(e.cause, false, pc, e.tval)
      else if (e instanceof BusError) this.enterTrap(TrapCause.InstructionAccessFault, false, pc, pc)
      else throw e
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

  /**
   * Take the highest-priority pending interrupt that is enabled at the current
   * privilege: non-delegated ones trap to M-mode (enabled below M, or in M with
   * MIE), delegated ones to S-mode (enabled in U, or in S with SIE; never in M).
   */
  private takeInterrupt(pending: number): boolean {
    let candidates = 0
    const machine = pending & ~this.mideleg
    if (machine && (this.priv < Priv.Machine || this.mstatus & MSTATUS_MIE)) candidates = machine
    else {
      const supervisor = pending & this.mideleg
      if (
        supervisor &&
        (this.priv < Priv.Supervisor || (this.priv === Priv.Supervisor && this.mstatus & MSTATUS_SIE))
      ) {
        candidates = supervisor
      }
    }
    if (!candidates) return false
    for (const cause of INTERRUPT_PRIORITY) {
      if (candidates & (1 << cause)) {
        this.enterTrap(cause, true, this.pc, 0)
        return true
      }
    }
    return false
  }

  private enterTrap(cause: number, interrupt: boolean, epc: number, tval: number): void {
    const delegated = (interrupt ? this.mideleg : this.medeleg) & (1 << cause)
    const causeValue = (interrupt ? 0x8000_0000 | cause : cause) >>> 0
    if (this.priv <= Priv.Supervisor && delegated) {
      this.sepc = epc
      this.scause = causeValue
      this.stval = tval >>> 0
      const sie = this.mstatus & MSTATUS_SIE
      this.mstatus =
        (this.mstatus & ~(MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP)) |
        (sie ? MSTATUS_SPIE : 0) |
        (this.priv === Priv.Supervisor ? MSTATUS_SPP : 0)
      this.priv = Priv.Supervisor
      this.pc = vector(this.stvec, cause, interrupt)
    } else {
      this.mepc = epc
      this.mcause = causeValue
      this.mtval = tval >>> 0
      const mie = this.mstatus & MSTATUS_MIE
      this.mstatus =
        (this.mstatus & ~(MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP)) |
        (mie ? MSTATUS_MPIE : 0) |
        (this.priv << MSTATUS_MPP_SHIFT)
      this.priv = Priv.Machine
      this.pc = vector(this.mtvec, cause, interrupt)
    }
    this.reservation = -1
    this.updateTranslation()
  }

  /** Recompute which accesses need translating; call after any change to priv, mstatus or satp. */
  private updateTranslation(): void {
    const paging = (this.satp & SATP_MODE_SV32) !== 0
    this.dataPriv =
      this.priv === Priv.Machine && this.mstatus & MSTATUS_MPRV
        ? ((this.mstatus & MSTATUS_MPP) >>> MSTATUS_MPP_SHIFT) as Priv
        : this.priv
    this.translateFetch = paging && this.priv !== Priv.Machine
    this.translateData = paging && this.dataPriv !== Priv.Machine
  }

  private translate(vaddr: number, access: Access, priv: Priv): number {
    return this.mmu.translate(
      vaddr,
      access,
      priv,
      (this.mstatus & MSTATUS_SUM) !== 0,
      (this.mstatus & MSTATUS_MXR) !== 0,
      this.satp & SATP_PPN,
    )
  }

  // Data accesses. An access that straddles a page boundary is split into
  // bytes, each translated on its own (both pages must be accessible).

  private load8(addr: number): number {
    return this.bus.read8(this.translateData ? this.translate(addr, Access.Load, this.dataPriv) : addr)
  }

  private load16(addr: number): number {
    if (!this.translateData) return this.bus.read16(addr)
    if ((addr & 0xfff) > 0xffe) return this.load8(addr) | (this.load8((addr + 1) >>> 0) << 8)
    return this.bus.read16(this.translate(addr, Access.Load, this.dataPriv))
  }

  private load32(addr: number): number {
    if (!this.translateData) return this.bus.read32(addr)
    if ((addr & 0xfff) > 0xffc) return this.load16(addr) | (this.load16((addr + 2) >>> 0) << 16)
    return this.bus.read32(this.translate(addr, Access.Load, this.dataPriv))
  }

  private store8(addr: number, value: number): void {
    this.bus.write8(this.translateData ? this.translate(addr, Access.Store, this.dataPriv) : addr, value)
  }

  private store16(addr: number, value: number): void {
    if (!this.translateData) return this.bus.write16(addr, value)
    if ((addr & 0xfff) > 0xffe) {
      // Check both pages before writing either, so a fault leaves memory untouched.
      this.translate((addr + 1) >>> 0, Access.Store, this.dataPriv)
      this.store8(addr, value)
      this.store8((addr + 1) >>> 0, value >>> 8)
      return
    }
    this.bus.write16(this.translate(addr, Access.Store, this.dataPriv), value)
  }

  private store32(addr: number, value: number): void {
    if (!this.translateData) return this.bus.write32(addr, value)
    if ((addr & 0xfff) > 0xffc) {
      this.translate(((addr + 3) & ~0xfff) >>> 0, Access.Store, this.dataPriv) // the second page
      this.store16(addr, value)
      this.store16((addr + 2) >>> 0, value >>> 16)
      return
    }
    this.bus.write32(this.translate(addr, Access.Store, this.dataPriv), value)
  }

  private execute(inst: number, pc: number): void {
    const opcode = inst & 0x7f
    const rd = (inst >>> 7) & 0x1f
    const funct3 = (inst >>> 12) & 0x7
    const rs1 = (inst >>> 15) & 0x1f
    const rs2 = (inst >>> 20) & 0x1f
    const funct7 = inst >>> 25

    const x = this.x
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
          case 0b000: value = (this.load8(addr) << 24) >> 24; break // LB
          case 0b001: value = (this.load16(addr) << 16) >> 16; break // LH
          case 0b010: value = this.load32(addr) | 0; break // LW
          case 0b100: value = this.load8(addr); break // LBU
          case 0b101: value = this.load16(addr); break // LHU
          default: throw illegal(inst)
        }
        x[rd] = value
        break
      }

      case Opcode.STORE: {
        const addr = (x[rs1]! + immS(inst)) >>> 0
        const value = x[rs2]!
        switch (funct3) {
          case 0b000: this.store8(addr, value); break // SB
          case 0b001: this.store16(addr, value); break // SH
          case 0b010: this.store32(addr, value); break // SW
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
          nextPc = this.system(inst, pc, nextPc)
          if (nextPc < 0) return // breakpoint: leave pc on the EBREAK
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

  /**
   * ECALL / EBREAK / MRET / SRET / WFI / SFENCE.VMA. Returns the next pc, or
   * -1 if execution should stop at a breakpoint.
   */
  private system(inst: number, pc: number, nextPc: number): number {
    if ((inst & 0xfe007fff) === SFENCE_VMA) {
      if (this.priv === Priv.User || (this.priv === Priv.Supervisor && this.mstatus & MSTATUS_TVM)) {
        throw illegal(inst)
      }
      this.mmu.flush() // no ASIDs, so flush everything regardless of rs1/rs2
      return nextPc
    }

    switch (inst) {
      case ECALL:
        throw new Trap(ECALL_CAUSE[this.priv]!)
      case EBREAK:
        if (this.breakOnEbreak) {
          this.stop('breakpoint')
          return -1
        }
        throw new Trap(TrapCause.Breakpoint, pc)
      case MRET: {
        if (this.priv !== Priv.Machine) throw illegal(inst)
        const mpp = ((this.mstatus & MSTATUS_MPP) >>> MSTATUS_MPP_SHIFT) as Priv
        this.mstatus =
          (this.mstatus & ~(MSTATUS_MIE | MSTATUS_MPP | (mpp !== Priv.Machine ? MSTATUS_MPRV : 0))) |
          MSTATUS_MPIE |
          (this.mstatus & MSTATUS_MPIE ? MSTATUS_MIE : 0)
        this.priv = mpp
        this.updateTranslation()
        return this.mepc
      }
      case SRET: {
        if (this.priv === Priv.User || (this.priv === Priv.Supervisor && this.mstatus & MSTATUS_TSR)) {
          throw illegal(inst)
        }
        const spp = this.mstatus & MSTATUS_SPP ? Priv.Supervisor : Priv.User
        this.mstatus =
          (this.mstatus & ~(MSTATUS_SIE | MSTATUS_SPP | MSTATUS_MPRV)) |
          MSTATUS_SPIE |
          (this.mstatus & MSTATUS_SPIE ? MSTATUS_SIE : 0)
        this.priv = spp
        this.updateTranslation()
        return this.sepc
      }
      case WFI:
        if (this.priv < Priv.Machine && this.mstatus & MSTATUS_TW) throw illegal(inst)
        // Resumes once an interrupt is pending and enabled in mie, even if
        // it is globally disabled (then execution simply continues past WFI).
        if ((this.mip & this.mie) === 0) this.waiting = true
        return nextPc
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
      case Csr.medeleg: return this.medeleg
      case Csr.mideleg: return this.mideleg
      case Csr.mie: return this.mie
      case Csr.mtvec: return this.mtvec
      case Csr.mcounteren: return this.mcounteren
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

      case Csr.sstatus: return this.mstatus & SSTATUS_MASK
      case Csr.sie: return this.mie & this.mideleg
      case Csr.sip: return this.mip & this.mideleg
      case Csr.stvec: return this.stvec
      case Csr.scounteren: return this.scounteren
      case Csr.sscratch: return this.sscratch
      case Csr.sepc: return this.sepc
      case Csr.scause: return this.scause
      case Csr.stval: return this.stval
      case Csr.satp:
        if (this.priv === Priv.Supervisor && this.mstatus & MSTATUS_TVM) throw illegal(inst)
        return this.satp

      case Csr.mcycle:
      case Csr.minstret:
        return this.instret % TWO_32 | 0
      case Csr.mcycleh:
      case Csr.minstreth:
        return (this.instret / TWO_32) | 0
      case Csr.cycle:
      case Csr.instret:
      case Csr.cycleh:
      case Csr.instreth:
        this.checkCounterAccess(csr, inst)
        return csr & 0x80 ? (this.instret / TWO_32) | 0 : this.instret % TWO_32 | 0
      case Csr.time:
      case Csr.timeh:
        if (!this.readTime) throw illegal(inst)
        this.checkCounterAccess(csr, inst)
        return csr === Csr.time ? this.readTime() % TWO_32 | 0 : (this.readTime() / TWO_32) | 0
    }
    if (csr >= Csr.pmpcfg0 && csr <= Csr.pmpaddr63) return 0 // no PMP entries
    throw illegal(inst)
  }

  /** User counters are readable below M-mode only if enabled in mcounteren (and scounteren for U). */
  private checkCounterAccess(csr: number, inst: number): void {
    const bit = 1 << (csr & 0x1f)
    if (this.priv < Priv.Machine && !(this.mcounteren & bit)) throw illegal(inst)
    if (this.priv === Priv.User && !(this.scounteren & bit)) throw illegal(inst)
  }

  private writeCsr(csr: number, value: number): void {
    switch (csr) {
      case Csr.mstatus: {
        let v = value & MSTATUS_WRITABLE
        if ((v & MSTATUS_MPP) === 2 << MSTATUS_MPP_SHIFT) v &= ~MSTATUS_MPP // no H-mode: 2 → U
        this.mstatus = v
        this.updateTranslation()
        break
      }
      case Csr.medeleg: this.medeleg = value & MEDELEG_WRITABLE; break
      case Csr.mideleg: this.mideleg = value & MIDELEG_WRITABLE; break
      case Csr.mie: this.mie = value & MIE_WRITABLE; break
      case Csr.mip: this.mip = (this.mip & ~MIP_WRITABLE) | (value & MIP_WRITABLE); break
      case Csr.mtvec: this.mtvec = tvec(value); break
      case Csr.mcounteren: this.mcounteren = value & COUNTEREN_WRITABLE; break
      case Csr.mscratch: this.mscratch = value; break
      case Csr.mepc: this.mepc = (value & ~3) >>> 0; break
      case Csr.mcause: this.mcause = value >>> 0; break
      case Csr.mtval: this.mtval = value >>> 0; break

      case Csr.sstatus:
        this.mstatus = (this.mstatus & ~SSTATUS_MASK) | (value & SSTATUS_MASK)
        this.updateTranslation()
        break
      case Csr.sie: this.mie = (this.mie & ~this.mideleg) | (value & this.mideleg); break
      case Csr.sip: {
        const writable = MIP_SSIP & this.mideleg
        this.mip = (this.mip & ~writable) | (value & writable)
        break
      }
      case Csr.stvec: this.stvec = tvec(value); break
      case Csr.scounteren: this.scounteren = value & COUNTEREN_WRITABLE; break
      case Csr.sscratch: this.sscratch = value; break
      case Csr.sepc: this.sepc = (value & ~3) >>> 0; break
      case Csr.scause: this.scause = value >>> 0; break
      case Csr.stval: this.stval = value >>> 0; break
      case Csr.satp:
        // Sv32 or bare; no ASIDs (ASIDLEN = 0, so those bits read as zero).
        this.satp = (value & (SATP_MODE_SV32 | SATP_PPN)) >>> 0
        this.mmu.flush()
        this.updateTranslation()
        break
      // Everything else that reads successfully is WARL read-only here:
      // counters can't be rewritten, no PMP.
    }
  }

  private amo(inst: number, rd: number, vaddr: number, src: number): void {
    const op = inst >>> 27
    const lr = op === 0b00010
    if (vaddr & 3) throw new Trap(lr ? TrapCause.LoadAddressMisaligned : TrapCause.StoreAddressMisaligned, vaddr)
    const addr = this.translateData
      ? this.translate(vaddr, lr ? Access.Load : Access.Store, this.dataPriv)
      : vaddr

    if (lr) {
      this.x[rd] = this.bus.read32(addr) | 0
      this.reservation = addr
      return
    }
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
const SRET = 0x10200073
const WFI = 0x10500073
const SFENCE_VMA = 0x12000073 // funct7 0001001, rs2/rs1 vary

const ECALL_CAUSE = [
  TrapCause.EnvironmentCallFromUMode,
  TrapCause.EnvironmentCallFromSMode,
  undefined,
  TrapCause.EnvironmentCallFromMMode,
]

/** Interrupt priority (highest first), per the privileged spec. */
const INTERRUPT_PRIORITY = [
  InterruptCause.MachineExternal,
  InterruptCause.MachineSoftware,
  InterruptCause.MachineTimer,
  InterruptCause.SupervisorExternal,
  InterruptCause.SupervisorSoftware,
  InterruptCause.SupervisorTimer,
]

const illegal = (inst: number) => new Trap(TrapCause.IllegalInstruction, inst)

/** xtvec is direct (mode 0) or vectored (mode 1). */
const tvec = (value: number) => (value & 3 ? (value & ~3) | 1 : value) >>> 0

/** Trap target: vectored mode sends interrupts to base + 4 × cause. */
const vector = (tvecValue: number, cause: number, interrupt: boolean) => {
  const base = tvecValue & ~3
  return (interrupt && (tvecValue & 3) === 1 ? base + 4 * cause : base) >>> 0
}

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
