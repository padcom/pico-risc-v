import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'
import type { BlockStorage } from './block-storage.js'

/**
 * A disk backed by a raw image file on the host (Node.js only). Reads and
 * writes go straight to the file at the same offsets, like `qemu -drive
 * file=...,format=raw`; holes in a sparse file read as zeros.
 */
export class FileStorage implements BlockStorage {
  readonly size: number
  readonly readOnly: boolean
  private fd: number | undefined

  constructor(
    readonly path: string,
    { readOnly = false } = {},
  ) {
    this.readOnly = readOnly
    this.fd = openSync(path, readOnly ? 'r' : 'r+')
    this.size = fstatSync(this.fd).size
  }

  read(offset: number, dest: Uint8Array): void {
    let done = 0
    while (done < dest.length) {
      const n = readSync(this.handle(), dest, done, dest.length - done, offset + done)
      if (n === 0) {
        dest.fill(0, done) // past the end: zeros
        return
      }
      done += n
    }
  }

  write(offset: number, src: Uint8Array): void {
    if (this.readOnly) throw new Error(`${this.path} is read-only`)
    let done = 0
    while (done < src.length) done += writeSync(this.handle(), src, done, src.length - done, offset + done)
  }

  flush(): void {
    if (!this.readOnly) fsyncSync(this.handle())
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd)
    this.fd = undefined
  }

  private handle(): number {
    if (this.fd === undefined) throw new Error(`${this.path} is closed`)
    return this.fd
  }
}
