/**
 * What a computer's UART is connected to, on the host's side: where the bytes
 * the program writes go, and, optionally, where what it reads comes from.
 *
 *   - consoleUart(): the host's console (the default)
 *   - captureUart(): kept, and passed on as they're written
 *   - both(): to several at once
 *
 * Or anything that implements Uart.
 */
export interface Uart {
  /** A byte the program wrote. */
  write(byte: number): void
  /**
   * Called once, when the computer starts, with the function that sends the
   * program input (it reads it from the UART), for a UART that has some.
   */
  attach?(send: (data: string | ArrayLike<number>) => void): void
  /** The program has stopped: flush what's buffered, let go of what was attached. */
  close?(): void
}

/** Bytes to text, as UTF-8 that may arrive a byte at a time. */
function decoder(): (byte: number) => string {
  const utf8 = new TextDecoder()
  const one = new Uint8Array(1)
  return byte => {
    one[0] = byte
    return utf8.decode(one, { stream: true })
  }
}

/** Node.js's process, where there is one (not in a browser). */
const node = (globalThis as { process?: NodeJS.Process }).process?.stdout ? (globalThis as { process: NodeJS.Process }).process : undefined

export interface ConsoleUartOptions {
  /**
   * Also read the program's input from the console (Node.js: standard input,
   * in raw mode if it's a terminal, so every key goes through as typed;
   * Ctrl-C still stops Node.js). Default false: output only.
   */
  input?: boolean
}

/**
 * The host's console: in Node.js, standard output (and, with `input`,
 * standard input); in a browser, console.log(), a line at a time.
 */
export function consoleUart({ input = false }: ConsoleUartOptions = {}): Uart {
  if (!node) {
    const text = decoder()
    let line = ''
    return {
      write: byte => {
        const piece = text(byte)
        if (piece === '\n') {
          console.log(line)
          line = ''
        } else line += piece
      },
      close: () => {
        if (line) console.log(line)
        line = ''
      },
    }
  }
  // Written in batches: once per turn of the event loop, not per byte.
  let pending: number[] = []
  const flush = () => {
    if (pending.length) node.stdout.write(Uint8Array.from(pending))
    pending = []
  }
  let detach = () => {}
  return {
    write: byte => {
      if (pending.push(byte) === 1) setTimeout(flush, 0)
    },
    attach: send => {
      if (!input) return
      const stdin = node.stdin
      const raw = stdin.isTTY && !stdin.isRaw
      if (raw) stdin.setRawMode(true)
      const data = (chunk: Buffer) => {
        if (raw && chunk.includes(3)) node.kill(node.pid, 'SIGINT') // (Ctrl-C)
        send(chunk)
      }
      stdin.on('data', data).resume()
      detach = () => {
        stdin.off('data', data).pause()
        if (raw) stdin.setRawMode(false)
      }
    },
    close: () => {
      flush()
      detach()
    },
  }
}

/** A UART whose output is kept: captureUart(). */
export interface CapturedUart extends Uart {
  /** All the program has written so far, as text (UTF-8). */
  readonly text: string
  /** ...and as bytes. */
  readonly bytes: Uint8Array
  /** Send the program input (once it has started), as typed. */
  send(data: string | ArrayLike<number>): void
}

export interface CaptureUartOptions {
  /** Called with the text as the program writes it (a character at a time). */
  onText?: (text: string) => void
  /** Called with every byte as the program writes it. */
  onByte?: (byte: number) => void
  /** Input for the program, there when it starts reading. */
  input?: string | ArrayLike<number>
}

/**
 * Keeps what the program writes (`text`, `bytes`) and passes it on as it's
 * written (`onText`, `onByte`); `send()` is input for the program, whenever.
 */
export function captureUart({ onText, onByte, input }: CaptureUartOptions = {}): CapturedUart {
  const text = decoder()
  const bytes: number[] = []
  let written = ''
  let send: ((data: string | ArrayLike<number>) => void) | undefined
  const early: (string | ArrayLike<number>)[] = input === undefined ? [] : [input]
  return {
    write: byte => {
      bytes.push(byte)
      onByte?.(byte)
      const piece = text(byte)
      if (piece) {
        written += piece
        onText?.(piece)
      }
    },
    attach: to => {
      send = to
      for (const data of early.splice(0)) to(data)
    },
    send: data => (send ? send(data) : void early.push(data)),
    get text() {
      return written
    },
    get bytes() {
      return Uint8Array.from(bytes)
    },
  }
}

/** One UART that's several: the output goes to each, the input comes from any. */
export function both(...uarts: Uart[]): Uart {
  return {
    write: byte => uarts.forEach(uart => uart.write(byte)),
    attach: send => uarts.forEach(uart => uart.attach?.(send)),
    close: () => uarts.forEach(uart => uart.close?.()),
  }
}
