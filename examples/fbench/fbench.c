#include "../terminal.h"

/*
 * Floating-point test program: single and double precision arithmetic,
 * square roots and conversions, in a few small computations. It prints the
 * exact bits of the results, so builds for different CPUs must print the
 * same (IEEE 754 makes +, -, *, /, sqrt and conversions exact functions of
 * their inputs; built with -ffp-contract=off, so no fused multiply-adds, and
 * no libm).
 */

typedef unsigned long long u64;

static void put_hex(u64 v, int digits) {
    for (int shift = (digits - 1) * 4; shift >= 0; shift -= 4)
        term_putc("0123456789abcdef"[(v >> shift) & 15]);
}

static void put_double(const char *name, double d) {
    union { double d; u64 u; } bits = { d };
    term_puts(name);
    term_putc(' ');
    put_hex(bits.u, 16);
    term_putc('\n');
}

static void put_float(const char *name, float f) {
    union { float f; unsigned u; } bits = { f };
    term_puts(name);
    term_putc(' ');
    put_hex(bits.u, 8);
    term_putc('\n');
}

/* Globals keep the compiler from computing it all at compile time. */
volatile double scale = 1.0;
volatile int steps = 200;

/* Mandelbrot set: iterations summed over a grid. */
__attribute__((noinline))
static double mandelbrot(void) {
    double total = 0;
    for (int py = 0; py < 40; py++)
        for (int px = 0; px < 60; px++) {
            double x0 = (px / 60.0 * 3.5 - 2.5) * scale, y0 = (py / 40.0 * 2.0 - 1.0) * scale;
            double x = 0, y = 0;
            int i = 0;
            while (x * x + y * y < 4.0 && i < 100) {
                double t = x * x - y * y + x0;
                y = 2 * x * y + y0;
                x = t;
                i++;
            }
            total += i + x * 1e-3;
        }
    return total;
}

/* Three bodies attracting each other; returns the total energy. */
__attribute__((noinline))
static double nbody(void) {
    double px[3] = { 0, 1, -1 }, py[3] = { 0, 0.1, -0.2 };
    double vx[3] = { 0, 0, 0.1 }, vy[3] = { 0, 1, -1 }, m[3] = { 10, 0.1, 0.2 };
    double dt = 0.001;
    for (int s = 0; s < steps; s++) {
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++) {
                if (i == j)
                    continue;
                double dx = px[j] - px[i], dy = py[j] - py[i];
                double d2 = dx * dx + dy * dy + 0.01;
                double d = __builtin_sqrt(d2);
                double f = m[j] / (d2 * d);
                vx[i] += dx * f * dt;
                vy[i] += dy * f * dt;
            }
        for (int i = 0; i < 3; i++) {
            px[i] += vx[i] * dt;
            py[i] += vy[i] * dt;
        }
    }
    double e = 0;
    for (int i = 0; i < 3; i++)
        e += 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i]);
    return e;
}

/* Single precision: a series, square roots, and conversions both ways. */
__attribute__((noinline))
static float singles(void) {
    float sum = 0;
    for (int k = 1; k <= 1000; k++)
        sum += 1.0f / ((float)k * (float)k);
    float roots = 0;
    for (int k = 1; k <= 1000; k++)
        roots += __builtin_sqrtf((float)k) / (float)(steps);
    return sum * 6.0f + roots + (float)(double)sum;
}

__attribute__((noinline))
static long long conversions(void) {
    long long acc = 0;
    for (int k = -500; k <= 500; k++) {
        double d = k * 1.37 * scale;
        acc = acc * 3 + (int)d + (int)(d * 1e6) + (unsigned)(d > 0 ? d : -d);
        acc ^= (int)(float)d;
    }
    return acc;
}

int main(void) {
    put_double("mandelbrot", mandelbrot());
    put_double("nbody", nbody());
    put_float("singles", singles());
    put_hex((u64)conversions(), 16);
    term_putc('\n');
    return 0;
}
