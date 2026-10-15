/*
 * Hello, world, with a conversation: asks for your name (through the UART),
 * answers, and exits with the name's length (run()'s exitCode).
 */
#include "pico.h"

int main(void) {
    pico_puts("Hello from RISC-V! What's your name? ");
    char name[64];
    int length = pico_gets(name, sizeof name);
    pico_puts("Nice to meet you, ");
    pico_puts(length ? name : "stranger");
    pico_puts("! Your name has ");
    pico_putu(length);
    pico_puts(" letters: that's my exit code.\n");
    return length;
}
