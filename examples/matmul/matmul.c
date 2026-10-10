#include "../terminal.h"

#define N 3

/*
 * Non-static, writable globals: GCC can't assume their contents, so the
 * product is genuinely computed at run time by the emulated CPU.
 */
int a[N][N] = {
    { 1, 2, 3 },
    { 4, 5, 6 },
    { 7, 8, 9 },
};

int b[N][N] = {
    {  9, -8,  7 },
    { -6,  5, -4 },
    {  3, -2,  1 },
};

int c[N][N];

__attribute__((noinline))
void matmul(int r[N][N], const int x[N][N], const int y[N][N]) {
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++) {
            int sum = 0;
            for (int k = 0; k < N; k++)
                sum += x[i][k] * y[k][j];
            r[i][j] = sum;
        }
}

static void print_matrix(const char *name, const int m[N][N]) {
    term_puts(name);
    term_puts(" =\n");
    for (int i = 0; i < N; i++) {
        for (int j = 0; j < N; j++) {
            if (j)
                term_putc(' ');
            term_putint(m[i][j]);
        }
        term_putc('\n');
    }
}

int main(void) {
    matmul(c, a, b);
    print_matrix("A", a);
    print_matrix("B", b);
    print_matrix("A x B", c);
    return 0;
}
