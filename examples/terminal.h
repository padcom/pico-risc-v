#ifndef TERMINAL_H
#define TERMINAL_H

/* Terminal device (16550-style UART) — see src/terminal.ts. */
#define TERMINAL_BASE 0x10000000UL

#define TERMINAL_REG(off) (*(volatile unsigned char *)(TERMINAL_BASE + (off)))
#define TERMINAL_THR TERMINAL_REG(0) /* write: transmit */
#define TERMINAL_RBR TERMINAL_REG(0) /* read: receive */
#define TERMINAL_LSR TERMINAL_REG(5) /* line status */

#define LSR_DR   0x01 /* data ready */
#define LSR_THRE 0x20 /* transmitter ready */

static inline void term_putc(char c) {
    while (!(TERMINAL_LSR & LSR_THRE))
        ;
    TERMINAL_THR = (unsigned char)c;
}

static inline void term_puts(const char *s) {
    while (*s)
        term_putc(*s++);
}

static inline void term_putuint(unsigned int n) {
    char buf[10];
    int i = 0;
    do {
        buf[i++] = (char)('0' + n % 10);
        n /= 10;
    } while (n);
    while (i)
        term_putc(buf[--i]);
}

static inline void term_putint(int n) {
    if (n < 0) {
        term_putc('-');
        term_putuint(-(unsigned int)n);
    } else {
        term_putuint((unsigned int)n);
    }
}

static inline int term_getc(void) {
    while (!(TERMINAL_LSR & LSR_DR))
        ;
    return TERMINAL_RBR;
}

#endif
