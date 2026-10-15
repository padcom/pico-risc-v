/*
 * C programs on @padcom/pico-risc-v-hart's computer: its UART (a 16550, at
 * 0x10000000) and exit. With crt0.S and pico.ld:
 *
 *   riscv64-elf-gcc -march=rv64imac -mabi=lp64 -mcmodel=medany -O2 \
 *     -ffreestanding -nostdlib -nostartfiles -I <this dir> -T <this dir>/pico.ld \
 *     <this dir>/crt0.S program.c -o program.elf
 */
#ifndef PICO_H
#define PICO_H

#define PICO_UART 0x10000000UL
#define PICO_UART_REG(offset) (*(volatile unsigned char *)(PICO_UART + (offset)))
#define PICO_UART_DATA PICO_UART_REG(0)     /* write: send; read: receive */
#define PICO_UART_STATUS PICO_UART_REG(5)   /* line status */
#define PICO_UART_READY 0x01                /* a byte to read */
#define PICO_UART_EMPTY 0x20                /* room to send one */

/* End the program: run()'s exitCode (0 to 255). main()'s return does it too. */
void pico_exit(int code) __attribute__((noreturn));

/* Write a character, a string. */
static inline void pico_putc(char c) {
    while (!(PICO_UART_STATUS & PICO_UART_EMPTY))
        ;
    PICO_UART_DATA = (unsigned char)c;
}

static inline void pico_puts(const char *s) {
    while (*s)
        pico_putc(*s++);
}

/* Whether a character is there to read. */
static inline int pico_ready(void) {
    return PICO_UART_STATUS & PICO_UART_READY;
}

/* Read a character (waits for one). */
static inline char pico_getc(void) {
    while (!pico_ready())
        ;
    return (char)PICO_UART_DATA;
}

/*
 * Read a line (up to Enter, which isn't kept) into buf, at most size - 1
 * characters, echoing them as a terminal would (Backspace works); returns
 * its length.
 */
static inline int pico_gets(char *buf, int size) {
    int n = 0;
    for (;;) {
        char c = pico_getc();
        if (c == '\r' || c == '\n') {
            pico_puts("\r\n");
            break;
        }
        if ((c == '\b' || c == 0x7f) && n > 0) {
            n--;
            pico_puts("\b \b");
        } else if (c >= ' ' && n < size - 1) {
            buf[n++] = c;
            pico_putc(c);
        }
    }
    buf[n] = 0;
    return n;
}

/* Write a number, in decimal. */
static inline void pico_putu(unsigned long n) {
    char digits[20];
    int i = 0;
    do {
        digits[i++] = (char)('0' + n % 10);
        n /= 10;
    } while (n);
    while (i)
        pico_putc(digits[--i]);
}

#endif
