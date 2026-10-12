/*
 * HARTS harts update shared counters at the same time, each ROUNDS times:
 * with AMOADD, with an LR/SC loop, and as a plain variable under a spinlock
 * (LR/SC, with acquire / release ordering). If the atomics are atomic across
 * harts, and the lock orders the plain accesses, each ends at HARTS × ROUNDS.
 * Hart 0 prints them, and which harts took part, once all are done.
 *
 * Needs a machine with HARTS harts (and no more: it waits for them all).
 */
#include "../terminal.h"

#define HARTS  4
#define ROUNDS 20000

static volatile unsigned long amo_counter;
static volatile unsigned long lrsc_counter;
static volatile unsigned long locked_counter;
static volatile int lock;
static volatile int done;
static volatile int seen[HARTS];

static void acquire(volatile int *l) {
    int busy;
    do {
        __asm__ volatile(
            "1: lr.w.aq %0, (%1)\n"
            "   bnez    %0, 1b\n"
            "   sc.w    %0, %2, (%1)\n"
            : "=&r"(busy)
            : "r"(l), "r"(1)
            : "memory");
    } while (busy);
}

static void release(volatile int *l) {
    __atomic_store_n(l, 0, __ATOMIC_RELEASE);
}

static void lrsc_increment(volatile unsigned long *p) {
    unsigned long value;
    int failed;
    do {
        __asm__ volatile(
            "lr.d    %0, (%2)\n"
            "addi    %0, %0, 1\n"
            "sc.d    %1, %0, (%2)\n"
            : "=&r"(value), "=&r"(failed)
            : "r"(p)
            : "memory");
    } while (failed);
}

static void work(long hart) {
    seen[hart] = 1;
    for (int i = 0; i < ROUNDS; i++) {
        __atomic_fetch_add(&amo_counter, 1, __ATOMIC_RELAXED);
        lrsc_increment(&lrsc_counter);
        acquire(&lock);
        locked_counter = locked_counter + 1;
        release(&lock);
    }
}

void hart_main(long hart) {
    work(hart);
    __atomic_fetch_add(&done, 1, __ATOMIC_RELEASE);
}

static void print(const char *name, unsigned long value) {
    term_puts(name);
    term_putuint((unsigned int)value);
    term_putc('\n');
}

int main(void) {
    work(0);
    while (__atomic_load_n(&done, __ATOMIC_ACQUIRE) != HARTS - 1)
        ;
    int harts = 0;
    for (int i = 0; i < HARTS; i++)
        harts += seen[i];
    print("harts ", harts);
    print("amoadd ", amo_counter);
    print("lr/sc ", lrsc_counter);
    print("locked ", locked_counter);
    return 0;
}
